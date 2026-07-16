import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { loadConfig } from "./config.js";
import { runScan, TOOL_NAME, TOOL_VERSION } from "./scan.js";
import { renderMarkdown } from "./report/markdown.js";
import { renderJson } from "./report/json.js";
import { renderHtml } from "./report/html.js";
import { readSnapshot, writeSnapshot } from "./snapshot.js";
import { evaluateBudget, EXIT_ERROR, EXIT_PASS, EXIT_VIOLATION } from "./budget.js";

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
  .option("-f, --format <format>", "output format: md | json | html", "md")
  .option("-o, --out <file>", "write the report to a file instead of stdout")
  .option("--ci", "run the budget gate: exit 1 on limit breach or growth over threshold")
  .option("--update-snapshot", "write .ai-cost-audit/snapshot.json (commit it for CI diffs)")
  .option("--no-global", "skip user-global files (~/.claude)")
  .option("--ref-depth <n>", "how many levels of @imports / links to follow", parseIntArg)
  .action(async (projectPath: string, options) => {
    try {
      const resolved = path.resolve(projectPath);
      const { config, configPath } = await loadConfig(resolved, options.config);

      if (options.global === false) config.includeGlobal = false;
      if (options.refDepth !== undefined) config.refDepth = options.refDepth;

      const snapshot = await readSnapshot(resolved);
      const { report, sources } = await runScan(resolved, config, snapshot);

      const format = String(options.format).toLowerCase();
      let output: string;
      if (format === "json") output = renderJson(report);
      else if (format === "html") output = renderHtml(report, config);
      else if (format === "md") output = renderMarkdown(report, config);
      else {
        process.stderr.write(pc.red(`Unknown format: ${options.format} (use md, json, or html)\n`));
        process.exit(EXIT_ERROR);
        return;
      }

      if (options.out) {
        const outPath = path.resolve(options.out);
        await writeFile(outPath, output, "utf8");
        process.stderr.write(pc.green(`Report written to ${outPath}\n`));
      } else {
        process.stdout.write(format === "md" ? colorize(output) : output);
      }

      if (configPath === null) {
        process.stderr.write(
          pc.dim(`(no ai-cost-audit.json found — ran with defaults)\n`),
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

/** Light terminal colorization of the markdown report. */
function colorize(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("# ")) return pc.bold(pc.cyan(line));
      if (line.startsWith("## ")) return pc.bold(line);
      if (/^\d+\. \*\*\[error\]/.test(line)) return pc.red(line);
      if (/^\d+\. \*\*\[warn\]/.test(line)) return pc.yellow(line);
      if (/^\d+\. \*\*\[info\]/.test(line)) return pc.blue(line);
      if (line.startsWith("*") && line.endsWith("*")) return pc.dim(line);
      return line;
    })
    .join("\n");
}

program.parseAsync(process.argv);
