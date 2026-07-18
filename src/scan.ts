import path from "node:path";
import type { Config, ConsumerTotals, ContextSource, Report, Snapshot } from "./types.js";
import { CONSUMER_ORDER, resolveSystemOverhead, SYSTEM_OVERHEAD_AS_OF } from "./consumers.js";
import { discoverAll } from "./adapters/index.js";
import { findDuplicates } from "./analysis/duplication.js";
import { deriveFindings } from "./analysis/findings.js";
import { computeCosts, cacheFormulaDescription } from "./costModel.js";
import { isPricingStale, relevantProviders, resolveModels, resolveProvider } from "./pricing.js";
import { bundledPricing, type ResolvedPricing } from "./pricingStore.js";
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
  pricing: ResolvedPricing = { table: bundledPricing(), origin: "bundled", source: bundledPricing().source },
): Promise<ScanResult> {
  const now = new Date();
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

  // Per-tool baselines: a request goes through exactly one tool, so costs and
  // request ranges are computed from each consumer's own baseline, never from
  // the cross-tool union.
  const consumersPresent = CONSUMER_ORDER.filter((consumer) =>
    sources.some((s) => s.consumers.includes(consumer)),
  );
  const byConsumer: Record<string, ConsumerTotals> = {};
  for (const consumer of consumersPresent) {
    const gated = sum(repoGuaranteed.filter((s) => s.consumers.includes(consumer)));
    const global = sum(globalGuaranteed.filter((s) => s.consumers.includes(consumer)));
    const guaranteed = gated + global;
    const systemOverhead = resolveSystemOverhead(consumer, cfg);
    byConsumer[consumer] = {
      gated,
      global,
      guaranteed,
      systemOverhead,
      total: guaranteed + systemOverhead,
    };
  }

  // Source tokens are estimated on the anthropic calibration basis. Re-derive
  // per-provider baselines by backing out to the raw o200k count. System
  // overhead is a native-token estimate, so it joins after calibration.
  const anthropicCalibration = resolveProvider("anthropic", cfg).calibration;
  const models = resolveModels(cfg, pricing.table, now);
  const providers = relevantProviders(cfg, models);
  const baselineForProviders = (
    fileTokens: number,
    overheadTokens: number,
  ): Record<string, number> => {
    const raw = fileTokens / anthropicCalibration;
    const result: Record<string, number> = {};
    for (const provider of providers) {
      result[provider] =
        Math.round(raw * resolveProvider(provider, cfg).calibration) + overheadTokens;
    }
    return result;
  };

  const duplicates = findDuplicates(sources, cfg);
  const findings = deriveFindings(sources, duplicates, gatedBaseline, snapshot, cfg);
  const costs = consumersPresent.flatMap((consumer) => {
    const totals = byConsumer[consumer]!;
    return computeCosts(
      consumer,
      baselineForProviders(totals.guaranteed, totals.systemOverhead),
      cfg,
      models,
    );
  });

  const requestRanges: Record<string, { min: number; max: number }> = {};
  for (const consumer of consumersPresent) {
    const base = byConsumer[consumer]!.total;
    requestRanges[consumer] = {
      min: base + cfg.variable.conversationHistory[0] + cfg.variable.taskFiles[0],
      max: base + cfg.variable.conversationHistory[1] + cfg.variable.taskFiles[1],
    };
  }

  const calibration: Record<string, number> = {};
  for (const provider of providers) {
    calibration[provider] = resolveProvider(provider, cfg).calibration;
  }

  const report: Report = {
    meta: {
      tool: TOOL_NAME,
      version: TOOL_VERSION,
      scannedAt: new Date().toISOString(),
      projectPath: path.resolve(projectPath),
      pricingAsOf: pricing.table.asOf,
      pricingStale: isPricingStale(pricing.table.asOf, now),
      pricingOrigin: pricing.origin,
      pricingSource: pricing.source,
      systemOverheadAsOf: SYSTEM_OVERHEAD_AS_OF,
      calibration,
      cacheFormula: cacheFormulaDescription(cfg),
      disclosure: DISCLOSURE,
    },
    totals: {
      gatedBaseline,
      globalBaseline,
      guaranteed,
      conditional: sum(conditional),
      byConsumer,
      byKind,
      byAdapter,
    },
    sources: sources.map(({ text: _text, ...rest }) => rest),
    costs,
    requestRanges,
    findings,
  };

  return { report, sources };
}
