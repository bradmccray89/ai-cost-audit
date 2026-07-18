# ai-cost-audit

**Know what every AI coding request costs before your developers send it.**

`ai-cost-audit` is a context cost **profiler and linter** for AI coding tools. It scans a
repository, finds everything that gets loaded into a model's context before a developer
types anything meaningful — `CLAUDE.md`, agent and skill definitions, MCP server configs,
Cursor rules, Copilot instructions, referenced docs — and tells you:

- how large your **guaranteed baseline** is (tokens loaded on *every* request),
- what it **costs per request and per day**, with and without prompt caching,
- how long your **monthly budget** actually lasts,
- where the **waste** is (duplicated guidance, oversized files, unbounded MCP configs),
- and it **fails CI** when the baseline exceeds your budget or grows too fast.

Everything runs **offline and deterministically** — no AI calls, no API key, no network.

```bash
npx ai-cost-audit scan
```

## Example output

```text
## Guaranteed Context (loaded on every request)

| Source kind                       | Tokens |
|-----------------------------------|-------:|
| Repository instructions           | 9,140  |
| Agent descriptions (always loaded)| 870    |
| MCP configuration                 | 31,260 |
| Referenced documentation          | 7,890  |
| **Repo total (CI-gated)**         | **49,160** |
| Global user files (not gated)     | 18,420 |

## Per-tool baselines

No single request loads every source — each tool loads only its own. Costs are
computed per tool, never from the cross-tool union. Tool overhead is the tool's
system prompt + built-in tool definitions, loaded before any repo file.

| Tool           | Repo   | Global | Tool overhead | Total baseline |
|----------------|-------:|-------:|--------------:|---------------:|
| Claude Code    | 48,270 | 18,420 |        15,000 | **81,690** |
| Cursor         |  3,980 |      0 |         9,000 | **12,980** |
| GitHub Copilot |  2,150 |      0 |         4,000 |  **6,150** |

## Estimated cost per request (baseline input only)

Claude Code (baseline 81,690 tokens)

| Model           | Uncached | With caching (typical) |
|-----------------|---------:|-----------------------:|
| claude-opus-4-8 | $0.41    | $0.09                  |

At 200 requests/day per developer (3 developers), your $100/month budget lasts ~1.9 days.

## High-impact findings

1. [warn] duplicate-content — 3,400 redundant tokens: identical content in CLAUDE.md, docs/standards.md
2. [warn] near-duplicate-content — ~2,100 redundant tokens: nearly identical content in 4 agent files
3. [warn] large-source — CLAUDE.md alone is 31% of the baseline
4. [info] unmeasured-mcp — 14 MCP server(s) counted by config size only
```

## What it scans

| Adapter | Sources | Classification |
|---|---|---|
| **claude-code** | `CLAUDE.md`, `CLAUDE.local.md`, `~/.claude/CLAUDE.md`, `.claude/agents/`, `.claude/skills/`, `.claude/commands/`, files pulled in via `@imports` and local links | Skills and agents are split: descriptions load every session (**guaranteed**), bodies load on demand (**conditional**) |
| **generic-mcp** | `.mcp.json`, `mcp.json` | Configured server JSON counted; live tool schemas flagged as unmeasured (see Honesty below) |
| **instructions** | `AGENTS.md`, `.cursor/rules/*.mdc`, `.cursorrules` (legacy), `.github/copilot-instructions.md`, `.github/**/*.instructions.md` | By tool convention |

Every source is tagged with the **tools that actually load it** (Claude Code,
Cursor, GitHub Copilot; `AGENTS.md` counts for all three). Baselines, costs, and
request ranges are reported per tool, because no single request crosses tools.

Sources are also bucketed three ways, and the report never pretends otherwise:

- **guaranteed** — loads on every request; measured from files.
- **conditional** — loads for some tasks (skills, commands, agent bodies, path-scoped rules); measured, reported separately.
- **variable** — conversation history, task files; **shown as configurable ranges, never point estimates**.

## CI budget gate

```bash
# One-time: write and commit the snapshot (lockfile pattern)
npx ai-cost-audit scan --update-snapshot
git add .ai-cost-audit/snapshot.json

# In CI:
npx ai-cost-audit scan --ci
```

The gate compares the **repo-scoped** baseline (global user files are reported but
excluded, so local and CI runs agree) against `baselineTokenLimit` and against the
committed snapshot's growth threshold. On failure it names the cause:

