import { describe, expect, it } from "vitest";
import { isPricingStale, resolveModels, resolveRate } from "../src/pricing.js";
import { bundledPricing, fetchPricing, resolvePricing } from "../src/pricingStore.js";
import { makeConfig } from "./helpers.js";

describe("bundled pricing data", () => {
  it("validates against the schema and carries an asOf date", () => {
    const table = bundledPricing();
    expect(table.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(table.models.length).toBeGreaterThan(0);
  });
});

describe("resolveRate (effective-date windows)", () => {
  const sonnet = bundledPricing().models.find((m) => m.id === "claude-sonnet-5")!;

  it("uses the intro price inside the window", () => {
    const rate = resolveRate(sonnet, new Date("2026-07-18"));
    expect(rate?.inputPerMTok).toBe(2.0);
    expect(rate?.outputPerMTok).toBe(10.0);
  });

  it("uses the standard price after the window closes", () => {
    const rate = resolveRate(sonnet, new Date("2026-09-01"));
    expect(rate?.inputPerMTok).toBe(3.0);
    expect(rate?.outputPerMTok).toBe(15.0);
  });

  it("treats the until date as inclusive", () => {
    const rate = resolveRate(sonnet, new Date("2026-08-31"));
    expect(rate?.inputPerMTok).toBe(2.0);
  });

  it("returns null for a model with no rates", () => {
    const gpt = bundledPricing().models.find((m) => m.id === "gpt")!;
    expect(resolveRate(gpt, new Date("2026-07-18"))).toBeNull();
  });
});

describe("resolveModels with dates", () => {
  it("resolves the Sonnet 5 price by scan date", async () => {
    const cfg = await makeConfig({ models: ["claude-sonnet-5"] });
    const intro = resolveModels(cfg, bundledPricing(), new Date("2026-07-18"))[0]!;
    const standard = resolveModels(cfg, bundledPricing(), new Date("2026-09-01"))[0]!;
    expect(intro.inputPerMTok).toBe(2.0);
    expect(standard.inputPerMTok).toBe(3.0);
  });

  it("applies pricingOverrides regardless of date", async () => {
    const cfg = await makeConfig({
      models: ["claude-sonnet-5"],
      pricingOverrides: { "claude-sonnet-5": { inputPerMTok: 99 } },
    });
    const m = resolveModels(cfg, bundledPricing(), new Date("2026-07-18"))[0]!;
    expect(m.inputPerMTok).toBe(99);
  });
});

describe("isPricingStale", () => {
  it("is false within 90 days of asOf", () => {
    expect(isPricingStale("2026-07-01", new Date("2026-08-01"))).toBe(false);
  });
  it("is true beyond 90 days", () => {
    expect(isPricingStale("2026-01-01", new Date("2026-07-01"))).toBe(true);
  });
});

describe("resolvePricing", () => {
  it("uses bundled prices without refresh (offline default)", async () => {
    const { resolved, warning } = await resolvePricing({
      refresh: false,
      url: "https://example.invalid/pricing.json",
    });
    expect(resolved.origin).toBe("bundled");
    expect(warning).toBeUndefined();
  });

  it("falls back to bundled with a warning when refresh fails", async () => {
    const { resolved, warning } = await resolvePricing({
      refresh: true,
      url: "https://127.0.0.1:1/does-not-exist.json",
    });
    expect(resolved.origin).toBe("bundled");
    expect(warning).toContain("Using bundled prices");
  });

  it("rejects a malformed remote table", async () => {
    // fetchPricing validates shape; a non-conforming body throws.
    await expect(
      fetchPricing("data:application/json,{\"nope\":true}"),
    ).rejects.toBeDefined();
  });
});
