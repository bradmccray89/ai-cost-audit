import type { Config, ContextSource, Finding, Snapshot } from "../types.js";
import type { DuplicateGroup } from "./duplication.js";

const LARGE_SOURCE_PCT = 25;
const MCP_SHARE_PCT = 30;

/** Derive lint-style findings from scan data. All computed — no AI. */
export function deriveFindings(
  sources: ContextSource[],
  duplicates: DuplicateGroup[],
  gatedBaseline: number,
  snapshot: Snapshot | null,
  cfg: Config,
): Finding[] {
  const findings: Finding[] = [];

  // duplicate-content / near-duplicate-content
  for (const group of duplicates) {
    findings.push({
      rule: group.exact ? "duplicate-content" : "near-duplicate-content",
      severity: "warn",
      message: group.exact
        ? `${group.redundantTokens.toLocaleString()} redundant tokens: identical content in ${group.sources.join(", ")} ("${group.excerpt}")`
        : `~${group.redundantTokens.toLocaleString()} redundant tokens: nearly identical content in ${group.sources.join(", ")} ("${group.excerpt}")`,
      sources: group.sources,
      tokens: group.redundantTokens,
    });
  }

  // large-source: single repo-scoped guaranteed source dominating the baseline.
  if (gatedBaseline > 0) {
    for (const s of sources) {
      if (s.scope !== "repo" || s.usage !== "guaranteed") continue;
      const pct = (s.tokens / gatedBaseline) * 100;
      if (pct > LARGE_SOURCE_PCT) {
        findings.push({
          rule: "large-source",
          severity: "warn",
          message: `${s.path} alone is ${Math.round(pct)}% of the baseline (${s.tokens.toLocaleString()} tokens). Consider splitting into on-demand skills or conditional instructions.`,
          sources: [s.path],
          tokens: s.tokens,
        });
      }
    }

    // mcp-schema-share
    const mcpTokens = sources
      .filter((s) => s.adapter === "generic-mcp" && s.scope === "repo" && s.usage === "guaranteed")
      .reduce((sum, s) => sum + s.tokens, 0);
    const mcpPct = (mcpTokens / gatedBaseline) * 100;
    if (mcpPct > MCP_SHARE_PCT) {
      findings.push({
        rule: "mcp-schema-share",
        severity: "info",
        message: `MCP configuration is ${Math.round(mcpPct)}% of the baseline (${mcpTokens.toLocaleString()} tokens, likely an undercount — live schemas unmeasured). Consider restricting MCP tools by task.`,
        sources: sources
          .filter((s) => s.adapter === "generic-mcp")
          .map((s) => s.path),
        tokens: mcpTokens,
      });
    }
  }

  // baseline-growth vs snapshot
  if (snapshot && snapshot.gatedBaseline > 0) {
    const growthPct =
      ((gatedBaseline - snapshot.gatedBaseline) / snapshot.gatedBaseline) * 100;
    if (growthPct > cfg.growthThresholdPct) {
      const causes = topGrowthCauses(sources, snapshot);
      findings.push({
        rule: "baseline-growth",
        severity: "warn",
        message:
          `Baseline grew ${growthPct.toFixed(0)}% since the last snapshot ` +
          `(${snapshot.gatedBaseline.toLocaleString()} → ${gatedBaseline.toLocaleString()} tokens).` +
          (causes.length > 0 ? ` Primary cause: ${causes[0]}` : ""),
        sources: [],
        tokens: gatedBaseline - snapshot.gatedBaseline,
      });
    }
  }

  // legacy-cursorrules
  const legacy = sources.filter((s) => s.path === ".cursorrules");
  if (legacy.length > 0) {
    findings.push({
      rule: "legacy-cursorrules",
      severity: "info",
      message:
        "Legacy .cursorrules file found. Cursor now uses .cursor/rules/*.mdc, which supports glob scoping (loading rules only when relevant).",
      sources: [".cursorrules"],
    });
  }

  // unmeasured-mcp
  const unmeasured = sources.filter(
    (s) => s.adapter === "generic-mcp" && s.confidence === "low",
  );
  if (unmeasured.length > 0) {
    findings.push({
      rule: "unmeasured-mcp",
      severity: "info",
      message:
        `${unmeasured.length} MCP server(s) counted by config size only — live tool schemas ` +
        `require a running server and are usually far larger. Pin measured sizes via config.mcp.knownSchemaTokens.`,
      sources: unmeasured.map((s) => s.path),
    });
  }

  const severityRank = { error: 0, warn: 1, info: 2 } as const;
  return findings.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      (b.tokens ?? 0) - (a.tokens ?? 0),
  );
}

/** Human descriptions of the largest per-source diffs vs snapshot. */
export function topGrowthCauses(sources: ContextSource[], snapshot: Snapshot): string[] {
  const previous = new Map(snapshot.sources.map((s) => [s.path, s.tokens]));
  const current = new Map(
    sources
      .filter((s) => s.scope === "repo" && s.usage === "guaranteed")
      .map((s) => [s.path, s.tokens]),
  );

  const diffs: { path: string; delta: number; added: boolean }[] = [];
  for (const [path, tokens] of current) {
    const prev = previous.get(path);
    if (prev === undefined) diffs.push({ path, delta: tokens, added: true });
    else if (tokens !== prev) diffs.push({ path, delta: tokens - prev, added: false });
  }
  for (const [path, tokens] of previous) {
    if (!current.has(path)) diffs.push({ path, delta: -tokens, added: false });
  }

  return diffs
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 3)
    .map(({ path, delta, added }) => {
      const sign = delta >= 0 ? "+" : "−";
      const amount = `${sign}${Math.abs(delta).toLocaleString()} tokens`;
      if (added) return `Added ${path} (${amount})`;
      if (delta < 0 && !added) return `${path} (${amount})`;
      return `${path} grew (${amount})`;
    });
}
