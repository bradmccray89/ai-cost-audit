import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Config, ContextAdapter, ContextSource } from "../types.js";
import { estimateTokens } from "../tokenizer.js";

/**
 * Generic MCP adapter: parses .mcp.json / mcp.json server configs.
 *
 * The honest limitation, stated as data: the tokens that actually enter the
 * model context are each server's live tool schemas, which require a running
 * connection to measure. We count the configured JSON itself and flag every
 * server as low-confidence unless the user pins a measured size via
 * config.mcp.knownSchemaTokens.
 */
export const genericMcpAdapter: ContextAdapter = {
  name: "generic-mcp",

  async discover(projectPath: string, cfg: Config): Promise<ContextSource[]> {
    const sources: ContextSource[] = [];

    for (const filename of [".mcp.json", "mcp.json"]) {
      const absPath = path.join(projectPath, filename);
      if (!existsSync(absPath)) continue;

      let text: string;
      try {
        text = await readFile(absPath, "utf8");
      } catch {
        continue;
      }

      let servers: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
        servers = parsed.mcpServers ?? {};
      } catch {
        sources.push({
          path: filename,
          adapter: "generic-mcp",
          kind: "mcp-config",
          usage: "guaranteed",
          scope: "repo",
          tokens: estimateTokens(text, "anthropic", cfg),
          confidence: "low",
          note: "file is not valid JSON; counted raw",
          text,
        });
        continue;
      }

      const serverNames = Object.keys(servers);
      if (serverNames.length === 0) continue;

      for (const name of serverNames) {
        const known = cfg.mcp.knownSchemaTokens[name];
        const configJson = JSON.stringify(servers[name] ?? {}, null, 2);
        if (known !== undefined) {
          sources.push({
            path: `${filename} → ${name}`,
            adapter: "generic-mcp",
            kind: "mcp-config",
            usage: "guaranteed",
            scope: "repo",
            tokens: known,
            confidence: "medium",
            note: "schema size pinned via config.mcp.knownSchemaTokens",
            text: configJson,
          });
        } else {
          sources.push({
            path: `${filename} → ${name}`,
            adapter: "generic-mcp",
            kind: "mcp-config",
            usage: "guaranteed",
            scope: "repo",
            tokens: estimateTokens(configJson, "anthropic", cfg),
            confidence: "low",
            note:
              "live tool schemas not measured (requires a running server); " +
              "actual context load is usually far larger — pin via config.mcp.knownSchemaTokens",
            text: configJson,
          });
        }
      }
    }

    return sources;
  },
};
