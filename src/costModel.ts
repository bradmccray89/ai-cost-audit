import type { Config, ModelCost } from "./types.js";
import { resolveModels, resolveProvider } from "./pricing.js";

/**
 * Steady-state effective input-price multiplier under prompt caching:
 * the first request of a session pays the cache-write multiplier, the
 * remaining (n-1) requests pay the cache-read multiplier.
 *
 *   effective = (write + read * (n - 1)) / n
 */
export function cacheEffectiveMultiplier(
  write: number,
  read: number,
  requestsPerSession: number,
): number {
  const n = Math.max(1, requestsPerSession);
  return (write + read * (n - 1)) / n;
}

export function cacheFormulaDescription(cfg: Config): string {
  const n = cfg.cache.requestsPerSession;
  return (
    `cached cost/request = baseline_tokens x input_price x (write + read x (n-1)) / n, ` +
    `with n = ${n} requests/session (anthropic: write 1.25x, read 0.1x, 5-min TTL)`
  );
}

/**
 * Cost of the guaranteed baseline, per model. Input-side only — baseline
 * context is always input. `gatedTokens` are the calibrated Anthropic-basis
 * estimates; for non-anthropic providers we re-derive from the raw basis via
 * the provider's own calibration handled upstream (tokens passed per provider).
 */
export function computeCosts(
  baselineTokensByProvider: Record<string, number>,
  cfg: Config,
): ModelCost[] {
  return resolveModels(cfg).map((model) => {
    const tokens = baselineTokensByProvider[model.provider] ?? null;
    if (tokens === null || model.inputPerMTok === null) {
      return {
        model: model.id,
        provider: model.provider,
        perRequestUncached: null,
        perRequestCached: null,
        daily: cfg.requestsPerDay.map((r) => ({
          requestsPerDay: r,
          uncached: null,
          cached: null,
        })),
        runwayDays: null,
      };
    }

    const perRequestUncached = (tokens / 1_000_000) * model.inputPerMTok;

    const provider = resolveProvider(model.provider, cfg);
    let perRequestCached: number | null = null;
    if (cfg.cache.enabled && provider.cache) {
      const mult = cacheEffectiveMultiplier(
        provider.cache.write,
        provider.cache.read,
        cfg.cache.requestsPerSession,
      );
      perRequestCached = perRequestUncached * mult;
    }

    const daily = cfg.requestsPerDay.map((requestsPerDay) => ({
      requestsPerDay,
      uncached: perRequestUncached * requestsPerDay,
      cached: perRequestCached === null ? null : perRequestCached * requestsPerDay,
    }));

    // Runway: how many days the monthly budget lasts at the middle
    // requests/day scenario (per developer, times team size), using the
    // cached figure when available.
    let runwayDays: number | null = null;
    if (cfg.monthlyBudget !== null && cfg.requestsPerDay.length > 0) {
      const sorted = [...cfg.requestsPerDay].sort((a, b) => a - b);
      const midRate = sorted[Math.floor(sorted.length / 2)]!;
      const perDay = (perRequestCached ?? perRequestUncached) * midRate * cfg.developers;
      if (perDay > 0) runwayDays = cfg.monthlyBudget / perDay;
    }

    return {
      model: model.id,
      provider: model.provider,
      perRequestUncached,
      perRequestCached,
      daily,
      runwayDays,
    };
  });
}
