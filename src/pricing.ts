import type { Config, ModelPricing, ProviderInfo } from "./types.js";

/**
 * Seed pricing table. Date-stamped so reports can warn when stale.
 * All values overridable via config.pricingOverrides.
 */
export const PRICING_AS_OF = "2026-07-01";

/** Days after which the report prints a staleness warning. */
export const PRICING_STALE_AFTER_DAYS = 90;

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

export const MODELS: ModelPricing[] = [
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
    inputPerMTok: 5.0,
    outputPerMTok: 25.0,
  },
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    inputPerMTok: 3.0,
    outputPerMTok: 15.0,
    note: "intro pricing $2/$10 per MTok through 2026-08-31",
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    inputPerMTok: 1.0,
    outputPerMTok: 5.0,
  },
  {
    id: "gpt",
    provider: "openai",
    inputPerMTok: null,
    outputPerMTok: null,
    note: "set inputPerMTok via config.pricingOverrides.gpt",
  },
];

export function isPricingStale(now: Date = new Date()): boolean {
  const asOf = new Date(PRICING_AS_OF);
  const ageDays = (now.getTime() - asOf.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays > PRICING_STALE_AFTER_DAYS;
}

/** Resolve the pricing rows for the models named in config, applying overrides. */
export function resolveModels(cfg: Config): ModelPricing[] {
  return cfg.models.map((id) => {
    const base = MODELS.find((m) => m.id === id);
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
    // Custom models default to an "unknown" provider (calibration 1.0, no cache
    // modeling); override.provider attaches them to a known provider's
    // calibration and cache behavior.
    return {
      id,
      provider: override?.provider ?? base?.provider ?? "unknown",
      inputPerMTok: override?.inputPerMTok ?? base?.inputPerMTok ?? null,
      outputPerMTok: override?.outputPerMTok ?? base?.outputPerMTok ?? null,
      note: base?.note,
    };
  });
}

/**
 * Every provider a cost figure could be computed for: the configured provider
 * list plus any provider referenced by a resolved model. Without the union,
 * a custom model with pricing set silently gets no baseline (and no cost).
 */
export function relevantProviders(cfg: Config): string[] {
  const providers = new Set(cfg.providers);
  for (const model of resolveModels(cfg)) providers.add(model.provider);
  return [...providers];
}

/** Resolve provider info (calibration + cache), applying config calibration overrides. */
export function resolveProvider(name: string, cfg: Config): ProviderInfo {
  const base = PROVIDERS[name] ?? { calibration: 1.0 };
  const calibration = cfg.calibration[name] ?? base.calibration;
  return { ...base, calibration };
}
