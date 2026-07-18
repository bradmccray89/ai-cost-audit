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
    expect(paths).toContain(".claude/agents/backend-reviewer.md (description)");
    expect(paths).toContain(".claude/agents/backend-reviewer.md (body)");
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

  it("produces per-tool request ranges above each tool's baseline", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    for (const [consumer, totals] of Object.entries(report.totals.byConsumer)) {
      expect(report.requestRanges[consumer]!.min).toBe(totals.total + 8000 + 5000);
      expect(report.requestRanges[consumer]!.max).toBe(totals.total + 25000 + 15000);
    }
  });

  it("computes per-tool baselines from each tool's own sources", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const { byConsumer } = report.totals;
    const sumFor = (consumer: string) =>
      report.sources
        .filter(
          (s) =>
            s.usage === "guaranteed" &&
            s.scope === "repo" &&
            s.consumers.includes(consumer as never),
        )
        .reduce((total, s) => total + s.tokens, 0);

    for (const consumer of ["claude-code", "cursor", "copilot"]) {
      expect(byConsumer[consumer]!.gated).toBe(sumFor(consumer));
    }
    // AGENTS.md is shared; the rest is tool-specific, so no per-tool baseline
    // equals the cross-tool union.
    expect(byConsumer["claude-code"]!.gated).toBeLessThan(report.totals.gatedBaseline);
    expect(byConsumer["cursor"]!.gated).toBeLessThan(report.totals.gatedBaseline);
    // AGENTS.md lands in every tool's baseline.
    const agentsMd = report.sources.find((s) => s.path === "AGENTS.md");
    expect(agentsMd?.consumers.sort()).toEqual(["claude-code", "copilot", "cursor"]);
  });

  it("includes shipped system overhead in per-tool totals", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const claude = report.totals.byConsumer["claude-code"]!;
    expect(claude.systemOverhead).toBe(15_000);
    expect(claude.total).toBe(claude.guaranteed + 15_000);
    // Cost figures are computed from the total, not the file-only baseline:
    // 15k+ tokens of overhead dominates this small fixture repo.
    const cost = report.costs.find(
      (c) => c.consumer === "claude-code" && c.model === "claude-opus-4-8",
    )!;
    expect(cost.perRequestUncached!).toBeGreaterThan((15_000 / 1_000_000) * 5.0);
  });

  it("respects systemOverheadTokens overrides, including 0 to exclude", async () => {
    const cfg = await makeConfig({
      systemOverheadTokens: { "claude-code": 0, cursor: 12_345 },
    });
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const claude = report.totals.byConsumer["claude-code"]!;
    expect(claude.systemOverhead).toBe(0);
    expect(claude.total).toBe(claude.guaranteed);
    expect(report.totals.byConsumer["cursor"]!.systemOverhead).toBe(12_345);
    // Copilot keeps the shipped default.
    expect(report.totals.byConsumer["copilot"]!.systemOverhead).toBe(4_000);
  });

  it("keeps system overhead out of the CI-gated baseline", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const repoGuaranteed = report.sources
      .filter((s) => s.scope === "repo" && s.usage === "guaranteed")
      .reduce((sum, s) => sum + s.tokens, 0);
    expect(report.totals.gatedBaseline).toBe(repoGuaranteed);
  });

  it("emits costs per consumer", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const consumers = [...new Set(report.costs.map((c) => c.consumer))];
    expect(consumers.sort()).toEqual(["claude-code", "copilot", "cursor"]);
    // Smaller baseline -> cheaper request: copilot only loads AGENTS.md here.
    const claudeCost = report.costs.find(
      (c) => c.consumer === "claude-code" && c.model === "claude-opus-4-8",
    )!;
    const copilotCost = report.costs.find(
      (c) => c.consumer === "copilot" && c.model === "claude-opus-4-8",
    )!;
    expect(copilotCost.perRequestUncached!).toBeLessThan(claudeCost.perRequestUncached!);
  });

  it("respects scan.exclude for discovered sources", async () => {
    const cfg = await makeConfig({
      scan: { exclude: ["**/node_modules/**", ".claude/agents/**", "docs/**"] },
    });
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const paths = report.sources.map((s) => s.path);
    expect(paths.some((p) => p.includes(".claude/agents/"))).toBe(false);
    expect(paths).not.toContain("docs/standards.md");
    expect(paths).toContain("CLAUDE.md");
  });

  it("prices custom models via pricingOverrides", async () => {
    const cfg = await makeConfig({
      models: ["my-fine-tune"],
      pricingOverrides: { "my-fine-tune": { inputPerMTok: 2 } },
    });
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const cost = report.costs.find((c) => c.model === "my-fine-tune");
    expect(cost).toBeDefined();
    expect(cost!.perRequestUncached).not.toBeNull();
    expect(cost!.perRequestUncached!).toBeGreaterThan(0);
  });

  it("attaches custom models to a known provider via pricingOverrides.provider", async () => {
    const cfg = await makeConfig({
      models: ["my-fine-tune"],
      pricingOverrides: { "my-fine-tune": { inputPerMTok: 2, provider: "anthropic" } },
    });
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const cost = report.costs.find((c) => c.model === "my-fine-tune")!;
    expect(cost.provider).toBe("anthropic");
    // Anthropic provider has cache modeling, so the cached figure exists.
    expect(cost.perRequestCached).not.toBeNull();
  });

  it("counts agent descriptions as guaranteed and bodies as conditional", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const description = report.sources.find((s) => s.kind === "agent-description");
    const body = report.sources.find((s) => s.kind === "agent");
    expect(description?.usage).toBe("guaranteed");
    expect(body?.usage).toBe("conditional");
  });

  it("emits only forward-slash paths on every platform", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    for (const s of report.sources) {
      expect(s.path).not.toContain("\\");
    }
  });

  it("includes the honesty metadata", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    expect(report.meta.disclosure).toContain("offline estimates");
    expect(report.meta.calibration.anthropic).toBe(1.2);
    expect(report.meta.cacheFormula).toContain("write + read");
  });
});
