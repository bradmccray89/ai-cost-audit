# ai-cost-audit

**Know what every AI coding request costs before your developers send it.**

`ai-cost-audit` is a context cost **profiler and linter** for AI coding tools. It scans a
repository, finds everything that gets loaded into a model's context before a developer
types anything meaningful — `CLAUDE.md`, agent and skill definitions, MCP server configs,
Cursor rules, Copilot instructions, referenced docs — and tells you:

- how large your **guaranteed baseline** is (tokens loaded on *every* request),
- what it **costs per turn and per day** (a turn = one message and its API calls), with and without prompt caching,
- how long your **monthly budget** actually lasts,
- where the **waste** is (duplicated guidance, oversized files, unbounded MCP configs),
- and it **fails CI** when the baseline exceeds your budget or grows too fast.

Everything runs **offline and deterministically by default** — no AI calls, no API
key, no network. The optional `--refresh-pricing` flag is the only thing that ever
reaches the network, and only when you pass it.

```bash
npx ai-cost-audit scan
```

## Example output

On a terminal you get an aligned, colorized version of this; the same data in
plain markdown (shown here) when piped or written with `-o`:

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

## Estimated cost per turn

Claude Code (baseline 81,690 tokens). A turn is one user message and the 1–15 API
calls it triggers — each re-sends the baseline. Output (500–4,000 tokens/turn) is
priced separately and never cached; Total = cached input + output:

| Model           | Input uncached | Input cached | Output      | Total/turn  |
|-----------------|---------------:|-------------:|------------:|------------:|
| claude-opus-4-8 | $0.41–$6.13    | $0.09–$0.68  | $0.01–$0.10 | $0.10–$0.78 |

At 200 turns/day per developer (3 developers), your $100/month budget lasts ~1.4–8.9 days.

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
  "turnsPerDay": [50, 200, 1000],
  "apiCallsPerTurn": [1, 15],
  "outputTokensPerTurn": [500, 4000],
  "cache": { "enabled": true, "turnsPerSession": 10, "ttl": "5m" },
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
  "pricing": { "sourceUrl": "https://raw.githubusercontent.com/you/your-fork/main/src/data/pricing.json" },
  "plan": "claude-max-5x",
  "scan": { "exclude": ["**/node_modules/**", "test/fixtures/**"] }
}
```

`pricingOverrides` prices any model id, seeded or custom. The optional
`provider` field attaches a custom model to a known provider's tokenizer
calibration and cache modeling (otherwise: calibration 1.0, no cache model).
`systemOverheadTokens` replaces the shipped per-tool overhead estimates
(set 0 to exclude a tool's overhead).
`pricing.sourceUrl` is where `--refresh-pricing` fetches from (defaults to the
committed data file on this repo's `main`).
`scan.exclude` globs are honored by all adapters and by `@import`/link following.

## CLI

```text
ai-cost-audit scan [path]
  -c, --config <file>    config file (default: ./ai-cost-audit.json)
  -f, --format <format>  term | md | json | html
                         (default: term on a terminal, md when piped or with -o)
  -o, --out <file>       write report to a file
  --ci                   run the budget gate (exit 1 on violation)
  --update-snapshot      write .ai-cost-audit/snapshot.json
  --no-global            skip user-global files (~/.claude)
  --ref-depth <n>        levels of @imports/links to follow (default: 3)
  --refresh-pricing      fetch current prices from config.pricing.sourceUrl
                         (default: offline; uses bundled dated prices)
  --measure              read local Claude Code transcripts for this repo and
                         report measured usage + actual cost (offline, no key)
