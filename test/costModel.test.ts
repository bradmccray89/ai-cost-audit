import { describe, expect, it } from "vitest";
import { cacheEffectiveMultiplier, computeCosts } from "../src/costModel.js";
import { makeConfig } from "./helpers.js";

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
  it("computes uncached and cached per-request cost for a known baseline", async () => {
    const cfg = await makeConfig({
      models: ["claude-opus-4-8"],
      providers: ["anthropic"],
      requestsPerDay: [100],
      monthlyBudget: null,
    });
    const costs = computeCosts({ anthropic: 100_000 }, cfg);
    expect(costs).toHaveLength(1);
    const c = costs[0]!;
    // 100k tokens at $5/MTok = $0.50 uncached.
    expect(c.perRequestUncached).toBeCloseTo(0.5, 10);
    // Cached: 0.5 * 0.215 = 0.1075.
    expect(c.perRequestCached).toBeCloseTo(0.1075, 10);
    expect(c.daily[0]!.uncached).toBeCloseTo(50, 10);
    expect(c.daily[0]!.cached).toBeCloseTo(10.75, 10);
  });

  it("computes budget runway from the middle requests/day scenario", async () => {
    const cfg = await makeConfig({
      models: ["claude-opus-4-8"],
      providers: ["anthropic"],
      requestsPerDay: [50, 200, 1000],
      monthlyBudget: 100,
    });
    const costs = computeCosts({ anthropic: 100_000 }, cfg);
    const c = costs[0]!;
    // Cached per request 0.1075; mid scenario 200 req/day -> $21.50/day.
    // Runway = 100 / 21.5 ≈ 4.651 days.
    expect(c.runwayDays).toBeCloseTo(100 / 21.5, 5);
  });

  it("returns nulls when pricing is not set", async () => {
    const cfg = await makeConfig({
      models: ["gpt"],
      providers: ["openai"],
    });
    const costs = computeCosts({ openai: 100_000 }, cfg);
    const c = costs[0]!;
    expect(c.perRequestUncached).toBeNull();
    expect(c.perRequestCached).toBeNull();
    expect(c.runwayDays).toBeNull();
  });

  it("skips cache modeling when disabled", async () => {
    const cfg = await makeConfig({
      models: ["claude-opus-4-8"],
      providers: ["anthropic"],
      cache: { enabled: false, requestsPerSession: 10 },
    });
    const costs = computeCosts({ anthropic: 100_000 }, cfg);
    expect(costs[0]!.perRequestCached).toBeNull();
  });
});
