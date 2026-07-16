import type { Config, ContextSource, Snapshot } from "./types.js";
import { topGrowthCauses } from "./analysis/findings.js";

/** Exit codes: 0 = pass, 1 = budget/growth violation, 2 = execution error. */
export const EXIT_PASS = 0;
export const EXIT_VIOLATION = 1;
export const EXIT_ERROR = 2;

export interface GateResult {
  pass: boolean;
  messages: string[];
}

/**
 * CI gate over the repo-scoped baseline only — global user files are excluded
 * so local and CI runs agree.
 */
export function evaluateBudget(
  gatedBaseline: number,
  sources: ContextSource[],
  snapshot: Snapshot | null,
  cfg: Config,
): GateResult {
  const messages: string[] = [];
  let pass = true;

  if (cfg.baselineTokenLimit !== null && gatedBaseline > cfg.baselineTokenLimit) {
    pass = false;
    messages.push(
      `AI context budget failed: baseline ${gatedBaseline.toLocaleString()} tokens exceeds ` +
        `limit ${cfg.baselineTokenLimit.toLocaleString()}.`,
    );
  }

  if (snapshot && snapshot.gatedBaseline > 0) {
    const growthPct =
      ((gatedBaseline - snapshot.gatedBaseline) / snapshot.gatedBaseline) * 100;
    if (growthPct > cfg.growthThresholdPct) {
      pass = false;
      const causes = topGrowthCauses(sources, snapshot);
      messages.push(
        `AI context budget failed: baseline grew ${growthPct.toFixed(0)}% ` +
          `(threshold ${cfg.growthThresholdPct}%).\n` +
          `  Previous: ${snapshot.gatedBaseline.toLocaleString()} tokens\n` +
          `  Current:  ${gatedBaseline.toLocaleString()} tokens\n` +
          `  Change:   ${growthPct >= 0 ? "+" : ""}${growthPct.toFixed(0)}%` +
          (causes.length > 0 ? `\n  Primary cause: ${causes.join("; ")}` : ""),
      );
    } else {
      messages.push(
        `Baseline vs snapshot: ${snapshot.gatedBaseline.toLocaleString()} → ` +
          `${gatedBaseline.toLocaleString()} tokens ` +
          `(${growthPct >= 0 ? "+" : ""}${growthPct.toFixed(1)}%, within ${cfg.growthThresholdPct}% threshold).`,
      );
    }
  } else if (!snapshot) {
    messages.push(
      `No snapshot found (${cfg.growthThresholdPct}% growth check skipped). ` +
        `Run \`ai-cost-audit scan --update-snapshot\` and commit .ai-cost-audit/snapshot.json.`,
    );
  }

  if (pass && cfg.baselineTokenLimit !== null) {
    messages.push(
      `Baseline ${gatedBaseline.toLocaleString()} tokens within limit ` +
        `${cfg.baselineTokenLimit.toLocaleString()}.`,
    );
  }

  return { pass, messages };
}
