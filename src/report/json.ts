import type { Report } from "../types.js";

/**
 * Stable machine-readable shape for CI and trend tooling.
 * The Report type itself is the contract; this just serializes deterministically.
 */
export function renderJson(report: Report): string {
  return JSON.stringify(report, null, 2) + "\n";
}
