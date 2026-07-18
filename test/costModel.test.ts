import { describe, expect, it } from "vitest";
import { cacheEffectiveMultiplier, computeCosts } from "../src/costModel.js";
import { resolveModels } from "../src/pricing.js";
import { bundledPricing } from "../src/pricingStore.js";
import type { Config } from "../src/types.js";
import { makeConfig } from "./helpers.js";

/** Resolve the configured models against bundled prices at a fixed date. */
function modelsFor(cfg: Config) {
  return resolveModels(cfg, bundledPricing(), new Date("2026-07-18"));
}

describe("cacheEffectiveMultiplier", () => {
  it("matches the documented formula at n=10", () => {
    // (1.25 + 0.1 * 9) / 10 = 2.15 / 10 = 0.215
    expect(cacheEffectiveMultiplier(1.25, 0.1, 10)).toBeCloseTo(0.215, 10);
  });

  it("equals the write multiplier at n=1", () => {
    expect(cacheEffectiveMultiplier(1.25, 0.1, 1)).toBeCloseTo(1.25, 10);
  });

  it("approaches the read multiplier as n grows", () => {
    expect(cacheEffectiveMultiplier(1.25, 0.1, 1000)).toBeCloseTo(0.10115, 5);
  });
});

describe("computeCosts", () => {
  it("reduces to the single-call model at apiCallsPerTurn = [1, 1]", async () => {
    const cfg = await makeConfig({
      models: ["claude-opus-4-8"],
      providers: ["anthropic"],
      turnsPerDay: [100],
      apiCallsPerTurn: [1, 1],
      cache: { enabled: true, turnsPerSession: 10 },
      monthlyBudget: null,
    });
    const costs = computeCosts("claude-code", { anthropic: 100_000 }, cfg, modelsFor(cfg));
    expect(costs).toHaveLength(1);
    const c = costs[0]!;
    // 100k tokens at $5/MTok = $0.50 per call; 1 call/turn -> $0.50 uncached.
    expect(c.perTurnUncached!.min).toBeCloseTo(0.5, 10);
    expect(c.perTurnUncached!.max).toBeCloseTo(0.5, 10);
    // Session API calls S = 1 * 10 = 10 -> multiplier (1.25 + 0.1*9)/10 = 0.215.
    expect(c.perTurnCached!.min).toBeCloseTo(0.1075, 10);
    expect(c.daily[0]!.cached!.min).toBeCloseTo(10.75, 10);
  });

  it("scales per-turn cost with the apiCallsPerTurn range", async () => {
    const cfg = await makeConfig({
      models: ["claude-opus-4-8"],
      providers: ["anthropic"],
      turnsPerDay: [100],
      apiCallsPerTurn: [1, 10],
      cache: { enabled: true, turnsPerSession: 10 },
      monthlyBudget: null,
    });
    const c = computeCosts("claude-code", { anthropic: 100_000 }, cfg, modelsFor(cfg))[0]!;
    // Uncached: 1 call -> $0.50, 10 calls -> $5.00.
    expect(c.perTurnUncached!.min).toBeCloseTo(0.5, 10);
    expect(c.perTurnUncached!.max).toBeCloseTo(5.0, 10);
    // Cached at 10 calls/turn: S = 10*10 = 100, mult = (1.25 + 0.1*99)/100 = 0.11150.
    // perTurn = 0.5 * 10 * 0.11150 = 0.5575.
    expect(c.perTurnCached!.max).toBeCloseTo(0.5575, 6);
    // Max cost is well above the single-call cached figure — the correction.
    expect(c.perTurnCached!.max).toBeGreaterThan(c.perTurnCached!.min);
  });

  it("computes a budget runway range from the middle turns/day scenario", async () => {
    const cfg = await makeConfig({
      models: ["claude-opus-4-8"],
      providers: ["anthropic"],
      turnsPerDay: [50, 200, 1000],
      apiCallsPerTurn: [1, 1],
      cache: { enabled: true, turnsPerSession: 10 },
      monthlyBudget: 100,
      developers: 1,
    });
    const c = computeCosts("claude-code", { anthropic: 100_000 }, cfg, modelsFor(cfg))[0]!;
    // Cached per turn 0.1075; mid scenario 200 turns/day -> $21.50/day.
    // At [1,1] the range collapses: runway = 100 / 21.5 ≈ 4.651 days.
    expect(c.runwayDays!.min).toBeCloseTo(100 / 21.5, 5);
    expect(c.runwayDays!.max).toBeCloseTo(100 / 21.5, 5);
  });

  it("returns nulls when pricing is not set", async () => {
    const cfg = await makeConfig({
      models: ["gpt"],
      providers: ["openai"],
    });
    const costs = computeCosts("claude-code", { openai: 100_000 }, cfg, modelsFor(cfg));
    const c = costs[0]!;
    expect(c.perTurnUncached).toBeNull();
    expect(c.perTurnCached).toBeNull();
    expect(c.runwayDays).toBeNull();
  });

  it("skips cache modeling when disabled", async () => {
    const cfg = await makeConfig({
      models: ["claude-opus-4-8"],
      providers: ["anthropic"],
      cache: { enabled: false, turnsPerSession: 10 },
    });
    const costs = computeCosts("claude-code", { anthropic: 100_000 }, cfg, modelsFor(cfg));
    expect(costs[0]!.perTurnCached).toBeNull();
  });
});
