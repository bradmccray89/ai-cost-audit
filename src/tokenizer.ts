import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";
import type { Config } from "./types.js";
import { resolveProvider } from "./pricing.js";

let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (!encoder) encoder = new Tiktoken(o200k_base);
  return encoder;
}

/** Raw o200k_base token count — deterministic, offline, uncalibrated. */
export function countRawTokens(text: string): number {
  if (text.length === 0) return 0;
  return getEncoder().encode(text).length;
}

/**
 * Calibrated estimate for a provider. o200k_base is exact for OpenAI models and
 * undercounts Claude by ~15-20%, so Anthropic counts get a >1 multiplier.
 * All report numbers derived from this are estimates, disclosed as such.
 */
export function estimateTokens(text: string, provider: string, cfg: Config): number {
  const raw = countRawTokens(text);
  const { calibration } = resolveProvider(provider, cfg);
  return Math.round(raw * calibration);
}

export const DISCLOSURE =
  "Token counts are offline estimates (±~15-20% for Anthropic models). No model API is called.";
