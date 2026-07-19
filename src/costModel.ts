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
  const [oLo, oHi] = cfg.outputTokensPerTurn;
  return (
    `a user turn = 1 message + its ${aLo}-${aHi} API calls (tool-use round trips); each call ` +
    `re-sends the baseline. cached input/turn = per_call_input_cost x calls x (write + read x (S-1)) / S, ` +
    `S = calls x ${t} turns/session (anthropic: write 1.25x, read 0.1x, 5-min TTL). ` +
    `output/turn = ${oLo}-${oHi} tokens x output_price (never cached); total = cached input + output`
  );
}

/** Sum two money ranges, or null if either is null. */
function addRanges(a: MoneyRange | null, b: MoneyRange | null): MoneyRange | null {
  if (a === null) return b;
  if (b === null) return a;
  return { min: a.min + b.min, max: a.max + b.max };
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
  const [oLo, oHi] = cfg.outputTokensPerTurn;
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
        outputPerTurn: null,
        totalPerTurn: null,
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

    // Output tokens are generated fresh each turn — never cached, always at the
    // full output price.
    let outputPerTurn: MoneyRange | null = null;
    if (model.outputPerMTok !== null) {
      outputPerTurn = {
        min: (oLo / 1_000_000) * model.outputPerMTok,
        max: (oHi / 1_000_000) * model.outputPerMTok,
      };
    }

    // All-in per turn: realistic cached input (or uncached if no cache) + output.
    const totalPerTurn = addRanges(perTurnCached ?? perTurnUncached, outputPerTurn);

    const scale = (range: MoneyRange | null, factor: number): MoneyRange | null =>
      range === null ? null : { min: range.min * factor, max: range.max * factor };

    // Daily projections use the all-in total. "cached" = total with caching,
    // "uncached" = total without caching (both include output).
    const totalUncached = addRanges(perTurnUncached, outputPerTurn)!;
    const daily: DailyProjection[] = cfg.turnsPerDay.map((turnsPerDay) => ({
      turnsPerDay,
      uncached: scale(totalUncached, turnsPerDay),
      cached: scale(totalPerTurn, turnsPerDay),
    }));

    // Runway: how many days the monthly budget lasts at the middle turns/day
    // scenario (per developer, times team size), using the all-in total. Higher
    // cost (max) → shorter runway (min days), and vice versa.
    let runwayDays: MoneyRange | null = null;
    if (cfg.monthlyBudget !== null && cfg.turnsPerDay.length > 0 && totalPerTurn !== null) {
      const sorted = [...cfg.turnsPerDay].sort((a, b) => a - b);
      const midRate = sorted[Math.floor(sorted.length / 2)]!;
      const perDayMin = totalPerTurn.min * midRate * cfg.developers;
      const perDayMax = totalPerTurn.max * midRate * cfg.developers;
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
      outputPerTurn,
      totalPerTurn,
      daily,
      runwayDays,
    };
  });
}
