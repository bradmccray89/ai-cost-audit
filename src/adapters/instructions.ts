import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { Config, ContextAdapter, ContextSource } from "../types.js";
import { estimateTokens } from "../tokenizer.js";

/**
 * Cross-tool instruction files: AGENTS.md, Cursor rules (modern .cursor/rules
 * and legacy .cursorrules), GitHub Copilot instructions.
 */
export const instructionsAdapter: ContextAdapter = {
  name: "instructions",

  async discover(projectPath: string, cfg: Config): Promise<ContextSource[]> {
    const sources: ContextSource[] = [];

    const add = async (
      relPath: string,
      kind: ContextSource["kind"],
      usage: ContextSource["usage"],
      confidence: ContextSource["confidence"],
      note?: string,
    ) => {
      let text: string;
      try {
        text = await readFile(path.join(projectPath, relPath), "utf8");
      } catch {
        return;
      }
      sources.push({
        path: relPath,
        adapter: "instructions",
        kind,
        usage,
        scope: "repo",
        tokens: estimateTokens(text, "anthropic", cfg),
        confidence,
        note,
        text,
      });
    };

    const glob = (pattern: string) =>
      fg(pattern, { cwd: projectPath, dot: true, onlyFiles: true }).then((r) => r.sort());

    for (const file of await glob("AGENTS.md")) {
      await add(file, "repo-instructions", "guaranteed", "high", "loaded by AGENTS.md-aware tools");
    }

    // Modern Cursor rules. .mdc frontmatter can scope rules to globs/manual
    // triggering, which we don't parse in v1 — classified guaranteed with a note.
    for (const file of await glob(".cursor/rules/**/*.mdc")) {
      await add(
        file,
        "cursor-rules",
        "guaranteed",
        "medium",
        "Cursor rule; may be glob-scoped or manual (frontmatter not parsed in v1)",
      );
    }

    // Legacy Cursor rules file — flagged separately so findings can suggest migrating.
    for (const file of await glob(".cursorrules")) {
      await add(
        file,
        "cursor-rules",
        "guaranteed",
        "high",
        "legacy .cursorrules format (Cursor now uses .cursor/rules/*.mdc)",
      );
    }

    for (const file of await glob(".github/copilot-instructions.md")) {
      await add(file, "copilot-instructions", "guaranteed", "high", "loaded on every Copilot chat request");
    }

    // Path-scoped Copilot instruction files apply only to matching files.
    for (const file of await glob(".github/**/*.instructions.md")) {
      await add(
        file,
        "copilot-instructions",
        "conditional",
        "medium",
        "path-scoped Copilot instructions; loads when matching files are in play",
      );
    }

    return sources;
  },
};
