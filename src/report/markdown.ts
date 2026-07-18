import type { Config, Consumer, ModelCost, Report } from "../types.js";
import { CONSUMER_LABELS, CONSUMER_ORDER } from "../consumers.js";

const KIND_LABELS: Record<string, string> = {
  "repo-instructions": "Repository instructions",
  "local-instructions": "Local instructions",
  "global-instructions": "Global instructions (user)",
  agent: "Agent bodies (on demand)",
  "agent-description": "Agent descriptions (always loaded)",
  "skill-description": "Skill descriptions (always loaded)",
  "skill-body": "Skill bodies (on demand)",
  command: "Slash commands",
  "mcp-config": "MCP configuration",
  "cursor-rules": "Cursor rules",
  "copilot-instructions": "Copilot instructions",
  "referenced-doc": "Referenced documentation",
};

export function formatUSD(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

export function renderMarkdown(report: Report, cfg: Config): string {
  const lines: string[] = [];
  const { totals, costs, findings, meta } = report;

  lines.push(`# AI Context Cost Audit`);
  lines.push("");
  lines.push(`Scanned \`${meta.projectPath}\` at ${meta.scannedAt}`);
  lines.push("");

  // 1. Guaranteed Context Cost
  lines.push(`## Guaranteed Context (loaded on every request)`);
  lines.push("");
  lines.push(`| Source kind | Tokens |`);
  lines.push(`|---|---:|`);
  const guaranteedSources = report.sources.filter((s) => s.usage === "guaranteed");
  const kindTotals = new Map<string, number>();
  for (const s of guaranteedSources) {
    kindTotals.set(s.kind, (kindTotals.get(s.kind) ?? 0) + s.tokens);
  }
  for (const [kind, tokens] of [...kindTotals.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${KIND_LABELS[kind] ?? kind} | ${num(tokens)} |`);
  }
  lines.push(`| **Repo total (CI-gated)** | **${num(totals.gatedBaseline)}** |`);
  if (totals.globalBaseline > 0) {
    lines.push(
      `| Global user files (not counted toward CI budget) | ${num(totals.globalBaseline)} |`,
    );
  }
  lines.push("");
  if (totals.conditional > 0) {
    lines.push(
      `Conditional context (loads for some tasks): ${num(totals.conditional)} tokens across ` +
        `${report.sources.filter((s) => s.usage === "conditional").length} sources.`,
    );
    lines.push("");
  }

  // 2. Per-tool baselines — the numbers costs are computed from.
  const consumers = CONSUMER_ORDER.filter((c) => totals.byConsumer[c] !== undefined);
  lines.push(`## Per-tool baselines`);
  lines.push("");
  lines.push(
    `Each tool loads only its own sources, so per-request numbers are computed ` +
      `per tool — the repo total above is what the repo ships, not what any single request loads.`,
  );
  lines.push("");
  lines.push(`| Tool | Repo | Global | Tool overhead | Total baseline |`);
  lines.push(`|---|---:|---:|---:|---:|`);
  for (const c of consumers) {
    const t = totals.byConsumer[c]!;
    lines.push(
      `| ${CONSUMER_LABELS[c]} | ${num(t.gated)} | ${num(t.global)} | ${num(t.systemOverhead)} | **${num(t.total)}** |`,
    );
  }
  lines.push("");
  lines.push(
    `Tool overhead is the tool's own system prompt + built-in tool definitions — ` +
      `loaded before any repo file. Shipped estimates as of ${meta.systemOverheadAsOf}; ` +
      `override per tool via config.systemOverheadTokens (0 excludes it).`,
  );
  lines.push("");

  // 3. Per-model cost, per tool
  lines.push(`## Estimated cost per request (baseline input only)`);
  lines.push("");
  const costsByConsumer = new Map<Consumer, ModelCost[]>();
  for (const c of costs) {
    const list = costsByConsumer.get(c.consumer) ?? [];
    list.push(c);
    costsByConsumer.set(c.consumer, list);
  }
  for (const consumer of consumers) {
    const consumerCosts = costsByConsumer.get(consumer) ?? [];
    if (consumers.length > 1) {
      lines.push(`**${CONSUMER_LABELS[consumer]}** (baseline ${num(totals.byConsumer[consumer]!.total)} tokens)`);
      lines.push("");
    }
    lines.push(`| Model | Uncached | With caching (typical) |`);
    lines.push(`|---|---:|---:|`);
    for (const c of consumerCosts) {
      lines.push(
        `| ${c.model} | ${formatUSD(c.perRequestUncached)} | ${formatUSD(c.perRequestCached)} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    `Cost figures use each tool's own total baseline (repo + global + tool overhead). ` +
      `"With caching" models prompt caching: ${meta.cacheFormula}.`,
  );
  lines.push("");

  // 4. Daily projections + runway
  lines.push(`## Daily usage projections`);
  lines.push("");
  for (const consumer of consumers) {
    for (const c of costsByConsumer.get(consumer) ?? []) {
      const label = consumers.length > 1 ? `${CONSUMER_LABELS[consumer]} · ${c.model}` : c.model;
      if (c.perRequestUncached === null) {
        lines.push(`- ${label}: pricing not set (see config.pricingOverrides)`);
        continue;
      }
      lines.push(`**${label}**`);
      lines.push("");
      lines.push(`| Requests/day | Uncached | With caching |`);
      lines.push(`|---:|---:|---:|`);
      for (const d of c.daily) {
        lines.push(
          `| ${num(d.requestsPerDay)} | ${formatUSD(d.uncached)}/day | ${formatUSD(d.cached)}/day |`,
        );
      }
      lines.push("");
      if (c.runwayDays !== null && cfg.monthlyBudget !== null) {
        const sorted = [...cfg.requestsPerDay].sort((a, b) => a - b);
        const midRate = sorted[Math.floor(sorted.length / 2)]!;
        lines.push(
          `At ${num(midRate)} requests/day per developer` +
            (cfg.developers > 1 ? ` (${cfg.developers} developers)` : "") +
            `, your $${cfg.monthlyBudget}/month budget lasts ~${c.runwayDays.toFixed(1)} days.`,
        );
        lines.push("");
      }
    }
  }

  // 5. Typical request range (variable bucket), per tool
  lines.push(`## Typical full-request range`);
  lines.push("");
  lines.push(
    `Baseline plus variable context (conversation history ` +
      `${num(cfg.variable.conversationHistory[0])}–${num(cfg.variable.conversationHistory[1])}, ` +
      `task files ${num(cfg.variable.taskFiles[0])}–${num(cfg.variable.taskFiles[1])} tokens):`,
  );
  lines.push("");
  for (const consumer of consumers) {
    const range = report.requestRanges[consumer];
    if (!range) continue;
    lines.push(
      `- **${CONSUMER_LABELS[consumer]}: ${num(range.min)}–${num(range.max)} input tokens.**`,
    );
  }
  lines.push("");
  lines.push(
    `Variable context cannot be predicted exactly; these are configurable ranges, not measurements.`,
  );
  lines.push("");

  // 5. Findings
  lines.push(`## High-impact findings`);
  lines.push("");
  if (findings.length === 0) {
    lines.push(`No findings. Baseline looks lean.`);
  } else {
    for (const [i, f] of findings.entries()) {
      lines.push(`${i + 1}. **[${f.severity}] ${f.rule}** — ${f.message}`);
    }
  }
  lines.push("");

  // 6. Sources detail
  lines.push(`## All discovered sources`);
  lines.push("");
  lines.push(`| Path | Kind | Usage | Scope | Tools | Tokens | Confidence |`);
  lines.push(`|---|---|---|---|---|---:|---|`);
  for (const s of [...report.sources].sort((a, b) => b.tokens - a.tokens)) {
    lines.push(
      `| ${s.path} | ${s.kind} | ${s.usage} | ${s.scope} | ${s.consumers.join(", ")} | ${num(s.tokens)} | ${s.confidence} |`,
    );
  }
  lines.push("");
  const noted = report.sources.filter((s) => s.note);
  if (noted.length > 0) {
    lines.push(`Notes:`);
    for (const s of noted) {
      lines.push(`- \`${s.path}\`: ${s.note}`);
    }
    lines.push("");
  }

  // Footer: honesty block
  lines.push(`---`);
  lines.push("");
  lines.push(`*${meta.disclosure}*`);
  lines.push("");
  lines.push(
    `*Calibration factors (applied to o200k_base counts): ${Object.entries(meta.calibration)
      .map(([provider, factor]) => `${provider} ×${factor}`)
      .join(", ")}. Pricing as of ${meta.pricingAsOf}` +
      (meta.pricingStale
        ? ` — **stale (>90 days old)**: verify current pricing and override via config.pricingOverrides`
        : "") +
      `.*`,
  );
  lines.push("");
  lines.push(`*Generated by ${meta.tool} v${meta.version}.*`);

  return lines.join("\n");
}
