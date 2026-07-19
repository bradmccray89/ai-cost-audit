import type { Config, Consumer, ModelCost, MoneyRange, Report } from "../types.js";
import { CONSUMER_LABELS, CONSUMER_ORDER } from "../consumers.js";
import { projectMeasured } from "../costModel.js";

export const KIND_LABELS: Record<string, string> = {
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

/**
 * Direction-aware plan recommendation (plain text, shared by all renderers).
 * Focuses on the robust signal — subscription vs API — and caveats tier choice,
 * since plan limits are not reliable data.
 */
export function planRecommendationText(advice: import("../types.js").PlanAdvice): string {
  const { current, cheapest, savingsVsCurrent } = advice;
  const cheapestPlan = advice.options.find((o) => !o.isApi);
  const apiIsCheapest = cheapest.isApi;
  const save = savingsVsCurrent !== null ? formatUSD(Math.abs(savingsVsCurrent)) : "";

  if (current) {
    if (current.id === cheapest.id) {
      return `you're on the most cost-effective option (${current.label}) for your usage.`;
    }
    if (apiIsCheapest) {
      return `your usage is light — switch to API pay-as-you-go (~${formatUSD(cheapest.monthlyUSD)}/mo) and save ~${save}/mo per developer.`;
    }
    if (current.isApi && cheapestPlan) {
      return `a subscription is far cheaper than API at your volume — ${cheapestPlan.label} ($${cheapestPlan.monthlyUSD}/mo) would save ~${save}/mo per developer, if it sustains your usage.`;
    }
    return `a lower tier (${cheapest.label}, $${cheapest.monthlyUSD}/mo) may suffice and save ~${save}/mo per developer — verify it sustains your volume before downgrading.`;
  }

  if (apiIsCheapest) {
    return `your usage is light — API pay-as-you-go (~${formatUSD(cheapest.monthlyUSD)}/mo per developer) is cheaper than any subscription.`;
  }
  return `your usage is worth ${formatUSD(advice.apiEquivMonthly)}/mo at API rates — a subscription is far cheaper. Pick the lowest tier that sustains your volume (from ${cheapestPlan?.label ?? "a plan"} at $${cheapestPlan?.monthlyUSD ?? "?"}/mo).`;
}

export function formatUSD(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Format a money range, collapsing to a single value when min ≈ max. */
export function formatUSDRange(range: MoneyRange | null): string {
  if (range === null) return "—";
  if (Math.abs(range.max - range.min) < 1e-9) return formatUSD(range.min);
  return `${formatUSD(range.min)}–${formatUSD(range.max)}`;
}

/** Format a runway range in days, collapsing when min ≈ max. */
export function formatDays(range: MoneyRange | null): string {
  if (range === null) return "—";
  if (Math.abs(range.max - range.min) < 0.05) return `${range.min.toFixed(1)} days`;
  return `${range.min.toFixed(1)}–${range.max.toFixed(1)} days`;
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
  const [aLo, aHi] = cfg.apiCallsPerTurn;
  lines.push(`## Estimated cost per turn (baseline input only)`);
  lines.push("");
  lines.push(
    `A **turn** is one user message and the ${aLo}–${aHi} API calls it triggers ` +
      `(tool-use round trips); each call re-sends the baseline, so costs are ranges. ` +
      `Tune \`apiCallsPerTurn\` to your workflow.`,
  );
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
    lines.push(`| Model | Input uncached | Input cached | Output | Total/turn |`);
    lines.push(`|---|---:|---:|---:|---:|`);
    for (const c of consumerCosts) {
      lines.push(
        `| ${c.model} | ${formatUSDRange(c.perTurnUncached)} | ${formatUSDRange(c.perTurnCached)} | ${formatUSDRange(c.outputPerTurn)} | **${formatUSDRange(c.totalPerTurn)}** |`,
      );
    }
    lines.push("");
  }
  const [oLo, oHi] = cfg.outputTokensPerTurn;
  lines.push(
    `Input uses each tool's own total baseline (repo + global + tool overhead); ` +
      `output is a configured ${num(oLo)}–${num(oHi)} tokens/turn, never cached (pending ` +
      `per-user measurement). **Total/turn = cached input + output.** ${meta.cacheFormula}.`,
  );
  lines.push("");

  // 4. Daily projections + runway (all-in: input + output)
  lines.push(`## Daily usage projections`);
  lines.push("");
  lines.push(`All-in per turn (input + output), per developer:`);
  lines.push("");
  for (const consumer of consumers) {
    for (const c of costsByConsumer.get(consumer) ?? []) {
      const label = consumers.length > 1 ? `${CONSUMER_LABELS[consumer]} · ${c.model}` : c.model;
      if (c.perTurnUncached === null) {
        lines.push(`- ${label}: pricing not set (see config.pricingOverrides)`);
        continue;
      }
      lines.push(`**${label}**`);
      lines.push("");
      lines.push(`| Turns/day | Uncached | With caching |`);
      lines.push(`|---:|---:|---:|`);
      for (const d of c.daily) {
        lines.push(
          `| ${num(d.turnsPerDay)} | ${formatUSDRange(d.uncached)}/day | ${formatUSDRange(d.cached)}/day |`,
        );
      }
      lines.push("");
      if (c.runwayDays !== null && cfg.monthlyBudget !== null) {
        const sorted = [...cfg.turnsPerDay].sort((a, b) => a - b);
        const midRate = sorted[Math.floor(sorted.length / 2)]!;
        lines.push(
          `At ${num(midRate)} turns/day per developer` +
            (cfg.developers > 1 ? ` (${cfg.developers} developers)` : "") +
            `, your $${cfg.monthlyBudget}/month budget lasts ~${formatDays(c.runwayDays)}.`,
        );
        lines.push("");
      }
    }
  }

  // 4b. Measured from local transcripts (ground truth).
  const m = report.measured;
  if (m) {
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const stat = (s: { min: number; median: number; max: number }) =>
      `${Math.round(s.median).toLocaleString()} (${Math.round(s.min).toLocaleString()}–${Math.round(s.max).toLocaleString()})`;
    const dur = m.durationHours >= 1 ? `${m.durationHours.toFixed(1)}h` : `${Math.round(m.durationHours * 60)}m`;
    lines.push(`## Measured from your usage — ${m.tool}`);
    lines.push("");
    lines.push(
      `From ${m.sessions} local ${m.tool} session(s), ${m.firstAt.slice(0, 10)} → ${m.lastAt.slice(0, 10)} ` +
        `(${num(m.turns)} turns, ${num(m.apiCalls)} API calls, ~${dur}):`,
    );
    lines.push("");
    lines.push(`| Metric | Measured | vs configured |`);
    lines.push(`|---|---:|---|`);
    lines.push(`| API calls/turn | ${stat(m.apiCallsPerTurn)} | configured ${cfg.apiCallsPerTurn[0]}–${cfg.apiCallsPerTurn[1]} |`);
    lines.push(`| Output tokens/turn | ${stat(m.outputTokensPerTurn)} | configured ${num(cfg.outputTokensPerTurn[0])}–${num(cfg.outputTokensPerTurn[1])} |`);
    lines.push(`| Turns/day (active) | ${m.turnsPerDay.toFixed(1)} | ${m.activeDays} active days |`);
    lines.push(`| Cache read rate | ${pct(m.cacheReadRate)} | TTL ${pct(m.ttlSplit["5m"])} 5m / ${pct(m.ttlSplit["1h"])} 1h |`);
    lines.push(`| Avg context/call | ${num(m.avgContextTokens)} tok | actual baseline + history |`);
    lines.push(`| **Cost at API rates** | **${formatUSD(m.actualCostUSD)}** | **${formatUSD(m.actualCostPerTurn)}/turn** |`);
    lines.push("");
    lines.push(
      `"Cost at API rates" is what this usage would cost pay-as-you-go; on a subscription you pay a flat fee (see Plan advisor).`,
    );
    lines.push("");
    if (m.byModel.length > 0) {
      lines.push(`**By model**`);
      lines.push("");
      lines.push(`| Model | Calls | Output tok | Cost | Share |`);
      lines.push(`|---|---:|---:|---:|---:|`);
      for (const mm of m.byModel) {
        lines.push(`| ${mm.model} | ${num(mm.calls)} | ${num(mm.outputTokens)} | ${formatUSD(mm.costUSD)} | ${Math.round(mm.share * 100)}% |`);
      }
      lines.push("");
    }
    const comp = m.composition;
    lines.push(
      `Cost went to: cache reads ${formatUSD(comp.cacheRead)}, cache writes ${formatUSD(comp.cacheWrite)}, ` +
        `output ${formatUSD(comp.output)}, fresh input ${formatUSD(comp.freshInput)}.`,
    );
    lines.push("");
    const est = report.costs.find((c) => c.consumer === "claude-code" && c.totalPerTurn !== null);
    if (est) {
      lines.push(
        `Reconciliation: estimated **${formatUSDRange(est.totalPerTurn)}/turn** (${est.model}) ` +
          `vs measured **${formatUSD(m.actualCostPerTurn)}/turn** actual.`,
      );
      lines.push("");
    }
    if (m.unpricedCalls > 0) {
      lines.push(`${num(m.unpricedCalls)} call(s) used a model not in the pricing table (excluded from cost).`);
      lines.push("");
    }

    // Forward projection from measured actual $/turn — the tailored forecast.
    const proj = projectMeasured(m, cfg);
    lines.push(`### Projected from your measured usage`);
    lines.push("");
    lines.push(`At your measured **${formatUSD(proj.perTurn)}/turn** actual, team-wide (${cfg.developers} dev(s)):`);
    lines.push("");
    lines.push(`| Turns/day/dev | Team $/day | ≈ $/month |`);
    lines.push(`|---:|---:|---:|`);
    for (const d of proj.daily) {
      lines.push(`| ${num(d.turnsPerDay)} | ${formatUSD(d.teamPerDay)}/day | ${formatUSD(d.teamPerDay * 30)} |`);
    }
    lines.push(`| **${num(proj.measuredPace.turnsPerDay)} (measured)** | **${formatUSD(proj.measuredPace.teamPerDay)}/day** | **${formatUSD(proj.measuredPace.teamPerDay * 30)}** |`);
    lines.push("");
    if (proj.runwayDays !== null && cfg.monthlyBudget !== null) {
      lines.push(
        `At your measured pace (~${num(proj.measuredPace.turnsPerDay)} turns/day/dev × ${cfg.developers} dev(s)), ` +
          `your $${cfg.monthlyBudget}/month budget lasts ~${proj.runwayDays.toFixed(1)} days.`,
      );
      lines.push("");
    }

    // Plan advisor: subscription vs API pay-as-you-go.
    const advice = report.planAdvice;
    if (advice) {
      lines.push(`### Plan advisor`);
      lines.push("");
      lines.push(`Per developer, at your measured **${formatUSD(advice.apiEquivMonthly)}/mo** API-equivalent usage:`);
      lines.push("");
      lines.push(`| Option | $/month | |`);
      lines.push(`|---|---:|---|`);
      for (const o of advice.options) {
        const tags = [o.isCurrent ? "current" : "", o.id === advice.cheapest.id ? "**cheapest**" : ""].filter(Boolean).join(" ");
        lines.push(`| ${o.label} | ${formatUSD(o.monthlyUSD)}${o.isApi ? "*" : ""} | ${tags} |`);
      }
      lines.push("");
      lines.push(`**Recommendation:** ${planRecommendationText(advice)}`);
      lines.push("");
      lines.push(
        `*API scales with usage. Plan prices are dated estimates (as of ${advice.asOf}); limits are not ` +
          `published as token quotas, so heavy usage may throttle — verify and set \`config.plan\`.`,
      );
      lines.push("");
    }
  }

  // 5. Per-call context size (variable bucket), per tool
  lines.push(`## Typical context per API call`);
  lines.push("");
  lines.push(
    `A single API call's input: baseline plus variable context (conversation history ` +
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
      .join(", ")}. Pricing as of ${meta.pricingAsOf} (${meta.pricingOrigin}: ${meta.pricingSource})` +
      (meta.pricingStale
        ? ` — **stale (>90 days old)**: refresh with \`--refresh-pricing\` or override via config.pricingOverrides`
        : "") +
      `.*`,
  );
  lines.push("");
  lines.push(`*Generated by ${meta.tool} v${meta.version}.*`);

  return lines.join("\n");
}
