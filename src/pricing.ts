import type { Config, ModelPricing, ProviderInfo } from "./types.js";

/**
 * A dated price for a model, optionally bounded to an effective window.
 * A rate with no `from`/`until` is a catch-all and must be listed last.
 */
export interface Rate {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Inclusive start date (YYYY-MM-DD). Absent = no lower bound. */
  from?: string;
  /** Inclusive end date (YYYY-MM-DD). Absent = no upper bound. */
  until?: string;
}

export interface PricingModel {
  id: string;
  provider: string;
  rates: Rate[];
  note?: string;
}

/**
 * The pricing data contract. Shipped as data (src/data/pricing.json) rather
 * than code so prices can be updated — or refreshed from a URL — without a
 * code release. `asOf` drives the staleness warning; `source` is disclosed.
 */
export interface PricingTable {
  asOf: string;
  source: string;
  models: PricingModel[];
}

/** Days after which the report prints a staleness warning. */
export const PRICING_STALE_AFTER_DAYS = 90;

/**
 * Provider tokenizer calibration and cache economics. These stay in code, not
 * the pricing data file: calibration is our offline-estimation heuristic (not
 * a published price), and cache multipliers are structural and effectively
 * constant. Both remain overridable via config.
 */
export const PROVIDERS: Record<string, ProviderInfo> = {
  anthropic: {
    // o200k_base undercounts Claude tokens on typical instruction text;
    // Claude counts are roughly 1.15-1.25x the o200k count.
    calibration: 1.2,
    // Prompt-cache multipliers relative to base input price (5-minute TTL).
    cache: { write: 1.25, read: 0.1 },
  },
  openai: {
    calibration: 1.0,
    // No cache modeling seeded; OpenAI's automatic caching differs — users can
    // approximate via pricingOverrides + a custom provider entry later.
  },
};

/** Truncate a Date to a YYYY-MM-DD string (UTC) for lexicographic comparison. */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isPricingStale(asOf: string, now: Date = new Date()): boolean {
  const asOfMs = new Date(asOf).getTime();
  if (Number.isNaN(asOfMs)) return false;
  const ageDays = (now.getTime() - asOfMs) / (1000 * 60 * 60 * 24);
  return ageDays > PRICING_STALE_AFTER_DAYS;
}

/**
 * Resolve the rate in effect on `date`. ISO YYYY-MM-DD strings compare
 * lexicographically, so no date parsing is needed. First matching rate wins;
 * authors list bounded (promo) windows before the unbounded catch-all.
 */
export function resolveRate(model: PricingModel, date: Date): Rate | null {
  const day = isoDate(date);
  for (const rate of model.rates) {
    if (rate.from && day < rate.from) continue;
    if (rate.until && day > rate.until) continue;
    return rate;
  }
  return null;
}

/**
 * Resolve the pricing rows for the models named in config, applying overrides
 * and picking each model's rate for `date`. Returns the flattened per-MTok
 * numbers the cost model consumes.
 */
export function resolveModels(
  cfg: Config,
  table: PricingTable,
  date: Date = new Date(),
): ModelPricing[] {
  return cfg.models.map((id) => {
    const base = table.models.find((m) => m.id === id);
    const override = cfg.pricingOverrides[id];
    if (!base && !override) {
      return {
        id,
        provider: "unknown",
        inputPerMTok: null,
        outputPerMTok: null,
        note: "unknown model — set pricing via config.pricingOverrides",
      };
    }
    const rate = base ? resolveRate(base, date) : null;
    // Custom models default to an "unknown" provider (calibration 1.0, no cache
    // modeling); override.provider attaches them to a known provider's
    // calibration and cache behavior.
    return {
      id,
      provider: override?.provider ?? base?.provider ?? "unknown",
      inputPerMTok: override?.inputPerMTok ?? rate?.inputPerMTok ?? null,
      outputPerMTok: override?.outputPerMTok ?? rate?.outputPerMTok ?? null,
      note: base?.note,
    };
  });
}

/**
 * Every provider a cost figure could be computed for: the configured provider
 * list plus any provider referenced by a resolved model. Without the union,
 * a custom model with pricing set silently gets no baseline (and no cost).
 */
export function relevantProviders(cfg: Config, models: ModelPricing[]): string[] {
  const providers = new Set(cfg.providers);
  for (const model of models) providers.add(model.provider);
  return [...providers];
}

/** Resolve provider info (calibration + cache), applying config calibration overrides. */
export function resolveProvider(name: string, cfg: Config): ProviderInfo {
  const base = PROVIDERS[name] ?? { calibration: 1.0 };
  const calibration = cfg.calibration[name] ?? base.calibration;
  return { ...base, calibration };
}
