import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fg from "fast-glob";
import type { Config, ContextAdapter, ContextSource } from "../types.js";
import { estimateTokens } from "../tokenizer.js";
import { displayPath, followReferences } from "../discovery.js";

/**
 * Claude Code adapter: CLAUDE.md / CLAUDE.local.md, user-global ~/.claude/CLAUDE.md,
 * .claude/{agents,skills,commands}. Skills are split: frontmatter/description loads
 * every session (guaranteed), the body loads on demand (conditional).
 */
export const claudeCodeAdapter: ContextAdapter = {
  name: "claude-code",

  async discover(projectPath: string, cfg: Config): Promise<ContextSource[]> {
    const sources: ContextSource[] = [];
    const provider = "anthropic";

    const addFile = async (
      absPath: string,
      partial: Pick<ContextSource, "kind" | "usage" | "scope" | "confidence"> &
        Partial<Pick<ContextSource, "note" | "referencedFrom" | "path">>,
    ): Promise<string | null> => {
      if (!existsSync(absPath)) return null;
      let text: string;
      try {
        text = await readFile(absPath, "utf8");
      } catch {
        return null;
      }
      sources.push({
        path: partial.path ?? displayPath(absPath, projectPath),
        adapter: "claude-code",
        kind: partial.kind,
        usage: partial.usage,
        scope: partial.scope,
        tokens: estimateTokens(text, provider, cfg),
        confidence: partial.confidence,
        note: partial.note,
        referencedFrom: partial.referencedFrom,
        text,
      });
      return text;
    };

    // Repo instructions (always loaded).
    const rootClaudeMd = path.join(projectPath, "CLAUDE.md");
    const rootText = await addFile(rootClaudeMd, {
      kind: "repo-instructions",
      usage: "guaranteed",
      scope: "repo",
      confidence: "high",
    });
    await addFile(path.join(projectPath, "CLAUDE.local.md"), {
      kind: "local-instructions",
      usage: "guaranteed",
      scope: "repo",
      confidence: "high",
      note: "typically gitignored; loads for the local developer only",
    });

    // Follow @imports / local markdown links out of CLAUDE.md — referenced docs
    // load with it, so they inherit guaranteed usage.
    if (rootText) {
      const refs = await followReferences(rootClaudeMd, rootText, projectPath, cfg.refDepth);
      for (const ref of refs) {
        await addFile(ref.absPath, {
          kind: "referenced-doc",
          usage: "guaranteed",
          scope: "repo",
          confidence: "medium",
          note: "pulled in via reference from an instruction file",
          referencedFrom: displayPath(ref.referencedFrom, projectPath),
        });
      }
    }

    // User-global instructions: loaded on every request on this machine, but
    // excluded from the CI-gated number (CI runners don't have them).
    if (cfg.includeGlobal) {
      await addFile(path.join(os.homedir(), ".claude", "CLAUDE.md"), {
        path: "~/.claude/CLAUDE.md",
        kind: "global-instructions",
        usage: "guaranteed",
        scope: "global",
        confidence: "high",
        note: "user-global; reported but not counted toward the CI budget",
      });
    }

    // Agents: definitions load when the agent is invoked; frontmatter descriptions
    // are listed for the main loop. Without parsing invocation config we classify
    // the full file as conditional with a note (most agents are subagents).
    const agentFiles = await fg(".claude/agents/**/*.md", {
      cwd: projectPath,
      absolute: true,
      dot: true,
    });
    for (const file of agentFiles.sort()) {
      await addFile(file, {
        kind: "agent",
        usage: "conditional",
        scope: "repo",
        confidence: "medium",
        note: "loads when the agent is invoked; its description line loads every session",
      });
    }

    // Skills: SKILL.md frontmatter/description is always loaded (progressive
    // disclosure); the body loads only when the skill triggers.
    const skillFiles = await fg(".claude/skills/*/SKILL.md", {
      cwd: projectPath,
      absolute: true,
      dot: true,
    });
    for (const file of skillFiles.sort()) {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const { frontmatter, body } = splitFrontmatter(text);
      const rel = displayPath(file, projectPath);
      if (frontmatter) {
        sources.push({
          path: `${rel} (description)`,
          adapter: "claude-code",
          kind: "skill-description",
          usage: "guaranteed",
          scope: "repo",
          tokens: estimateTokens(frontmatter, "anthropic", cfg),
          confidence: "high",
          note: "skill metadata loads every session (progressive disclosure)",
          text: frontmatter,
        });
      }
      if (body.trim().length > 0) {
        sources.push({
          path: `${rel} (body)`,
          adapter: "claude-code",
          kind: "skill-body",
          usage: "conditional",
          scope: "repo",
          tokens: estimateTokens(body, "anthropic", cfg),
          confidence: "high",
          note: "loads only when the skill is invoked",
          text: body,
        });
      }
    }

    // Slash commands: load when invoked.
    const commandFiles = await fg(".claude/commands/**/*.md", {
      cwd: projectPath,
      absolute: true,
      dot: true,
    });
    for (const file of commandFiles.sort()) {
      await addFile(file, {
        kind: "command",
        usage: "conditional",
        scope: "repo",
        confidence: "high",
        note: "loads when the command is invoked",
      });
    }

    return sources;
  },
};

function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: null, body: text };
  return { frontmatter: match[0], body: text.slice(match[0].length) };
}
