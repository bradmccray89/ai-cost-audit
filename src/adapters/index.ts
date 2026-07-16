import type { Config, ContextAdapter, ContextSource } from "../types.js";
import { claudeCodeAdapter } from "./claudeCode.js";
import { genericMcpAdapter } from "./genericMcp.js";
import { instructionsAdapter } from "./instructions.js";

export const ADAPTERS: ContextAdapter[] = [
  claudeCodeAdapter,
  genericMcpAdapter,
  instructionsAdapter,
];

/**
 * Run all adapters and dedupe by (path). Earlier adapters win — claude-code's
 * classification of a file beats the generic instructions adapter's.
 */
export async function discoverAll(projectPath: string, cfg: Config): Promise<ContextSource[]> {
  const seen = new Set<string>();
  const all: ContextSource[] = [];
  for (const adapter of ADAPTERS) {
    const sources = await adapter.discover(projectPath, cfg);
    for (const source of sources) {
      if (seen.has(source.path)) continue;
      seen.add(source.path);
      all.push(source);
    }
  }
  return all;
}
