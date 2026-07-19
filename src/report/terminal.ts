import pc from "picocolors";
import type { Config, Consumer, ModelCost, Report } from "../types.js";
import { CONSUMER_LABELS, CONSUMER_ORDER } from "../consumers.js";
import { projectMeasured } from "../costModel.js";
import { formatDays, formatUSD, formatUSDRange, KIND_LABELS, planRecommendationText } from "./markdown.js";

/**
 * Terminal-native rendering: aligned columns instead of markdown pipes,
 * restrained color, compact projections. Used by default when stdout is a
 * TTY; `-f md` remains the plain-text/document format.
 */

const INDENT = "  ";
const GAP = "  ";

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function statStr(s: { min: number; median: number; max: number }): string {
  const round = (v: number) => num(Math.round(v));
  return `${round(s.median)} (${round(s.min)}–${round(s.max)})`;
}

function planRecommendation(advice: import("../types.js").PlanAdvice): string[] {
  return [pc.green(`→ ${planRecommendationText(advice)}`)];
}

interface Column {
  header: string;
  align: "left" | "right";
}

/**
 * Render an aligned table. Widths are computed on plain strings; any color is
 * applied per-line afterwards so padding stays correct.
 */
function table(
  columns: Column[],
  rows: string[][],
  styleRow?: (line: string, rowIndex: number) => string,
): string[] {
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const format = (cells: string[]): string =>
    INDENT +
    cells
      .map((cell, i) =>
        columns[i]!.align === "right" ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!),
      )
      .join(GAP)
      .trimEnd();

  const lines = [pc.dim(format(columns.map((c) => c.header)))];
  rows.forEach((row, rowIndex) => {
    const line = format(row);
    lines.push(styleRow ? styleRow(line, rowIndex) : line);
  });
  return lines;
}

function heading(text: string): string {
  return pc.bold(text.toUpperCase());
}

/** Word-wrap with a hanging indent, for findings and notes. */
function wrap(text: string, width: number, firstPrefix: string, restPrefix: string): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = firstPrefix;
  let bare = firstPrefix.length;
  for (const word of words) {
    if (bare + word.length + 1 > width && bare > restPrefix.length) {
      lines.push(current);
      current = restPrefix + word;
      bare = restPrefix.length + word.length;
    } else {
      const sep = current === firstPrefix || current === restPrefix ? "" : " ";
      current += sep + word;
      bare += sep.length + word.length;
    }
  }
  if (current.trim().length > 0) lines.push(current);
  return lines;
}

/** Keep long paths on one line: elide the middle, preserve the filename. */
function elide(path: string, max: number): string {
  if (path.length <= max) return path;
  const tail = path.slice(-(max - 1));
  return `…${tail}`;
}

