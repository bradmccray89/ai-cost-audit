import { describe, expect, it } from "vitest";
import { findDuplicates } from "../src/analysis/duplication.js";
import type { ContextSource } from "../src/types.js";
import { makeConfig } from "./helpers.js";

function source(path: string, text: string): ContextSource {
  return {
    path,
    adapter: "instructions",
    kind: "repo-instructions",
    usage: "guaranteed",
    scope: "repo",
    consumers: ["claude-code"],
    tokens: 0,
    confidence: "high",
    text,
  };
}

const SHARED_BLOCK =
  "All code must follow our standards: use two-space indentation everywhere, never use " +
  "tab characters, always prefer const over let when a binding is never reassigned, name " +
  "boolean variables with an is or has prefix, keep every function under forty lines of " +
  "code, and write descriptive commit messages in the imperative mood for every commit.";

const NEAR_BLOCK_A =
  "You are a backend code reviewer. When reviewing code, check that every function has " +
  "appropriate error handling, that database queries are parameterized to prevent SQL " +
  "injection attacks, that all public endpoints validate their input payloads with a " +
  "schema, and that no secrets or credentials are hardcoded anywhere in the codebase.";

const NEAR_BLOCK_B =
  "You are a frontend code reviewer. When reviewing code, check that every component has " +
  "appropriate error handling, that database queries are parameterized to prevent SQL " +
  "injection attacks, that all public endpoints validate their input payloads with a " +
  "schema, and that no secrets or credentials are hardcoded anywhere in the codebase.";

describe("findDuplicates", () => {
  it("detects exact duplicates across sources", async () => {
    const cfg = await makeConfig();
    const groups = findDuplicates(
      [
        source("a.md", `# A\n\n${SHARED_BLOCK}\n\nUnique to A.`),
        source("b.md", `# B\n\n${SHARED_BLOCK}\n\nUnique to B.`),
      ],
      cfg,
    );
    const exact = groups.filter((g) => g.exact);
    expect(exact).toHaveLength(1);
    expect(exact[0]!.sources.sort()).toEqual(["a.md", "b.md"]);
    expect(exact[0]!.redundantTokens).toBeGreaterThan(40);
  });

  it("detects near-duplicates across sources", async () => {
    const cfg = await makeConfig();
    const groups = findDuplicates(
      [source("agent-a.md", NEAR_BLOCK_A), source("agent-b.md", NEAR_BLOCK_B)],
      cfg,
    );
    const near = groups.filter((g) => !g.exact);
    expect(near).toHaveLength(1);
    expect(near[0]!.sources.sort()).toEqual(["agent-a.md", "agent-b.md"]);
  });

  it("does not flag repetition within a single source", async () => {
    const cfg = await makeConfig();
    const groups = findDuplicates(
      [source("a.md", `${SHARED_BLOCK}\n\n${SHARED_BLOCK}`)],
      cfg,
    );
    expect(groups).toHaveLength(0);
  });

  it("ignores blocks below the minimum token threshold", async () => {
    const cfg = await makeConfig();
    const tiny = "Use const.";
    const groups = findDuplicates(
      [source("a.md", tiny), source("b.md", tiny)],
      cfg,
    );
    expect(groups).toHaveLength(0);
  });
});
