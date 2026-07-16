import { describe, expect, it } from "vitest";
import { runScan } from "../src/scan.js";
import { makeConfig, SAMPLE_REPO } from "./helpers.js";

describe("runScan (integration on fixture repo)", () => {
  it("discovers and classifies the full sample repo", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const paths = report.sources.map((s) => s.path);

    // Claude Code sources
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain(".claude/agents/backend-reviewer.md");
    expect(paths).toContain(".claude/skills/deploy/SKILL.md (description)");
    expect(paths).toContain(".claude/skills/deploy/SKILL.md (body)");
    expect(paths).toContain(".claude/commands/changelog.md");
    // Referenced doc pulled in via @import
    expect(paths).toContain("docs/standards.md");
    // MCP servers
    expect(paths).toContain(".mcp.json → github");
    expect(paths).toContain(".mcp.json → postgres");
    // Cross-tool instructions
    expect(paths).toContain("AGENTS.md");
    expect(paths).toContain(".cursor/rules/style.mdc");
    expect(paths).toContain(".cursorrules");
  });

  it("buckets skills correctly: description guaranteed, body conditional", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const description = report.sources.find((s) => s.kind === "skill-description");
    const body = report.sources.find((s) => s.kind === "skill-body");
    expect(description?.usage).toBe("guaranteed");
    expect(body?.usage).toBe("conditional");
  });

  it("computes a gated baseline and excludes global scope from it", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const repoGuaranteed = report.sources
      .filter((s) => s.scope === "repo" && s.usage === "guaranteed")
      .reduce((sum, s) => sum + s.tokens, 0);
    expect(report.totals.gatedBaseline).toBe(repoGuaranteed);
    expect(report.totals.gatedBaseline).toBeGreaterThan(0);
    // includeGlobal=false in test config -> no global sources at all.
    expect(report.totals.globalBaseline).toBe(0);
  });

  it("flags the planted duplicate between CLAUDE.md and docs/standards.md", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const dup = report.findings.find(
      (f) =>
        f.rule === "duplicate-content" &&
        f.sources.includes("CLAUDE.md") &&
        f.sources.includes("docs/standards.md"),
    );
    expect(dup).toBeDefined();
  });

  it("flags the near-identical reviewer agents", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const near = report.findings.find(
      (f) =>
        f.rule === "near-duplicate-content" &&
        f.sources.some((s) => s.includes("backend-reviewer")) &&
        f.sources.some((s) => s.includes("frontend-reviewer")),
    );
    expect(near).toBeDefined();
  });

  it("emits legacy-cursorrules and unmeasured-mcp findings", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const rules = report.findings.map((f) => f.rule);
    expect(rules).toContain("legacy-cursorrules");
    expect(rules).toContain("unmeasured-mcp");
  });

  it("marks MCP sources low-confidence with a note", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const mcp = report.sources.filter((s) => s.adapter === "generic-mcp");
    expect(mcp.length).toBeGreaterThan(0);
    for (const s of mcp) {
      expect(s.confidence).toBe("low");
      expect(s.note).toContain("live tool schemas not measured");
    }
  });

  it("respects mcp.knownSchemaTokens pinning", async () => {
    const cfg = await makeConfig({
      mcp: { knownSchemaTokens: { github: 12000 } },
    });
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const github = report.sources.find((s) => s.path === ".mcp.json → github");
    expect(github?.tokens).toBe(12000);
    expect(github?.confidence).toBe("medium");
  });

  it("produces a request range above the baseline", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    expect(report.requestRange.min).toBe(
      report.totals.guaranteed + 8000 + 5000,
    );
    expect(report.requestRange.max).toBe(
      report.totals.guaranteed + 25000 + 15000,
    );
  });

  it("includes the honesty metadata", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    expect(report.meta.disclosure).toContain("offline estimates");
    expect(report.meta.calibration.anthropic).toBe(1.2);
    expect(report.meta.cacheFormula).toContain("write + read");
  });
});
