import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/types.js";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const SAMPLE_REPO = path.join(FIXTURES, "sample-repo");

/** Default config (no config file), with optional overrides. */
export async function makeConfig(overrides: Partial<Config> = {}): Promise<Config> {
  const { config } = await loadConfig(FIXTURES); // no config file there -> defaults
  return { ...config, ...overrides, includeGlobal: overrides.includeGlobal ?? false };
}
