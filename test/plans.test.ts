import { describe, expect, it } from "vitest";
import { bundledPlans, computePlanAdvice } from "../src/plans.js";
import { planRecommendationText } from "../src/report/markdown.js";
import type { UsageProfile } from "../src/types.js";
import { makeConfig } from "./helpers.js";

function profile(overrides: Partial<UsageProfile> = {}): UsageProfile {
  return {
    tool: "Claude Code",
    sessions: 1,
    apiCalls: 40,
    turns: 10,
    firstAt: "2026-07-10T00:00:00Z",
    lastAt: "2026-07-14T00:00:00Z",
    durationHours: 96,
    activeDays: 5,
    models: ["claude-opus-4-8"],
    byModel: [],
    composition: { cacheRead: 0, cacheWrite: 0, freshInput: 0, output: 0 },
    apiCallsPerTurn: { min: 1, median: 4, max: 12 },
    outputTokensPerTurn: { min: 100, median: 1500, max: 5000 },
    turnsPerDay: 10,
    cacheReadRate: 0.9,
    ttlSplit: { "5m": 0, "1h": 1 },
    avgContextTokens: 50000,
    actualCostUSD: 50,
    actualCostPerTurn: 1,
    unpricedCalls: 0,
    ...overrides,
  };
}

describe("bundledPlans", () => {
  it("loads dated, priced plan tiers", () => {
    const t = bundledPlans();
    expect(t.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(t.plans.map((p) => p.id)).toContain("claude-max-5x");
  });
});

describe("computePlanAdvice", () => {
  it("adds API as a usage-scaled option and finds the cheapest", async () => {
    const cfg = await makeConfig();
    // Heavy: $1/turn * 10 turns/day * 30 = $300/mo API-equivalent.
    const advice = computePlanAdvice(profile(), cfg, bundledPlans());
    expect(advice.apiEquivMonthly).toBeCloseTo(300, 6);
    const api = advice.options.find((o) => o.isApi)!;
    expect(api.monthlyUSD).toBeCloseTo(300, 6);
    // A subscription is cheaper than $300 API — cheapest is a plan.
    expect(advice.cheapest.isApi).toBe(false);
    expect(planRecommendationText(advice)).toMatch(/subscription is much cheaper/);
  });

  it("recommends API pay-as-you-go for light usage", async () => {
    const cfg = await makeConfig();
    // Light: $0.02/turn * 2 turns/day * 30 = $1.20/mo API-equivalent.
    const advice = computePlanAdvice(
      profile({ actualCostPerTurn: 0.02, turnsPerDay: 2 }),
      cfg,
      bundledPlans(),
    );
    expect(advice.cheapest.isApi).toBe(true);
    expect(planRecommendationText(advice)).toContain("API pay-as-you-go");
  });

  it("recommends switching a light user off an expensive plan to API", async () => {
    const cfg = await makeConfig({ plan: "claude-max-20x" }); // $200
    // Light usage: API is far cheaper than the $200 plan they're on.
    const advice = computePlanAdvice(
      profile({ actualCostPerTurn: 0.05, turnsPerDay: 1 }),
      cfg,
      bundledPlans(),
    );
    expect(advice.current?.id).toBe("claude-max-20x");
    expect(advice.current?.isCurrent).toBe(true);
    const rec = planRecommendationText(advice);
    expect(rec).toMatch(/switching from Claude Max 20x to API/);
    expect(rec).toContain("light");
  });

  it("never tells a heavy user to downgrade to the cheapest tier", async () => {
    const cfg = await makeConfig({ plan: "claude-max-5x" }); // $100
    // Heavy: $10/turn * 10/day * 30 = $3,000/mo API-equivalent.
    const advice = computePlanAdvice(
      profile({ actualCostPerTurn: 10, turnsPerDay: 10 }),
      cfg,
      bundledPlans(),
    );
    const rec = planRecommendationText(advice);
    // Should keep the subscription, not point at $20 Pro.
    expect(rec).toContain("keep your subscription");
    expect(rec).not.toMatch(/Claude Pro/);
    expect(rec).toContain("Move up a tier only if you hit usage limits");
  });

  it("supports a custom current plan via config", async () => {
    const cfg = await makeConfig({ plan: { label: "Team seat", monthlyUSD: 60 } });
    const advice = computePlanAdvice(profile(), cfg, bundledPlans());
    expect(advice.current?.label).toBe("Team seat");
    expect(advice.current?.monthlyUSD).toBe(60);
  });

  it("keeps a heavy user on their subscription", async () => {
    const cfg = await makeConfig({ plan: "claude-pro" }); // $20, cheapest plan
    // Heavy usage so API >> plans; Pro is the cheapest option and is current.
    const advice = computePlanAdvice(profile({ actualCostPerTurn: 5 }), cfg, bundledPlans());
    expect(advice.cheapest.id).toBe("claude-pro");
    expect(advice.current?.id).toBe("claude-pro");
    expect(planRecommendationText(advice)).toContain("keep your subscription");
  });
});
