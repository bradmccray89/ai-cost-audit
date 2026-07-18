import type { Config, Consumer, Report } from "../types.js";
import { CONSUMER_LABELS, CONSUMER_ORDER } from "../consumers.js";
import { formatUSD } from "./markdown.js";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

/** Single self-contained HTML file — inline CSS, no external assets. */
export function renderHtml(report: Report, cfg: Config): string {
  const { totals, costs, findings, meta } = report;

  const severityColor: Record<string, string> = {
    error: "#c0392b",
    warn: "#b7791f",
    info: "#2b6cb0",
  };

  const kindRows = (() => {
    const kindTotals = new Map<string, number>();
    for (const s of report.sources.filter((x) => x.usage === "guaranteed")) {
      kindTotals.set(s.kind, (kindTotals.get(s.kind) ?? 0) + s.tokens);
    }
    return [...kindTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kind, tokens]) => `<tr><td>${esc(kind)}</td><td class="r">${num(tokens)}</td></tr>`)
      .join("\n");
  })();

  const consumers = CONSUMER_ORDER.filter((c) => totals.byConsumer[c] !== undefined);

  const consumerRows = consumers
    .map((c) => {
      const t = totals.byConsumer[c]!;
      return `<tr><td>${esc(CONSUMER_LABELS[c])}</td><td class="r">${num(t.gated)}</td><td class="r">${num(t.global)}</td><td class="r">${num(t.systemOverhead)}</td><td class="r"><strong>${num(t.total)}</strong></td></tr>`;
    })
    .join("\n");

  const costRows = costs
    .map(
      (c) =>
        `<tr><td>${esc(CONSUMER_LABELS[c.consumer])}</td><td>${esc(c.model)}</td><td class="r">${formatUSD(c.perRequestUncached)}</td><td class="r">${formatUSD(c.perRequestCached)}</td></tr>`,
    )
    .join("\n");

  const rangeItems = consumers
    .map((c) => {
      const range = report.requestRanges[c];
      if (!range) return "";
      return `<li><strong>${esc(CONSUMER_LABELS[c])}:</strong> ${num(range.min)}&ndash;${num(range.max)} input tokens</li>`;
    })
    .join("\n");

  const findingItems =
    findings.length === 0
      ? `<li>No findings. Baseline looks lean.</li>`
      : findings
          .map(
            (f) =>
              `<li><span class="sev" style="background:${severityColor[f.severity]}">${f.severity}</span> <code>${esc(f.rule)}</code> — ${esc(f.message)}</li>`,
          )
          .join("\n");

  const sourceRows = [...report.sources]
    .sort((a, b) => b.tokens - a.tokens)
    .map(
      (s) =>
        `<tr><td><code>${esc(s.path)}</code></td><td>${esc(s.kind)}</td><td>${esc(s.usage)}</td><td>${esc(s.scope)}</td><td>${esc(s.consumers.join(", "))}</td><td class="r">${num(s.tokens)}</td><td>${esc(s.confidence)}</td></tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Context Cost Audit</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.2rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; margin: .75rem 0; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid rgba(128,128,128,.3); }
  td.r, th.r { text-align: right; font-variant-numeric: tabular-nums; }
  tr.total td { font-weight: 700; border-top: 2px solid rgba(128,128,128,.5); }
  code { font: 13px ui-monospace, Menlo, monospace; }
  .sev { color: #fff; font-size: 11px; padding: 1px 6px; border-radius: 3px; text-transform: uppercase; }
  .muted { opacity: .7; font-size: 13px; }
  li { margin: .4rem 0; }
  .big { font-size: 1.1rem; font-weight: 600; }
</style>
</head>
<body>
<h1>AI Context Cost Audit</h1>
<p class="muted">Scanned <code>${esc(meta.projectPath)}</code> at ${esc(meta.scannedAt)}</p>

<h2>Guaranteed context (loaded on every request)</h2>
<table>
<tr><th>Source kind</th><th class="r">Tokens</th></tr>
${kindRows}
<tr class="total"><td>Repo total (CI-gated)</td><td class="r">${num(totals.gatedBaseline)}</td></tr>
${totals.globalBaseline > 0 ? `<tr><td>Global user files (not gated)</td><td class="r">${num(totals.globalBaseline)}</td></tr>` : ""}
</table>

<h2>Per-tool baselines</h2>
<p class="muted">Each tool loads only its own sources; per-request numbers below are per tool. The repo total is what the repo ships, not what any single request loads.</p>
<table>
<tr><th>Tool</th><th class="r">Repo</th><th class="r">Global</th><th class="r">Tool overhead</th><th class="r">Total baseline</th></tr>
${consumerRows}
</table>
<p class="muted">Tool overhead = the tool's own system prompt + built-in tool definitions, loaded before any repo file. Shipped estimates as of ${esc(meta.systemOverheadAsOf)}; override via config.systemOverheadTokens.</p>

<h2>Estimated cost per request (baseline input only)</h2>
<table>
<tr><th>Tool</th><th>Model</th><th class="r">Uncached</th><th class="r">With caching (typical)</th></tr>
${costRows}
</table>
<p class="muted">${esc(meta.cacheFormula)}</p>

<h2>Typical full-request range</h2>
<ul>
${rangeItems}
</ul>
<p class="muted">Baseline + conversation history (${num(cfg.variable.conversationHistory[0])}&ndash;${num(cfg.variable.conversationHistory[1])}) + task files (${num(cfg.variable.taskFiles[0])}&ndash;${num(cfg.variable.taskFiles[1])}). Ranges, not measurements.</p>

<h2>High-impact findings</h2>
<ol>
${findingItems}
</ol>

<h2>All discovered sources</h2>
<table>
<tr><th>Path</th><th>Kind</th><th>Usage</th><th>Scope</th><th>Tools</th><th class="r">Tokens</th><th>Confidence</th></tr>
${sourceRows}
</table>

<hr>
<p class="muted">${esc(meta.disclosure)}</p>
<p class="muted">Calibration: ${esc(
    Object.entries(meta.calibration)
      .map(([provider, factor]) => `${provider} ×${factor}`)
      .join(", "),
  )}. Pricing as of ${esc(meta.pricingAsOf)} (${esc(meta.pricingOrigin)}: ${esc(meta.pricingSource)})${meta.pricingStale ? " — <strong>stale; refresh with --refresh-pricing or override via config</strong>" : ""}.</p>
<p class="muted">Generated by ${esc(meta.tool)} v${esc(meta.version)}.</p>
</body>
</html>
`;
}
