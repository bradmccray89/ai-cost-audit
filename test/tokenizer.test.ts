import { describe, expect, it } from "vitest";
import { countRawTokens, estimateTokens } from "../src/tokenizer.js";
import { makeConfig } from "./helpers.js";

describe("tokenizer", () => {
  it("is deterministic", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    const a = countRawTokens(text);
    const b = countRawTokens(text);
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
  });

  it("returns 0 for empty input", () => {
    expect(countRawTokens("")).toBe(0);
  });

  it("counts a known short string plausibly", () => {
    // "hello world" is 2 tokens in o200k_base.
    expect(countRawTokens("hello world")).toBe(2);
  });

  it("applies anthropic calibration (>1) on top of the raw count", async () => {
    const cfg = await makeConfig();
    const text = "Use two-space indentation. Prefer const over let. ".repeat(10);
    const raw = countRawTokens(text);
    const anthropic = estimateTokens(text, "anthropic", cfg);
    const openai = estimateTokens(text, "openai", cfg);
    expect(anthropic).toBe(Math.round(raw * 1.2));
    expect(openai).toBe(raw);
  });

  it("respects calibration overrides from config", async () => {
    const cfg = await makeConfig({ calibration: { anthropic: 1.5 } });
    const raw = countRawTokens("some instruction text for the model");
    expect(estimateTokens("some instruction text for the model", "anthropic", cfg)).toBe(
      Math.round(raw * 1.5),
    );
  });
});