```text
AI context budget failed: baseline grew 72% (threshold 20%).
  Previous: 24,310 tokens
  Current:  41,822 tokens
  Change:   +72%
  Primary cause: Added backend-api-agent.md (+14,280 tokens)
```

Exit codes: `0` pass, `1` budget/growth violation, `2` execution error.

## Configuration

Drop an `ai-cost-audit.json` in your repo root (all fields optional — zero-config works):

```json
{
  "providers": ["anthropic"],
  "models": ["claude-opus-4-8", "claude-sonnet-5"],
  "monthlyBudget": 100,
  "developers": 3,
  "baselineTokenLimit": 30000,
  "growthThresholdPct": 20,
  "requestsPerDay": [50, 200, 1000],
  "cache": { "enabled": true, "requestsPerSession": 10 },
  "variable": {
    "conversationHistory": [8000, 25000],
    "taskFiles": [5000, 15000]
  },
  "mcp": { "knownSchemaTokens": { "github": 12000 } },
  "pricingOverrides": {
    "gpt": { "inputPerMTok": 2.5 },
    "my-fine-tune": { "inputPerMTok": 2.0, "provider": "anthropic" }
  },
  "systemOverheadTokens": { "claude-code": 18000, "copilot": 0 },
  "scan": { "exclude": ["**/node_modules/**", "test/fixtures/**"] }
}
```

`pricingOverrides` prices any model id, seeded or custom. The optional
`provider` field attaches a custom model to a known provider's tokenizer
calibration and cache modeling (otherwise: calibration 1.0, no cache model).
`systemOverheadTokens` replaces the shipped per-tool overhead estimates
(set 0 to exclude a tool's overhead).
`scan.exclude` globs are honored by all adapters and by `@import`/link following.

## CLI

```text
ai-cost-audit scan [path]
  -c, --config <file>    config file (default: ./ai-cost-audit.json)
  -f, --format <format>  md | json | html   (default: md)
  -o, --out <file>       write report to a file
  --ci                   run the budget gate (exit 1 on violation)
  --update-snapshot      write .ai-cost-audit/snapshot.json
  --no-global            skip user-global files (~/.claude)
  --ref-depth <n>        levels of @imports/links to follow (default: 3)
```

## The cost model (and why caching matters)

A naive `tokens × price × requests` estimate overstates real spend by up to ~10×,
because baseline context is exactly the part that prompt caching serves cheaply.
The report shows both figures:

- **Uncached:** `baseline_tokens × input_price` per request.
- **With caching (typical):** the first request of a session pays the cache-write
  multiplier (1.25× for Anthropic's 5-minute TTL), subsequent requests pay the read
  multiplier (0.1×). With `requestsPerSession = n`:
  `effective = (write + read × (n−1)) / n` — about **0.215×** at n=10.

The formula is printed in every report so the math is auditable. Baseline cost is
input-side only; output tokens depend on what the model generates and are out of scope.

## Honesty (read this)

- **Token counts are offline estimates.** There is no public offline tokenizer for
  Claude models. We count with `o200k_base` (exact for GPT models) and apply a
  disclosed per-provider calibration factor (anthropic ×1.2 by default, configurable).
  Expect ±~15–20% vs Anthropic's exact counts. No number in the report is presented
  as exact for Claude.
- **MCP schemas are usually the biggest unknown.** The tokens that actually enter
  context are each server's live tool schemas, which require a running server to
  measure. We count the configured JSON, flag every server `confidence: low`, and let
  you pin measured sizes via `mcp.knownSchemaTokens`. The real number is usually
  *much* larger — treat MCP lines as a floor, not a measurement.
- **Per-tool system overhead is a shipped estimate.** Each tool's system prompt
  and built-in tool definitions (often the majority of real guaranteed context)
  are counted via date-stamped constants, disclosed in every report and
  overridable via `systemOverheadTokens`. They vary by tool version and enabled
  features. Overhead is never part of the CI-gated number — the gate covers only
  content your repo controls.
- **Variable context is shown as ranges** you configure, never fake-precise numbers.
- **Pricing is date-stamped.** If the built-in table is more than 90 days old, the
  report warns you to verify and override via `pricingOverrides`.

## Roadmap

See [ROADMAP.md](ROADMAP.md) — the running, prioritized list of everything
planned before v1, from estimation-model work (turns vs API calls, output
tokens) to transcript-based measurement and discovery gaps.

## Development

```bash
npm install
npm test          # vitest
npm run build     # tsup -> dist/cli.js
node dist/cli.js scan test/fixtures/sample-repo
```

MIT
