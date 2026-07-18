import type { Config, Consumer, DailyProjection, ModelCost, ModelPricing, MoneyRange } from "./types.js";
import { resolveProvider } from "./pricing.js";

/**
 * Steady-state effective input-price multiplier under prompt caching over a
 * session of `apiCalls` total API calls: the first call pays the cache-write
 * multiplier, the remaining (apiCalls-1) pay the cache-read multiplier.
 *
 *   effective = (write + read * (apiCalls - 1)) / apiCalls
 */
export function cacheEffectiveMultiplier(
  write: number,
  read: number,
  apiCalls: number,
): number {
  const n = Math.max(1, apiCalls);
  return (write + read * (n - 1)) / n;
}

export function cacheFormulaDescription(cfg: Config): string {
  const t = cfg.cache.turnsPerSession;
  const [aLo, aHi] = cfg.apiCallsPerTurn;
  return (
    `a user turn = 1 message + its ${aLo}-${aHi} API calls (tool-use round trips); each call ` +
    `re-sends the baseline. cached cost/turn = per_call_input_cost x calls x (write + read x (S-1)) / S, ` +
    `S = calls x ${t} turns/session (anthropic: write 1.25x, read 0.1x, 5-min TTL)`
  );
}

/** Cached cost of one turn at a given API-calls-per-turn count. */
function cachedPerTurn(
  perCallUncached: number,
  apiCallsPerTurn: number,
  write: number,
  read: number,
  turnsPerSession: number,
): number {
  const sessionCalls = Math.max(1, apiCallsPerTurn * turnsPerSession);
  const mult = cacheEffectiveMultiplier(write, read, sessionCalls);
  return perCallUncached * apiCallsPerTurn * mult;
}

/**
 * Cost of one consumer's guaranteed baseline, per model. Input-side only —
 * baseline context is always input. A user turn triggers several API calls,
 * each re-sending the baseline, so costs are per-turn ranges spanning the
 * apiCallsPerTurn [min, max]. Token counts are passed per provider (each
 * provider's own calibration applied upstream).
 */
export function computeCosts(
  consumer: Consumer,
  baselineTokensByProvider: Record<string, number>,
  cfg: Config,
  models: ModelPricing[],
): ModelCost[] {
  const [aLo, aHi] = cfg.apiCallsPerTurn;
  const t = cfg.cache.turnsPerSession;

  return models.map((model) => {
    const tokens = baselineTokensByProvider[model.provider] ?? null;
    if (tokens === null || model.inputPerMTok === null) {
      return {
        consumer,
        model: model.id,
        provider: model.provider,
        perTurnUncached: null,
        perTurnCached: null,
        daily: cfg.turnsPerDay.map((turnsPerDay) => ({
          turnsPerDay,
          uncached: null,
          cached: null,
        })),
        runwayDays: null,
      };
    }

    const perCallUncached = (tokens / 1_000_000) * model.inputPerMTok;
    // Uncached: every API call pays the full baseline, so cost scales linearly
    // with calls-per-turn.
    const perTurnUncached: MoneyRange = {
      min: perCallUncached * aLo,
      max: perCallUncached * aHi,
    };

    const provider = resolveProvider(model.provider, cfg);
    let perTurnCached: MoneyRange | null = null;
    if (cfg.cache.enabled && provider.cache) {
      const { write, read } = provider.cache;
      // Cost per turn is linear in calls-per-turn, so endpoints bound the range.
      perTurnCached = {
        min: cachedPerTurn(perCallUncached, aLo, write, read, t),
        max: cachedPerTurn(perCallUncached, aHi, write, read, t),
      };
    }

    const scale = (range: MoneyRange | null, factor: number): MoneyRange | null =>
      range === null ? null : { min: range.min * factor, max: range.max * factor };

    const daily: DailyProjection[] = cfg.turnsPerDay.map((turnsPerDay) => ({
      turnsPerDay,
      uncached: scale(perTurnUncached, turnsPerDay),
      cached: scale(perTurnCached, turnsPerDay),
    }));

    // Runway: how many days the monthly budget lasts at the middle turns/day
    // scenario (per developer, times team size), using the cached figure when
    // available. Higher cost (max) → shorter runway (min days), and vice versa.
    let runwayDays: MoneyRange | null = null;
    if (cfg.monthlyBudget !== null && cfg.turnsPerDay.length > 0) {
      const sorted = [...cfg.turnsPerDay].sort((a, b) => a - b);
      const midRate = sorted[Math.floor(sorted.length / 2)]!;
      const cost = perTurnCached ?? perTurnUncached;
      const perDayMin = cost.min * midRate * cfg.developers;
      const perDayMax = cost.max * midRate * cfg.developers;
      if (perDayMin > 0 && perDayMax > 0) {
        runwayDays = {
          min: cfg.monthlyBudget / perDayMax,
          max: cfg.monthlyBudget / perDayMin,
        };
      }
    }

    return {
      consumer,
      model: model.id,
      provider: model.provider,
      perTurnUncached,
      perTurnCached,
      daily,
      runwayDays,
    };
  });
}
