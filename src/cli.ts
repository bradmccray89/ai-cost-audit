import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { loadConfig } from "./config.js";
import { runScan, TOOL_NAME, TOOL_VERSION } from "./scan.js";
import { renderMarkdown } from "./report/markdown.js";
import { renderJson } from "./report/json.js";
import { renderHtml } from "./report/html.js";
import { renderTerminal } from "./report/terminal.js";
import { readSnapshot, writeSnapshot } from "./snapshot.js";
import { evaluateBudget, EXIT_ERROR, EXIT_PASS, EXIT_VIOLATION } from "./budget.js";
import { resolvePricing } from "./pricingStore.js";
import { measureUsage, locateTranscriptDir, defaultProjectsRoot } from "./transcripts.js";

const program = new Command();

program
  .name(TOOL_NAME)
  .description(
    "AI context cost profiler and linter — know what every AI coding request costs before it's sent",
  )
  .version(TOOL_VERSION);

program
  .command("scan")
  .description("Scan a repository for AI context sources and report baseline cost")
  .argument("[path]", "project path to scan", ".")
  .option("-c, --config <file>", "path to config file (default: ./ai-cost-audit.json)")
  .option(
    "-f, --format <format>",
    "output format: term | md | json | html (default: term on a terminal, md otherwise)",
  )
  .option("-o, --out <file>", "write the report to a file instead of stdout")
  .option("--ci", "run the budget gate: exit 1 on limit breach or growth over threshold")
  .option("--update-snapshot", "write .ai-cost-audit/snapshot.json (commit it for CI diffs)")
  .option("--no-global", "skip user-global files (~/.claude)")
  .option("--ref-depth <n>", "how many levels of @imports / links to follow", parseIntArg)
  .option(
    "--refresh-pricing",
    "fetch current prices from config.pricing.sourceUrl (default: offline, uses bundled dated prices)",
  )
  .option(
    "--measure",
    "read local Claude Code transcripts for this repo and report measured usage + actual cost",
  )
  .action(async (projectPath: string, options) => {
    try {
      const resolved = path.resolve(projectPath);
      const { config, configPath } = await loadConfig(resolved, options.config);

      if (options.global === false) config.includeGlobal = false;
      if (options.refDepth !== undefined) config.refDepth = options.refDepth;

      const { resolved: pricing, warning: pricingWarning } = await resolvePricing({
        refresh: options.refreshPricing === true,
        url: config.pricing.sourceUrl,
      });
      if (pricingWarning) process.stderr.write(pc.yellow(`${pricingWarning}\n`));

      const measured =
        options.measure === true ? measureUsage(resolved, pricing.table) : null;
      if (options.measure === true && measured === null) {
        process.stderr.write(
          pc.yellow(
            `No Claude Code transcripts found for this repo under ${defaultProjectsRoot()}.\n`,
          ),
        );
      }

      const snapshot = await readSnapshot(resolved);
      const { report, sources } = await runScan(resolved, config, snapshot, pricing, measured);

      // Default: rich output on a terminal, markdown when piped or written to
      // a file (so scripts and saved reports stay ANSI-free).
      const format = String(
        options.format ?? (!options.out && process.stdout.isTTY ? "term" : "md"),
      ).toLowerCase();
      let output: string;
      if (format === "json") output = renderJson(report);
      else if (format === "html") output = renderHtml(report, config);
      else if (format === "md") output = renderMarkdown(report, config);
      else if (format === "term") output = renderTerminal(report, config);
      else {
        process.stderr.write(
          pc.red(`Unknown format: ${options.format} (use term, md, json, or html)\n`),
        );
        process.exit(EXIT_ERROR);
        return;
      }

      if (options.out) {
        const outPath = path.resolve(options.out);
        await writeFile(outPath, output, "utf8");
        process.stderr.write(pc.green(`Report written to ${outPath}\n`));
      } else {
        process.stdout.write(output);
      }

      if (configPath === null) {
        process.stderr.write(
          pc.dim(`(no ai-cost-audit.json found — ran with defaults)\n`),
        );
      }

      // Nudge: real usage is sitting in local transcripts but wasn't used.
      if (options.measure !== true && locateTranscriptDir(resolved, defaultProjectsRoot())) {
        process.stderr.write(
          pc.dim(`(local Claude Code transcripts found — add --measure to use your actual usage)\n`),
        );
      }

      if (options.updateSnapshot) {
        const file = await writeSnapshot(resolved, sources, report.totals.gatedBaseline);
        process.stderr.write(pc.green(`Snapshot written to ${file} — commit it for CI diffs.\n`));
      }

      if (options.ci) {
        const gate = evaluateBudget(report.totals.gatedBaseline, sources, snapshot, config);
        for (const message of gate.messages) {
          process.stderr.write(
            (gate.pass ? pc.green(message) : pc.red(message)) + "\n",
          );
        }
        process.exit(gate.pass ? EXIT_PASS : EXIT_VIOLATION);
      }
    } catch (err) {
      process.stderr.write(
        pc.red(`Error: ${err instanceof Error ? err.message : String(err)}\n`),
      );
      process.exit(EXIT_ERROR);
    }
  });

function parseIntArg(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) throw new Error(`Invalid number: ${value}`);
  return n;
}

program.parseAsync(process.argv);
