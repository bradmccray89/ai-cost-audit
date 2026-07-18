import { z } from "zod";
import type { PricingTable } from "./pricing.js";
import bundled from "./data/pricing.json" with { type: "json" };

/** Where the pricing numbers used by a run came from. */
export type PricingOrigin = "bundled" | "remote";

export interface ResolvedPricing {
  table: PricingTable;
  origin: PricingOrigin;
  /** For remote: the URL. For bundled: the table's own `source`. */
  source: string;
}

const rateSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  from: z.string().optional(),
  until: z.string().optional(),
});

const pricingTableSchema = z.object({
  asOf: z.string(),
  source: z.string(),
  models: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      rates: z.array(rateSchema),
      note: z.string().optional(),
    }),
  ),
});

/** The prices shipped with this build — always available, no network. */
export function bundledPricing(): PricingTable {
  return pricingTableSchema.parse(bundled);
}

/** Default remote source: the committed data file on the repo's main branch. */
export const DEFAULT_PRICING_URL =
  "https://raw.githubusercontent.com/bradmccray89/ai-cost-audit/main/src/data/pricing.json";

/**
 * Fetch and validate a pricing table from a URL. Offline-by-default is
 * preserved because this only runs when the user passes --refresh-pricing.
 */
export async function fetchPricing(url: string, timeoutMs = 10_000): Promise<PricingTable> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const json = (await res.json()) as unknown;
    return pricingTableSchema.parse(json);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the pricing to use for a run. Default: bundled (offline,
 * deterministic). With `refresh`, fetch the latest from `url` and use it for
 * this run; on any failure, fall back to bundled and report the reason so the
 * caller can warn — a refresh that quietly used stale prices would be worse
 * than one that says it fell back.
 */
export async function resolvePricing(opts: {
  refresh: boolean;
  url: string;
}): Promise<{ resolved: ResolvedPricing; warning?: string }> {
  const bundledTable = bundledPricing();
  if (!opts.refresh) {
    return { resolved: { table: bundledTable, origin: "bundled", source: bundledTable.source } };
  }
  try {
    const table = await fetchPricing(opts.url);
    return { resolved: { table, origin: "remote", source: opts.url } };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      resolved: { table: bundledTable, origin: "bundled", source: bundledTable.source },
      warning:
        `Could not refresh pricing from ${opts.url} (${reason}). ` +
        `Using bundled prices as of ${bundledTable.asOf}.`,
    };
  }
}
