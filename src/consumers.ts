import type { Config, Consumer } from "./types.js";

/** Stable display order for per-tool sections. */
export const CONSUMER_ORDER: Consumer[] = ["claude-code", "cursor", "copilot"];

export const CONSUMER_LABELS: Record<Consumer, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  copilot: "GitHub Copilot",
};

/** Date-stamped like pricing so reports can disclose staleness. */
export const SYSTEM_OVERHEAD_AS_OF = "2026-07-01";

/**
 * Tokens each tool loads before any repo file: its system prompt plus built-in
 * tool definitions. This is often the majority of the real guaranteed context,
 * so omitting it understates every per-request figure by a large constant.
 *
 * These are disclosed estimates (tool versions and enabled features shift
 * them), overridable per tool via config.systemOverheadTokens. Set 0 to
 * exclude a tool's overhead entirely.
 */
export const SYSTEM_OVERHEAD: Record<Consumer, { tokens: number; note: string }> = {
  "claude-code": {
    tokens: 15_000,
    note: "system prompt + built-in tool definitions; varies with version and enabled features",
  },
  cursor: {
    tokens: 9_000,
    note: "system prompt + tool definitions; not publicly documented — rough estimate",
  },
  copilot: {
    tokens: 4_000,
    note: "chat system prompt + tool definitions; not publicly documented — rough estimate",
  },
};

export function resolveSystemOverhead(consumer: Consumer, cfg: Config): number {
  return cfg.systemOverheadTokens[consumer] ?? SYSTEM_OVERHEAD[consumer].tokens;
}
