import { describe, expect, it } from "vitest";
import { evaluateBudget } from "../src/budget.js";
import type { ContextSource, Snapshot } from "../src/types.js";
import { makeConfig } from "./helpers.js";

function src(path: string, tokens: number): ContextSource {
  return {
    path,
    adapter: "claude-code",
    kind: "repo-instructions",
    usage: "guaranteed",
    scope: "repo",
    consumers: ["claude-code"],
    tokens,
    confidence: "high",
    text: "",
  };
}

describe("evaluateBudget", () => {
  it("passes when under the limit with no snapshot", async () => {
    const cfg = await makeConfig({ baselineTokenLimit: 30000 });
    const gate = evaluateBudget(20000, [src("CLAUDE.md", 20000)], null, cfg);
    expect(gate.pass).toBe(true);
  });

  it("fails when the baseline exceeds the limit", async () => {
    const cfg = await makeConfig({ baselineTokenLimit: 30000 });
    const gate = evaluateBudget(41822, [src("CLAUDE.md", 41822)], null, cfg);
    expect(gate.pass).toBe(false);
    expect(gate.messages.join("\n")).toContain("exceeds");
  });

  it("fails on growth over threshold and names the primary cause", async () => {
    const cfg = await makeConfig({ baselineTokenLimit: null, growthThresholdPct: 20 });
    const snapshot: Snapshot = {
      version: 1,
      createdAt: "2026-06-01T00:00:00.000Z",
      gatedBaseline: 24310,
      sources: [{ path: "CLAUDE.md", tokens: 24310 }],
    };
    const sources = [src("CLAUDE.md", 27542), src(".claude/agents/backend-api-agent.md", 14280)];
    const gate = evaluateBudget(41822, sources, snapshot, cfg);
    expect(gate.pass).toBe(false);
    const text = gate.messages.join("\n");
    expect(text).toContain("72%");
    expect(text).toContain("Added .claude/agents/backend-api-agent.md (+14,280 tokens)");
  });

  it("passes when growth is within the threshold", async () => {
    const cfg = await makeConfig({ baselineTokenLimit: null, growthThresholdPct: 20 });
    const snapshot: Snapshot = {
      version: 1,
      createdAt: "2026-06-01T00:00:00.000Z",
      gatedBaseline: 24310,
      sources: [{ path: "CLAUDE.md", tokens: 24310 }],
    };
    const gate = evaluateBudget(25000, [src("CLAUDE.md", 25000)], snapshot, cfg);
    expect(gate.pass).toBe(true);
  });
});