```

## The cost model (turns, API calls, and caching)

Two corrections separate this from a naive `tokens × price × requests` estimate,
and they pull in opposite directions:

1. **Caching makes the baseline cheap.** Baseline context is exactly the part
   prompt caching serves at the read multiplier, so a naive estimate *overstates*.
2. **A turn is many API calls.** One user message in an agentic tool triggers
   several API calls (tool-use round trips), and *each one re-sends the baseline*.
   So the per-turn cost is roughly `apiCallsPerTurn ×` the per-call cost — a naive
   single-call estimate *understates* the turn.

The tool models both. A **turn** is one user message and the `apiCallsPerTurn`
`[min, max]` calls it triggers; costs are shown as ranges across that span:

- **Uncached/turn:** `per_call_input_cost × calls` — every call pays the full baseline.
- **With caching/turn:** the first API call of a session pays the cache-write
  multiplier (Anthropic: **1.25× at the 5-minute TTL, 2× at the 1-hour TTL**, set
  via `cache.ttl`); every later call across the session pays the read multiplier
  (0.1×). Over `S = calls × turnsPerSession` session calls:
  `effective_per_call = (write + read × (S−1)) / S`, and the turn pays `calls ×`
  that. (At `apiCallsPerTurn = [1,1]` and 5m TTL this reduces to the classic
  ~0.215× single-request figure.)

  `cache.ttl` picks the write multiplier only; how many turns actually reuse a
  cache entry is modeled by `turnsPerSession`. Sparse usage with gaps longer than
  the TTL re-pays writes more often than this single-write-per-session model
  assumes — another reason measured transcripts (roadmap) beat configured guesses.

**Output tokens** are added as a separate line: `outputTokensPerTurn × output_price`,
never cached (output is generated fresh every turn at full price). Output is priced
~5× input and is commonly 20–40% of real spend, so the report shows a per-turn
**Total = cached input + output**, and daily/runway figures use that all-in total.

`apiCallsPerTurn` and `outputTokensPerTurn` are rough defaults; tune them to your
workflow, or measure them with `--measure` (below). The formula is printed in every
report so the math is auditable.

## Measured mode (`--measure`) — your actual usage, not a guess

The estimate above turns your repo's token inventory into a cost using generic
assumptions. `--measure` replaces the guessing with **ground truth** read from your
local Claude Code transcripts (`~/.claude/projects/**/*.jsonl`) — still offline, no
API key, no network:

```bash
npx ai-cost-audit scan --measure
```

It reports, for this exact repo, what actually happened — measured API calls/turn,
output tokens/turn, cache read rate and TTL split, average context per call, session
duration, a **per-model cost breakdown** (which models drove the spend), a
**cost composition** (cache reads vs writes vs output), and the **actual dollars
spent** (priced from the recorded per-call token usage, including the 5m/1h
cache-write split) — each shown next to the configured assumption so the gap is
visible. When measured data exists, the report **leads with it** and demotes the generic
estimate to a one-line CI baseline — the estimate prices only the always-loaded repo
context, so it can't predict a real session's cost (dominated by conversation history
and files read while working), and the report **explains that gap** rather than
scoring the estimate against reality. It also **projects forward from your measured
$/turn** —
team-wide cost at each volume scenario, at your real measured pace, and how long your
budget lasts. This forecast is grounded in real per-turn cost, not the generic
assumptions, so it's the setup-specific number. Real sessions routinely show far more
calls and output per turn than the defaults assume.

### Plan advisor: subscription vs API

Because measured cost is priced at **API rates**, `--measure` can answer the
question a subscription user actually has: *am I on the right plan?* It compares
your API-equivalent monthly usage against subscription tiers (per developer) and
recommends staying, switching to API pay-as-you-go, or changing tier:

```text
PLAN ADVISOR  (per developer, at $3,770/mo API-equivalent)
  Claude Pro          $20    ← cheapest
  Claude Max 5x       $100   current
  Claude Max 20x      $200
  API pay-as-you-go   $3,770*
  → a subscription is far cheaper than API at your volume — verify the tier
    sustains your usage before downgrading.
```

Set your plan with `config.plan` (a bundled id like `"claude-max-5x"`, or a custom
`{ "label": "...", "monthlyUSD": 100 }`). Plan **prices** are dated, disclosed, and
overridable (`src/data/plans.json`); plan **limits** are *not* published as token
quotas, so the advisor is deliberately direction-focused (subscription vs API) and
caveats tier selection rather than pretending to know exact throttle points.

Currently Claude Code only (that's where local transcripts live); Cursor/Copilot
have no comparable local logs.

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
- **Pricing is dated data, not code.** Prices live in a bundled
  `pricing.json` with an `asOf` date and per-model effective-date ranges, so a
  known change like an introductory-pricing window resolves correctly by scan
  date with no update. Every report discloses the date, origin (`bundled` vs
  `remote`), and source. Runs are offline and deterministic by default; pass
  `--refresh-pricing` to fetch the latest from `pricing.sourceUrl` (falls back
  to bundled, loudly, on any failure). If the bundled data is more than 90 days
  old the report warns you to refresh or override via `pricingOverrides`.

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
