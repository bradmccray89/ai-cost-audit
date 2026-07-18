import { describe, expect, it } from "vitest";
import { runScan } from "../src/scan.js";
import { renderTerminal } from "../src/report/terminal.js";
import { makeConfig, SAMPLE_REPO } from "./helpers.js";

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

  it("includes the disclosure footer", async () => {
    const cfg = await makeConfig();
    const { report } = await runScan(SAMPLE_REPO, cfg, null);
    const text = plainLines(renderTerminal(report, cfg)).join("\n");
    expect(text).toContain("offline estimates");
    expect(text).toContain("anthropic ×1.2");
  });
});
