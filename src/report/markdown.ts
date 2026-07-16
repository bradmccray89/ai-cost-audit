import type { Config, Report } from "../types.js";

const KIND_LABELS: Record<string, string> = {
  "repo-instructions": "Repository instructions",
  "local-instructions": "Local instructions",
  "global-instructions": "Global instructions (user)",
  agent: "Agent definitions",
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
  lines.push(`| **Repo baseline (CI-gated)** | **${num(totals.gatedBaseline)}** |`);
  if (totals.globalBaseline > 0) {
    lines.push(
      `| Global user files (not counted toward CI budget) | ${num(totals.globalBaseline)} |`,
    );
  }
  lines.push(`| **Total baseline** | **${num(totals.guaranteed)}** |`);
  lines.push("");
  if (totals.conditional > 0) {
    lines.push(
      `Conditional context (loads for some tasks): ${num(totals.conditional)} tokens across ` +
        `${report.sources.filter((s) => s.usage === "conditional").length} sources.`,
    );
    lines.push("");
  }

  // 2. Per-model cost
  lines.push(`## Estimated cost per request (baseline input only)`);
  lines.push("");
  lines.push(`| Model | Uncached | With caching (typical) |`);
  lines.push(`|---|---:|---:|`);
  for (const c of costs) {
    lines.push(
      `| ${c.model} | ${formatUSD(c.perRequestUncached)} | ${formatUSD(c.perRequestCached)} |`,
    );
  }
  lines.push("");
  lines.push(
    `Cost figures use the full guaranteed baseline (repo + global). ` +
      `"With caching" models prompt caching: ${meta.cacheFormula}.`,
  );
  lines.push("");

  // 3. Daily projections + runway
  lines.push(`## Daily usage projections`);
  lines.push("");
  for (const c of costs) {
    if (c.perRequestUncached === null) {
      lines.push(`- ${c.model}: pricing not set (see config.pricingOverrides)`);
      continue;
    }
    lines.push(`**${c.model}**`);
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

  // 4. Typical request range (variable bucket)
  lines.push(`## Typical full-request range`);
  lines.push("");
  lines.push(
    `Baseline plus variable context (conversation history ` +
      `${num(cfg.variable.conversationHistory[0])}–${num(cfg.variable.conversationHistory[1])}, ` +
      `task files ${num(cfg.variable.taskFiles[0])}–${num(cfg.variable.taskFiles[1])} tokens):`,
  );
  lines.push("");
  lines.push(
    `**Estimated request range: ${num(report.requestRange.min)}–${num(report.requestRange.max)} input tokens.**`,
  );
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
  lines.push(`| Path | Kind | Usage | Scope | Tokens | Confidence |`);
  lines.push(`|---|---|---|---|---:|---|`);
  for (const s of [...report.sources].sort((a, b) => b.tokens - a.tokens)) {
    lines.push(
      `| ${s.path} | ${s.kind} | ${s.usage} | ${s.scope} | ${num(s.tokens)} | ${s.confidence} |`,
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
