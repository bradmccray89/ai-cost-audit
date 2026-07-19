import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { measureUsage, encodeProjectDir } from "../src/transcripts.js";
import { bundledPricing } from "../src/pricingStore.js";

const PROJECTS_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "transcripts",
);

describe("encodeProjectDir", () => {
  it("replaces separators, colons, and dots with dashes", () => {
    // Path is resolved first (adds a drive on Windows), so assert the shape
    // rather than an exact string: dash-separated, no path punctuation left.
    const encoded = encodeProjectDir("/test/repo.a");
    expect(encoded).not.toMatch(/[/\\:.]/);
    expect(encoded).toMatch(/test-repo-a$/);
  });
});

describe("measureUsage", () => {
  const table = bundledPricing();

  it("returns null when no transcripts match the project", () => {
    expect(measureUsage("/no/such/repo", table, { projectsRoot: PROJECTS_ROOT })).toBeNull();
  });

  it("locates transcripts by recorded cwd and profiles usage", () => {
    const p = measureUsage("/test/repo-a", table, { projectsRoot: PROJECTS_ROOT })!;
    expect(p).not.toBeNull();
    expect(p.sessions).toBe(1);
    expect(p.turns).toBe(2);
    expect(p.apiCalls).toBe(4);
    // turn 1 = 3 calls, turn 2 = 1 call.
    expect(p.apiCallsPerTurn).toEqual({ min: 1, median: 2, max: 3 });
    // outputs: turn 1 = 400, turn 2 = 200.
    expect(p.outputTokensPerTurn).toEqual({ min: 200, median: 300, max: 400 });
    expect(p.activeDays).toBe(2);
    expect(p.turnsPerDay).toBeCloseTo(1, 10);
    expect(p.models).toEqual(["claude-opus-4-8"]);
    expect(p.ttlSplit["5m"]).toBeCloseTo(1, 10);
    expect(p.avgContextTokens).toBe(1000);
    expect(p.unpricedCalls).toBe(0);
    expect(p.tool).toBe("Claude Code");
    // firstAt 07-10T10:00:00 → lastAt 07-11T10:00:01 ≈ 24h.
    expect(p.durationHours).toBeCloseTo(24, 2);
  });

  it("breaks cost down by model and by token type", () => {
    const p = measureUsage("/test/repo-a", table, { projectsRoot: PROJECTS_ROOT })!;
    // One model in the fixture, so it owns 100% of cost.
    expect(p.byModel).toHaveLength(1);
    const opus = p.byModel[0]!;
    expect(opus.model).toBe("claude-opus-4-8");
    expect(opus.calls).toBe(4);
    expect(opus.outputTokens).toBe(600); // 200+100+100+200
    expect(opus.share).toBeCloseTo(1, 10);
    expect(opus.costUSD).toBeCloseTo(0.02325, 10);
    // Composition sums to the total cost.
    const c = p.composition;
    expect(c.cacheRead + c.cacheWrite + c.freshInput + c.output).toBeCloseTo(0.02325, 10);
    // Output dominates here: 600 tok × $25/M = $0.015.
    expect(c.output).toBeCloseTo(0.015, 10);
  });

  it("prices actual cost from recorded token usage", () => {
    const p = measureUsage("/test/repo-a", table, { projectsRoot: PROJECTS_ROOT })!;
    // Opus $5 in / $25 out; 5m write 1.25x, read 0.1x. Hand-computed:
    //  call1: 100*5e-6 + 1000*5e-6*1.25 + 200*25e-6            = 0.01175
    //  call2: 1000*5e-6*0.1 + 100*25e-6                        = 0.00300
    //  call3: 1000*5e-6*0.1 + 100*25e-6                        = 0.00300
    //  call4: 1000*5e-6*0.1 + 200*25e-6                        = 0.00550
    //  total = 0.02325; per turn = 0.02325 / 2 = 0.011625
    expect(p.actualCostUSD).toBeCloseTo(0.02325, 10);
    expect(p.actualCostPerTurn).toBeCloseTo(0.011625, 10);
  });

  it("counts calls whose model is not in the pricing table as unpriced", () => {
    const p = measureUsage("/test/repo-b", table, { projectsRoot: PROJECTS_ROOT })!;
    expect(p.unpricedCalls).toBe(1);
    // The one priced call still contributes; the unpriced one is excluded.
    expect(p.actualCostUSD).toBeGreaterThan(0);
  });
});
