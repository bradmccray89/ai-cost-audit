import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CostComposition, ModelUsage, Stats, UsageProfile } from "./types.js";
import { PROVIDERS, resolveRate, type PricingTable } from "./pricing.js";

/** The tool whose local transcripts this module reads. */
const TOOL_LABEL = "Claude Code";

interface CostParts {
  cacheRead: number;
  cacheWrite: number;
  freshInput: number;
  output: number;
}

/**
 * Measured usage read from local Claude Code transcripts
 * (~/.claude/projects/<encoded-cwd>/*.jsonl). These are the ground truth for a
 * specific repo + user: actual per-API-call token usage, cache behavior, output,
 * and cost. No network, no API key — the files are already on disk.
 */

interface CallUsage {
  input: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cacheRead: number;
  output: number;
  model: string;
  sidechain: boolean;
}

interface Turn {
  calls: number;
  output: number;
}

export function defaultProjectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** Claude Code encodes the project cwd into the transcript dir name. */
export function encodeProjectDir(projectPath: string): string {
  return path.resolve(projectPath).replace(/[/\\:.]/g, "-");
}

/**
 * Find the transcript directory for a project. Tries the encoded name first,
 * then falls back to matching the `cwd` field recorded inside each dir's files
 * (robust to encoding differences across Claude Code versions).
 */
export function locateTranscriptDir(projectPath: string, projectsRoot: string): string | null {
  if (!existsSync(projectsRoot)) return null;
  const resolved = path.resolve(projectPath);

  const direct = path.join(projectsRoot, encodeProjectDir(resolved));
  if (existsSync(direct) && dirMatchesCwd(direct, resolved) !== false) return direct;

  for (const entry of readdirSync(projectsRoot)) {
    const dir = path.join(projectsRoot, entry);
    if (!statSync(dir).isDirectory()) continue;
    if (dirMatchesCwd(dir, resolved) === true) return dir;
  }
  return null;
}

/** true = cwd matches, false = mismatch, null = unknown (no readable cwd). */
function dirMatchesCwd(dir: string, resolved: string): boolean | null {
  for (const file of jsonlFiles(dir)) {
    for (const line of readLines(file)) {
      const cwd = line.cwd as string | undefined;
      if (typeof cwd === "string") return path.resolve(cwd) === resolved;
    }
  }
  return null;
}

function jsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f));
}

function readLines(file: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    try {
      out.push(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      // Skip malformed lines; a partial transcript is still useful.
    }
  }
  return out;
}

function extractUsage(event: Record<string, unknown>): CallUsage | null {
  if (event.type !== "assistant") return null;
  const message = event.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!usage) return null;
  const creation = usage.cache_creation as Record<string, unknown> | undefined;
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    input: n(usage.input_tokens),
    cacheCreate5m: n(creation?.ephemeral_5m_input_tokens),
    cacheCreate1h: n(creation?.ephemeral_1h_input_tokens),
    cacheRead: n(usage.cache_read_input_tokens),
    output: n(usage.output_tokens),
    model: typeof message?.model === "string" ? (message.model as string) : "unknown",
    sidechain: event.isSidechain === true,
  };
}

/** A user event begins a new human turn unless it is a tool-result message. */
function isHumanTurn(event: Record<string, unknown>): boolean {
  if (event.type !== "user" || event.isSidechain === true) return false;
  const message = event.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) {
    return !content.some((b) => (b as Record<string, unknown>)?.type === "tool_result");
  }
  return false;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function stats(values: number[]): Stats {
  if (values.length === 0) return { min: 0, median: 0, max: 0 };
  return { min: Math.min(...values), median: median(values), max: Math.max(...values) };
}

const CACHE = PROVIDERS.anthropic!.cache!;

/** Actual USD for one call, decomposed by token type (Anthropic cache economics). */
function callCostParts(call: CallUsage, table: PricingTable, date: Date): CostParts | null {
  const model = table.models.find((m) => m.id === call.model);
  const rate = model ? resolveRate(model, date) : null;
  if (!rate) return null;
  const inRate = rate.inputPerMTok / 1_000_000;
  const outRate = (rate.outputPerMTok ?? 0) / 1_000_000;
  return {
    freshInput: call.input * inRate,
    cacheWrite: call.cacheCreate5m * inRate * CACHE.write["5m"] + call.cacheCreate1h * inRate * CACHE.write["1h"],
    cacheRead: call.cacheRead * inRate * CACHE.read,
    output: call.output * outRate,
  };
}

function partsTotal(p: CostParts): number {
  return p.cacheRead + p.cacheWrite + p.freshInput + p.output;
}

/**
 * Measure usage for a project from its local transcripts. Returns null when no
 * transcripts exist for the project.
 */
