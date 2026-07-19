import type { Config, Consumer, PlanAdvice, Report } from "../types.js";
import { CONSUMER_LABELS, CONSUMER_ORDER } from "../consumers.js";
import { projectMeasured } from "../costModel.js";
import { formatUSD, formatUSDRange, planRecommendationText } from "./markdown.js";

function planAdviceHtml(advice: PlanAdvice | null): string {
  if (!advice) return "";
  const rows = advice.options
    .map((o) => {
      const tags = [o.isCurrent ? "current" : "", o.id === advice.cheapest.id ? "<strong>cheapest</strong>" : ""]
        .filter(Boolean)
        .join(" ");
      return `<tr><td>${esc(o.label)}</td><td class="r">${formatUSD(o.monthlyUSD)}${o.isApi ? "*" : ""}</td><td>${tags}</td></tr>`;
    })
    .join("\n");
  const rec = `Recommendation: ${planRecommendationText(advice)}`;
  return `
<h3>Plan advisor</h3>
<p class="muted">Per developer, at your measured ${formatUSD(advice.apiEquivMonthly)}/mo API-equivalent usage:</p>
<table>
<tr><th>Option</th><th class="r">$/month</th><th></th></tr>
${rows}
</table>
<p><strong>${esc(rec)}</strong></p>
<p class="muted">*API scales with usage. Plan prices are dated estimates (as of ${esc(advice.asOf)}); limits are not published as token quotas, so heavy usage may throttle &mdash; verify and set config.plan.</p>`;
}

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
        `<tr><td>${esc(CONSUMER_LABELS[c.consumer])}</td><td>${esc(c.model)}</td><td class="r">${formatUSDRange(c.perTurnUncached)}</td><td class="r">${formatUSDRange(c.perTurnCached)}</td><td class="r">${formatUSDRange(c.outputPerTurn)}</td><td class="r"><strong>${formatUSDRange(c.totalPerTurn)}</strong></td></tr>`,
    )
    .join("\n");

  const rangeItems = consumers
    .map((c) => {
      const range = report.requestRanges[c];
      if (!range) return "";
      return `<li><strong>${esc(CONSUMER_LABELS[c])}:</strong> ${num(range.min)}&ndash;${num(range.max)} input tokens</li>`;
    })
    .join("\n");

  const m = report.measured;
  const measuredHtml = (() => {
    if (!m) return "";
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const stat = (s: { min: number; median: number; max: number }) =>
      `${num(Math.round(s.median))} (${num(Math.round(s.min))}&ndash;${num(Math.round(s.max))})`;
    const est = costs.find((c) => c.consumer === "claude-code" && c.totalPerTurn !== null);
    const recon = est
      ? `<p class="muted">Reconciliation: estimated <strong>${formatUSDRange(est.totalPerTurn)}</strong>/turn (${esc(est.model)}) vs measured <strong>${formatUSD(m.actualCostPerTurn)}</strong>/turn actual.</p>`
      : "";
    const proj = projectMeasured(m, cfg);
    const projRows = proj.daily
      .map((d) => `<tr><td class="r">${num(d.turnsPerDay)}</td><td class="r">${formatUSD(d.teamPerDay)}/day</td><td class="r">${formatUSD(d.teamPerDay * 30)}</td></tr>`)
      .join("\n");
    const runwayLine =
      proj.runwayDays !== null && cfg.monthlyBudget !== null
        ? `<p class="muted">At your measured pace (~${num(proj.measuredPace.turnsPerDay)} turns/day/dev &times; ${cfg.developers} dev(s)), your $${cfg.monthlyBudget}/month budget lasts ~${proj.runwayDays.toFixed(1)} days.</p>`
        : "";
    return `
<h2>Measured from your usage</h2>
<p class="muted">From ${m.sessions} local Claude Code session(s), ${esc(m.firstAt.slice(0, 10))} &rarr; ${esc(m.lastAt.slice(0, 10))} (${num(m.turns)} turns, ${num(m.apiCalls)} API calls).</p>
<table>
<tr><th>Metric</th><th class="r">Measured</th><th>vs configured</th></tr>
<tr><td>API calls/turn</td><td class="r">${stat(m.apiCallsPerTurn)}</td><td>configured ${num(cfg.apiCallsPerTurn[0])}&ndash;${num(cfg.apiCallsPerTurn[1])}</td></tr>
<tr><td>Output tokens/turn</td><td class="r">${stat(m.outputTokensPerTurn)}</td><td>configured ${num(cfg.outputTokensPerTurn[0])}&ndash;${num(cfg.outputTokensPerTurn[1])}</td></tr>
<tr><td>Turns/day (active)</td><td class="r">${m.turnsPerDay.toFixed(1)}</td><td>${m.activeDays} active days</td></tr>
<tr><td>Cache read rate</td><td class="r">${pct(m.cacheReadRate)}</td><td>TTL ${pct(m.ttlSplit["5m"])} 5m / ${pct(m.ttlSplit["1h"])} 1h</td></tr>
<tr><td>Avg context/call</td><td class="r">${num(m.avgContextTokens)} tok</td><td>actual baseline + history</td></tr>
<tr class="total"><td>Cost at API rates</td><td class="r">${formatUSD(m.actualCostUSD)}</td><td>${formatUSD(m.actualCostPerTurn)}/turn</td></tr>
</table>
<p class="muted">"Cost at API rates" is what this usage would cost pay-as-you-go; on a subscription you pay a flat fee (see Plan advisor).</p>
${recon}
<h3>Projected from your measured usage</h3>
<p class="muted">At your measured <strong>${formatUSD(proj.perTurn)}</strong>/turn actual, team-wide (${cfg.developers} dev(s)):</p>
<table>
<tr><th class="r">Turns/day/dev</th><th class="r">Team $/day</th><th class="r">&asymp; $/month</th></tr>
${projRows}
<tr class="total"><td class="r">${num(proj.measuredPace.turnsPerDay)} (measured)</td><td class="r">${formatUSD(proj.measuredPace.teamPerDay)}/day</td><td class="r">${formatUSD(proj.measuredPace.teamPerDay * 30)}</td></tr>
</table>
${runwayLine}
${planAdviceHtml(report.planAdvice)}`;
  })();

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

<h2>Estimated cost per turn</h2>
<p class="muted">A turn is one user message and the ${num(cfg.apiCallsPerTurn[0])}&ndash;${num(cfg.apiCallsPerTurn[1])} API calls it triggers (tool-use round trips); each re-sends the baseline. Output is a configured ${num(cfg.outputTokensPerTurn[0])}&ndash;${num(cfg.outputTokensPerTurn[1])} tokens/turn, never cached (pending per-user measurement). Total/turn = cached input + output.</p>
<table>
<tr><th>Tool</th><th>Model</th><th class="r">Input uncached</th><th class="r">Input cached</th><th class="r">Output</th><th class="r">Total/turn</th></tr>
${costRows}
</table>
<p class="muted">${esc(meta.cacheFormula)}</p>
${measuredHtml}
<h2>Typical context per API call</h2>
<ul>
${rangeItems}
</ul>
<p class="muted">A single API call's input: baseline + conversation history (${num(cfg.variable.conversationHistory[0])}&ndash;${num(cfg.variable.conversationHistory[1])}) + task files (${num(cfg.variable.taskFiles[0])}&ndash;${num(cfg.variable.taskFiles[1])}). Ranges, not measurements.</p>

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
