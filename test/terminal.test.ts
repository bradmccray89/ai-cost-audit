import { describe, expect, it } from "vitest";
import { runScan } from "../src/scan.js";
import { renderTerminal } from "../src/report/terminal.js";
import type { UsageProfile } from "../src/types.js";
import { makeConfig, SAMPLE_REPO } from "./helpers.js";

const SAMPLE_PROFILE: UsageProfile = {
  sessions: 2,
  apiCalls: 40,
  turns: 8,
  firstAt: "2026-07-10T10:00:00.000Z",
  lastAt: "2026-07-12T18:00:00.000Z",
  activeDays: 3,
  models: ["claude-opus-4-8"],
  apiCallsPerTurn: { min: 2, median: 5, max: 12 },
  outputTokensPerTurn: { min: 300, median: 1800, max: 6000 },
  turnsPerDay: 2.67,
  cacheReadRate: 0.9,
  ttlSplit: { "5m": 0.2, "1h": 0.8 },
  avgContextTokens: 45000,
  actualCostUSD: 3.2,
  actualCostPerTurn: 0.4,
  unpricedCalls: 0,
};

/* eslint-disable no-control-regex */
const ANSI_RE = /\[[0-9;]*m/g;

function plainLines(output: string): string[] {
  return output.replace(ANSI_RE, "").split("\n");
}

describe("renderTerminal", () => {
  it("renders every section without markdown table syntax", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const lines = plainLines(renderTerminal(report, cfg));
    const text = lines.join("\n");

    for (const section of [
      "GUARANTEED CONTEXT",
      "PER-TOOL BASELINES",
      "COST PER TURN",
      "DAILY PROJECTIONS",
      "TYPICAL CONTEXT PER API CALL",
      "FINDINGS",
      "ALL DISCOVERED SOURCES",
    ]) {
      expect(text).toContain(section);
    }
    // No markdown pipe tables or heading markers in terminal output.
    expect(text).not.toContain("|---");
    expect(text).not.toContain("## ");
  });

  it("shows per-tool baseline rows with overhead totals", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const text = plainLines(renderTerminal(report, cfg)).join("\n");
    expect(text).toContain("Claude Code");
    expect(text).toContain("GitHub Copilot");
    expect(text).toContain("15,000");
    expect(text).toContain(
      report.totals.byConsumer["claude-code"]!.total.toLocaleString("en-US"),
    );
  });

  it("aligns numeric columns to the right", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const lines = plainLines(renderTerminal(report, cfg));
    const header = lines.find((l) => l.includes("Source kind") && l.includes("Tokens"))!;
    const gated = lines.find((l) => l.includes("Repo total (CI-gated)"))!;
    // Right-aligned column: the token value's last digit lines up with the
    // header's last character.
    expect(header).toBeDefined();
    expect(gated.trimEnd().length).toBe(header.trimEnd().length);
  });

  it("lists findings with severity tags", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const text = plainLines(renderTerminal(report, cfg)).join("\n");
    expect(text).toMatch(/\d+\.\s*\[warn\] duplicate-content/);
    expect(text).toContain("[info]");
  });

  it("renders the measured section and reconciliation when a profile is present", async () => {
    const cfg = await makeConfig({ monthlyBudget: 100 });
    const { report } = await runScan(SAMPLE_REPO, cfg, null, undefined, SAMPLE_PROFILE);
    const text = plainLines(renderTerminal(report, cfg)).join("\n");
    expect(text).toContain("MEASURED FROM YOUR USAGE");
    expect(text).toContain("Cost at API rates");
    expect(text).toContain("$0.40/turn");
    // Reconciliation shows because the sample repo has a Claude Code estimate.
    expect(text).toMatch(/Reconciliation: estimated .* vs measured \$0\.40\/turn/);
    // Tailored forward projection from measured $/turn.
    expect(text).toContain("PROJECTED FROM YOUR MEASURED USAGE");
    expect(text).toContain("(measured)");
    expect(text).toContain("budget lasts");
    // Plan advisor.
    expect(text).toContain("PLAN ADVISOR");
    expect(text).toContain("API pay-as-you-go");
    expect(text).toContain("Claude Max 5x");
  });

  it("omits the measured section when no profile is present", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const text = plainLines(renderTerminal(report, cfg)).join("\n");
    expect(report.measured).toBeNull();
    expect(text).not.toContain("MEASURED FROM YOUR USAGE");
  });

  it("includes the disclosure footer", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const text = plainLines(renderTerminal(report, cfg)).join("\n");
    expect(text).toContain("offline estimates");
    expect(text).toContain("anthropic ×1.2");
  });
});