export function renderTerminal(report: Report, cfg: Config): string {
  const width = Math.min(Math.max(process.stdout.columns ?? 100, 60), 120);
  const { totals, costs, findings, meta } = report;
  const out: string[] = [];
  const blank = () => out.push("");

  out.push(pc.bold(pc.cyan("AI Context Cost Audit")));
  out.push(pc.dim(`${meta.projectPath} · ${meta.scannedAt}`));
  blank();

  // 1. Guaranteed context by kind
  out.push(heading("Guaranteed context") + pc.dim("  (loaded on every request)"));
  const kindTotals = new Map<string, number>();
  for (const s of report.sources.filter((x) => x.usage === "guaranteed")) {
    kindTotals.set(s.kind, (kindTotals.get(s.kind) ?? 0) + s.tokens);
  }
  const kindRows = [...kindTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, tokens]) => [KIND_LABELS[kind] ?? kind, num(tokens)]);
  kindRows.push(["Repo total (CI-gated)", num(totals.gatedBaseline)]);
  if (totals.globalBaseline > 0) {
    kindRows.push(["Global user files (not gated)", num(totals.globalBaseline)]);
  }
  out.push(
    ...table(
      [
        { header: "Source kind", align: "left" },
        { header: "Tokens", align: "right" },
      ],
      kindRows,
      (line, i) => (i === kindTotals.size ? pc.bold(line) : line),
    ),
  );
  if (totals.conditional > 0) {
    blank();
    out.push(
      INDENT +
        pc.dim(
          `+ ${num(totals.conditional)} conditional tokens across ` +
            `${report.sources.filter((s) => s.usage === "conditional").length} sources (load for some tasks)`,
        ),
    );
  }
  blank();

  // 2. Per-tool baselines
  const consumers = CONSUMER_ORDER.filter((c) => totals.byConsumer[c] !== undefined);
  out.push(heading("Per-tool baselines"));
  out.push(
    ...table(
      [
        { header: "Tool", align: "left" },
        { header: "Repo", align: "right" },
        { header: "Global", align: "right" },
        { header: "Overhead", align: "right" },
        { header: "Total", align: "right" },
      ],
      consumers.map((c) => {
        const t = totals.byConsumer[c]!;
        return [CONSUMER_LABELS[c], num(t.gated), num(t.global), num(t.systemOverhead), num(t.total)];
      }),
      (line) => pc.bold(line),
    ),
  );
  out.push(
    ...wrap(
      `Overhead = the tool's own system prompt + built-in tools (estimates as of ` +
        `${meta.systemOverheadAsOf}; override via systemOverheadTokens). Costs below use each ` +
        `tool's Total — no request loads more than one tool's baseline.`,
      width,
      INDENT,
      INDENT,
    ).map((l) => pc.dim(l)),
  );
  blank();

  // 3. Cost per turn (input + output)
  const [aLo, aHi] = cfg.apiCallsPerTurn;
  const [oLo, oHi] = cfg.outputTokensPerTurn;
  out.push(heading("Cost per turn") + pc.dim(`  (${aLo}–${aHi} API calls/turn)`));
  out.push(
    ...table(
      [
        { header: "Tool", align: "left" },
        { header: "Model", align: "left" },
        { header: "Input uncached", align: "right" },
        { header: "Input cached", align: "right" },
        { header: "Output", align: "right" },
        { header: "Total/turn", align: "right" },
      ],
      costs.map((c) => [
        CONSUMER_LABELS[c.consumer],
        c.model,
        formatUSDRange(c.perTurnUncached),
        formatUSDRange(c.perTurnCached),
        formatUSDRange(c.outputPerTurn),
        formatUSDRange(c.totalPerTurn),
      ]),
    ),
  );
  out.push(
    INDENT +
      pc.dim(
        `A turn = 1 message + its API calls (each re-sends the baseline). Output = ` +
          `${num(oLo)}–${num(oHi)} tokens/turn, never cached. Total = cached input + output. ` +
          `Tune apiCallsPerTurn / outputTokensPerTurn.`,
      ),
  );
  blank();

  // 4. Daily projections, one compact table per tool: models x turn rates.
  out.push(heading("Daily projections") + pc.dim("  (all-in: cached input + output, per developer)"));
  const costsByConsumer = new Map<Consumer, ModelCost[]>();
  for (const c of costs) {
    const list = costsByConsumer.get(c.consumer) ?? [];
    list.push(c);
    costsByConsumer.set(c.consumer, list);
  }
  for (const consumer of consumers) {
    const consumerCosts = (costsByConsumer.get(consumer) ?? []).filter(
      (c) => c.perTurnUncached !== null,
    );
    if (consumerCosts.length === 0) continue;
    const rates = consumerCosts[0]!.daily.map((d) => d.turnsPerDay);
    out.push(INDENT + pc.bold(CONSUMER_LABELS[consumer]));
    out.push(
      ...table(
        [
          { header: "Model", align: "left" },
          ...rates.map((r) => ({ header: `${num(r)} turns/day`, align: "right" as const })),
        ],
        consumerCosts.map((c) => [
          c.model,
          ...c.daily.map((d) => `${formatUSDRange(d.cached ?? d.uncached)}/day`),
        ]),
      ),
    );
    const withRunway = consumerCosts.filter((c) => c.runwayDays !== null);
    if (withRunway.length > 0 && cfg.monthlyBudget !== null) {
      const sorted = [...cfg.turnsPerDay].sort((a, b) => a - b);
      const midRate = sorted[Math.floor(sorted.length / 2)]!;
      for (const c of withRunway) {
        out.push(
          INDENT +
            pc.dim(
              `$${cfg.monthlyBudget}/mo lasts ~${formatDays(c.runwayDays)} on ${c.model} ` +
                `at ${num(midRate)} turns/day` +
                (cfg.developers > 1 ? ` × ${cfg.developers} devs` : ""),
            ),
        );
      }
    }
    blank();
  }

  // 4b. Measured from local transcripts (ground truth), when --measure found data.
  const m = report.measured;
  if (m) {
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    out.push(
      heading("Measured from your usage") +
        pc.dim(`  (${m.sessions} session${m.sessions === 1 ? "" : "s"}, ${m.firstAt.slice(0, 10)}→${m.lastAt.slice(0, 10)})`),
    );
    const cfgCalls = `configured ${cfg.apiCallsPerTurn[0]}–${cfg.apiCallsPerTurn[1]}`;
    const cfgOut = `configured ${num(cfg.outputTokensPerTurn[0])}–${num(cfg.outputTokensPerTurn[1])}`;
    out.push(
      ...table(
        [
          { header: "Metric", align: "left" },
          { header: "Measured", align: "right" },
          { header: "vs configured", align: "left" },
        ],
        [
          ["Turns", num(m.turns), `${num(m.apiCalls)} API calls`],
          ["API calls/turn", statStr(m.apiCallsPerTurn), cfgCalls],
          ["Output tokens/turn", statStr(m.outputTokensPerTurn), cfgOut],
          ["Turns/day (active)", m.turnsPerDay.toFixed(1), `${m.activeDays} active days`],
          ["Cache read rate", pct(m.cacheReadRate), `TTL ${pct(m.ttlSplit["5m"])} 5m / ${pct(m.ttlSplit["1h"])} 1h`],
          ["Avg context/call", `${num(m.avgContextTokens)} tok`, "actual baseline + history"],
          ["Cost at API rates", formatUSD(m.actualCostUSD), `${formatUSD(m.actualCostPerTurn)}/turn`],
        ],
      ),
    );
    out.push(
      INDENT +
        pc.dim(`"Cost at API rates" is what this usage would cost pay-as-you-go; on a subscription you pay a flat fee (see Plan advisor).`),
    );
    // Reconciliation: estimated Claude Code total/turn vs measured actual/turn.
    const est = report.costs.find((c) => c.consumer === "claude-code" && c.totalPerTurn !== null);
    if (est) {
      out.push(
        INDENT +
          pc.dim(
            `Reconciliation: estimated ${formatUSDRange(est.totalPerTurn)}/turn (${est.model}) ` +
              `vs measured ${formatUSD(m.actualCostPerTurn)}/turn actual.`,
          ),
      );
    }
    if (m.unpricedCalls > 0) {
      out.push(INDENT + pc.dim(`${num(m.unpricedCalls)} call(s) used a model not in the pricing table (excluded from cost).`));
    }
    blank();

    // Forward projection from measured actual $/turn — the tailored forecast.
    const proj = projectMeasured(m, cfg);
    out.push(heading("Projected from your measured usage") + pc.dim(`  (at ${formatUSD(proj.perTurn)}/turn actual)`));
    out.push(
      ...table(
        [
          { header: "Turns/day/dev", align: "right" },
          { header: `Team $/day (${cfg.developers} dev${cfg.developers === 1 ? "" : "s"})`, align: "right" },
          { header: "≈ $/month", align: "right" },
        ],
        [
          ...proj.daily.map((d) => [num(d.turnsPerDay), `${formatUSD(d.teamPerDay)}/day`, formatUSD(d.teamPerDay * 30)]),
          [
            pc.bold(`${num(proj.measuredPace.turnsPerDay)} (measured)`),
            pc.bold(`${formatUSD(proj.measuredPace.teamPerDay)}/day`),
            pc.bold(formatUSD(proj.measuredPace.teamPerDay * 30)),
          ],
        ],
      ),
    );
    if (proj.runwayDays !== null && cfg.monthlyBudget !== null) {
      out.push(
        INDENT +
          pc.dim(
            `At your measured pace (~${num(proj.measuredPace.turnsPerDay)} turns/day/dev × ${cfg.developers} dev${cfg.developers === 1 ? "" : "s"}), ` +
              `$${cfg.monthlyBudget}/mo budget lasts ~${proj.runwayDays.toFixed(1)} days.`,
          ),
      );
    }
    blank();
  }

  // 4d. Plan advisor: subscription vs API pay-as-you-go, per developer.
  const advice = report.planAdvice;
  if (advice) {
    out.push(heading("Plan advisor") + pc.dim(`  (per developer, at ${formatUSD(advice.apiEquivMonthly)}/mo API-equivalent)`));
    out.push(
      ...table(
        [
          { header: "Option", align: "left" },
          { header: "$/month", align: "right" },
          { header: "", align: "left" },
        ],
        advice.options.map((o) => [
          o.label,
          o.isApi ? `${formatUSD(o.monthlyUSD)}*` : formatUSD(o.monthlyUSD),
          [o.isCurrent ? "current" : "", o.id === advice.cheapest.id ? "← cheapest" : ""]
            .filter(Boolean)
            .join(" "),
        ]),
      ),
    );
    for (const line of planRecommendation(advice)) {
      out.push(INDENT + line);
    }
    out.push(
      INDENT +
        pc.dim(
          `*API scales with usage. Plan prices are dated estimates (as of ${advice.asOf}); limits are ` +
            `not published as token quotas, so heavy usage may throttle — verify and set config.plan.`,
        ),
    );
    blank();
  }

  // 5. Typical context per API call
  out.push(heading("Typical context per API call") + pc.dim("  (baseline + variable context)"));
  for (const consumer of consumers) {
    const range = report.requestRanges[consumer];
    if (!range) continue;
    out.push(
      INDENT + `${CONSUMER_LABELS[consumer]}: ` + pc.bold(`${num(range.min)}–${num(range.max)}`) + " input tokens",
    );
  }
  out.push(
    INDENT +
      pc.dim(
        `Variable context is a configured range (history ${num(cfg.variable.conversationHistory[0])}–` +
          `${num(cfg.variable.conversationHistory[1])}, task files ${num(cfg.variable.taskFiles[0])}–` +
          `${num(cfg.variable.taskFiles[1])}), not a measurement.`,
      ),
  );
  blank();

  // 6. Findings
  out.push(heading("Findings"));
  if (findings.length === 0) {
    out.push(INDENT + pc.green("None. Baseline looks lean."));
  } else {
    const sevColor: Record<string, (s: string) => string> = {
      error: pc.red,
      warn: pc.yellow,
      info: pc.blue,
    };
    findings.forEach((f, i) => {
      const n = `${i + 1}.`.padEnd(3);
      const tag = sevColor[f.severity]!(`[${f.severity}]`);
      const first = `${INDENT}${n}${tag} ${pc.bold(f.rule)} — `;
      // Wrap on plain length; the ANSI prefix is applied to line one only.
      const plainPrefix = `${INDENT}${n}[${f.severity}] ${f.rule} — `;
      const rest = INDENT + " ".repeat(4);
      const body = wrap(f.message, width, " ".repeat(plainPrefix.length), rest);
      out.push(first + (body[0]?.trim() ?? ""));
      out.push(...body.slice(1));
    });
  }
  blank();

  // 7. Sources
  out.push(heading("All discovered sources"));
  const pathWidth = Math.max(30, width - 62);
  out.push(
    ...table(
      [
        { header: "Path", align: "left" },
        { header: "Kind", align: "left" },
        { header: "Usage", align: "left" },
        { header: "Tools", align: "left" },
        { header: "Tokens", align: "right" },
        { header: "Conf", align: "left" },
      ],
      [...report.sources]
        .sort((a, b) => b.tokens - a.tokens)
        .map((s) => [
          elide(s.path, pathWidth),
          s.kind,
          s.usage,
          s.consumers.join(","),
          num(s.tokens),
          s.confidence,
        ]),
    ),
  );
  blank();

  // Footer
  out.push(
    ...wrap(meta.disclosure, width, INDENT, INDENT).map((l) => pc.dim(l)),
  );
  const calibrationLine =
    `Calibration: ${Object.entries(meta.calibration)
      .map(([provider, factor]) => `${provider} ×${factor}`)
      .join(", ")} · pricing as of ${meta.pricingAsOf} (${meta.pricingOrigin})` +
    (meta.pricingStale ? " STALE — --refresh-pricing or override" : "") +
    ` · ${meta.tool} v${meta.version}`;
  out.push(
    ...wrap(calibrationLine, width, INDENT, INDENT).map((l) =>
      meta.pricingStale ? pc.yellow(l) : pc.dim(l),
    ),
  );

  return out.join("\n") + "\n";
}