export function measureUsage(
  projectPath: string,
  table: PricingTable,
  opts: { projectsRoot?: string } = {},
): UsageProfile | null {
  const root = opts.projectsRoot ?? defaultProjectsRoot();
  const dir = locateTranscriptDir(projectPath, root);
  if (!dir) return null;

  const files = jsonlFiles(dir);
  if (files.length === 0) return null;

  const turns: Turn[] = [];
  const models = new Set<string>();
  const days = new Set<string>();
  const perModel = new Map<string, ModelUsage>();
  const composition: CostComposition = { cacheRead: 0, cacheWrite: 0, freshInput: 0, output: 0 };
  let apiCalls = 0;
  let cacheReadSum = 0;
  let cacheInputSum = 0; // read + creation + fresh input, the denominator for read rate
  let create5m = 0;
  let create1h = 0;
  let contextSum = 0; // cache_read + cache_creation per call
  let cost = 0;
  let unpricedCalls = 0;
  let firstAt = "";
  let lastAt = "";

  const modelBucket = (id: string): ModelUsage => {
    let b = perModel.get(id);
    if (!b) {
      b = { model: id, calls: 0, outputTokens: 0, contextTokens: 0, costUSD: 0, share: 0 };
      perModel.set(id, b);
    }
    return b;
  };

  for (const file of files) {
    let current: Turn | null = null;
    for (const event of readLines(file)) {
      const ts = typeof event.timestamp === "string" ? event.timestamp : "";
      if (ts) {
        if (!firstAt || ts < firstAt) firstAt = ts;
        if (!lastAt || ts > lastAt) lastAt = ts;
        days.add(ts.slice(0, 10));
      }

      if (isHumanTurn(event)) {
        current = { calls: 0, output: 0 };
        turns.push(current);
        continue;
      }

      const call = extractUsage(event);
      if (!call) continue;
      models.add(call.model);

      // Cost counts every call actually billed, including sidechains.
      const parts = callCostParts(call, table, ts ? new Date(ts) : new Date());
      const bucket = modelBucket(call.model);
      bucket.calls++;
      bucket.outputTokens += call.output;
      bucket.contextTokens += call.cacheRead + call.cacheCreate5m + call.cacheCreate1h;
      if (parts === null) {
        unpricedCalls++;
      } else {
        cost += partsTotal(parts);
        bucket.costUSD += partsTotal(parts);
        composition.cacheRead += parts.cacheRead;
        composition.cacheWrite += parts.cacheWrite;
        composition.freshInput += parts.freshInput;
        composition.output += parts.output;
      }

      // Turn/behaviour metrics use main-chain calls only.
      if (call.sidechain) continue;
      if (!current) {
        current = { calls: 0, output: 0 };
        turns.push(current);
      }
      current.calls++;
      current.output += call.output;
      apiCalls++;
      const created = call.cacheCreate5m + call.cacheCreate1h;
      cacheReadSum += call.cacheRead;
      cacheInputSum += call.cacheRead + created + call.input;
      create5m += call.cacheCreate5m;
      create1h += call.cacheCreate1h;
      contextSum += call.cacheRead + created;
    }
  }

  const realTurns = turns.filter((t) => t.calls > 0);
  if (realTurns.length === 0 && apiCalls === 0) return null;

  const activeDays = Math.max(1, days.size);
  const totalCreate = create5m + create1h;
  const durationHours =
    firstAt && lastAt ? (new Date(lastAt).getTime() - new Date(firstAt).getTime()) / 3_600_000 : 0;

  const byModel = [...perModel.values()]
    .map((m) => ({ ...m, share: cost > 0 ? m.costUSD / cost : 0 }))
    .sort((a, b) => b.costUSD - a.costUSD);

  return {
    tool: TOOL_LABEL,
    sessions: files.length,
    apiCalls,
    turns: realTurns.length,
    firstAt,
    lastAt,
    durationHours,
    activeDays,
    models: [...models].sort(),
    byModel,
    composition,
    apiCallsPerTurn: stats(realTurns.map((t) => t.calls)),
    outputTokensPerTurn: stats(realTurns.map((t) => t.output)),
    turnsPerDay: realTurns.length / activeDays,
    cacheReadRate: cacheInputSum > 0 ? cacheReadSum / cacheInputSum : 0,
    ttlSplit: {
      "5m": totalCreate > 0 ? create5m / totalCreate : 0,
      "1h": totalCreate > 0 ? create1h / totalCreate : 0,
    },
    avgContextTokens: apiCalls > 0 ? Math.round(contextSum / apiCalls) : 0,
    actualCostUSD: cost,
    actualCostPerTurn: realTurns.length > 0 ? cost / realTurns.length : 0,
    unpricedCalls,
  };
}
