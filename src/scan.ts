import path from "node:path";
import type { Config, ContextSource, Report, Snapshot } from "./types.js";
import { discoverAll } from "./adapters/index.js";
import { findDuplicates } from "./analysis/duplication.js";
import { deriveFindings } from "./analysis/findings.js";
import { computeCosts, cacheFormulaDescription } from "./costModel.js";
import { isPricingStale, PRICING_AS_OF, resolveProvider } from "./pricing.js";
import { DISCLOSURE } from "./tokenizer.js";

export const TOOL_NAME = "ai-cost-audit";
export const TOOL_VERSION = "0.1.0";

export interface ScanResult {
  report: Report;
  sources: ContextSource[];
}

export async function runScan(
  projectPath: string,
  cfg: Config,
  snapshot: Snapshot | null,
): Promise<ScanResult> {
  const sources = await discoverAll(projectPath, cfg);

  const repoGuaranteed = sources.filter((s) => s.scope === "repo" && s.usage === "guaranteed");
  const globalGuaranteed = sources.filter(
    (s) => s.scope === "global" && s.usage === "guaranteed",
  );
  const conditional = sources.filter((s) => s.usage === "conditional");

  const sum = (list: ContextSource[]) => list.reduce((total, s) => total + s.tokens, 0);
  const gatedBaseline = sum(repoGuaranteed);
  const globalBaseline = sum(globalGuaranteed);
  const guaranteed = gatedBaseline + globalBaseline;

  const byKind: Record<string, number> = {};
  const byAdapter: Record<string, number> = {};
  for (const s of sources) {
    byKind[s.kind] = (byKind[s.kind] ?? 0) + s.tokens;
    byAdapter[s.adapter] = (byAdapter[s.adapter] ?? 0) + s.tokens;
  }

  // Source tokens are estimated on the anthropic calibration basis. Re-derive
  // per-provider baselines by backing out to the raw o200k count.
  const anthropicCalibration = resolveProvider("anthropic", cfg).calibration;
  const rawBaseline = guaranteed / anthropicCalibration;
  const baselineByProvider: Record<string, number> = {};
  for (const provider of cfg.providers) {
    baselineByProvider[provider] = Math.round(
      rawBaseline * resolveProvider(provider, cfg).calibration,
    );
  }

  const duplicates = findDuplicates(sources, cfg);
  const findings = deriveFindings(sources, duplicates, gatedBaseline, snapshot, cfg);
  const costs = computeCosts(baselineByProvider, cfg);

  const requestRange = {
    min: guaranteed + cfg.variable.conversationHistory[0] + cfg.variable.taskFiles[0],
    max: guaranteed + cfg.variable.conversationHistory[1] + cfg.variable.taskFiles[1],
  };

  const calibration: Record<string, number> = {};
  for (const provider of cfg.providers) {
    calibration[provider] = resolveProvider(provider, cfg).calibration;
  }

  const report: Report = {
    meta: {
      tool: TOOL_NAME,
      version: TOOL_VERSION,
      scannedAt: new Date().toISOString(),
      projectPath: path.resolve(projectPath),
      pricingAsOf: PRICING_AS_OF,
      pricingStale: isPricingStale(),
      calibration,
      cacheFormula: cacheFormulaDescription(cfg),
      disclosure: DISCLOSURE,
    },
    totals: {
      gatedBaseline,
      globalBaseline,
      guaranteed,
      conditional: sum(conditional),
      byKind,
      byAdapter,
    },
    sources: sources.map(({ text: _text, ...rest }) => rest),
    costs,
    requestRange,
    findings,
  };

  return { report, sources };
}
