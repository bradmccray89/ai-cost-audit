import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config } from "./types.js";
import { DEFAULT_PRICING_URL } from "./pricingStore.js";

const rangeSchema = z.tuple([z.number().nonnegative(), z.number().nonnegative()]);

const configSchema = z
  .object({
    providers: z.array(z.string()).default(["anthropic"]),
    models: z.array(z.string()).default(["claude-opus-4-8", "claude-sonnet-5"]),
    monthlyBudget: z.number().positive().nullable().default(null),
    developers: z.number().int().positive().default(1),
    baselineTokenLimit: z.number().positive().nullable().default(null),
    growthThresholdPct: z.number().positive().default(20),
    turnsPerDay: z.array(z.number().positive()).default([50, 200, 1000]),
    apiCallsPerTurn: rangeSchema.default([1, 15]),
    outputTokensPerTurn: rangeSchema.default([500, 4000]),
    cache: z
      .object({
        enabled: z.boolean().default(true),
        turnsPerSession: z.number().int().positive().default(10),
        ttl: z.enum(["5m", "1h"]).default("5m"),
      })
      .default({}),
    variable: z
      .object({
        conversationHistory: rangeSchema.default([8000, 25000]),
        taskFiles: rangeSchema.default([5000, 15000]),
      })
      .default({}),
    calibration: z.record(z.number().positive()).default({}),
    systemOverheadTokens: z.record(z.number().nonnegative()).default({}),
    pricingOverrides: z
      .record(
        z.object({
          inputPerMTok: z.number().nonnegative(),
          outputPerMTok: z.number().nonnegative().optional(),
          provider: z.string().optional(),
        }),
      )
      .default({}),
    mcp: z
      .object({
        knownSchemaTokens: z.record(z.number().nonnegative()).default({}),
      })
      .default({}),
    pricing: z
      .object({
        sourceUrl: z.string().url().default(DEFAULT_PRICING_URL),
      })
      .default({}),
    duplication: z
      .object({
        minBlockTokens: z.number().positive().default(40),
        similarityThreshold: z.number().min(0).max(1).default(0.8),
      })
      .default({}),
    scan: z
      .object({
        exclude: z.array(z.string()).default(["**/node_modules/**", "**/dist/**", "**/.git/**"]),
      })
      .default({}),
    refDepth: z.number().int().min(0).max(10).default(3),
    includeGlobal: z.boolean().default(true),
  })
  .strict();

export const CONFIG_FILENAME = "ai-cost-audit.json";

export interface LoadedConfig {
  config: Config;
  /** Absolute path of the config file used, or null when running on defaults. */
  configPath: string | null;
}

export async function loadConfig(
  projectPath: string,
  explicitPath?: string,
): Promise<LoadedConfig> {
  let configPath: string | null = null;
  if (explicitPath) {
    configPath = path.resolve(explicitPath);
    if (!existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
  } else {
    const candidate = path.join(projectPath, CONFIG_FILENAME);
    if (existsSync(candidate)) configPath = candidate;
  }

  let raw: unknown = {};
  if (configPath) {
    try {
      raw = JSON.parse(await readFile(configPath, "utf8"));
    } catch (err) {
      throw new Error(
        `Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config${configPath ? ` (${configPath})` : ""}:\n${issues}`);
  }

  return { config: parsed.data as Config, configPath };
}
