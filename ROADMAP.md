# Roadmap to v1

Running list of what must land before this is sellable. Ordered by how much each
item changes the defensibility of the numbers — estimation correctness first,
then measurement, then breadth, then product. Check items off as they land;
add new findings at the appropriate tier, not the bottom.

## Done (v0.1.x)

- [x] Windows path separators — forward slashes everywhere; snapshots portable across OSes
- [x] `scan.exclude` actually honored (dead `scan.include` removed)
- [x] `pricingOverrides` works for custom model ids (`provider` field attaches calibration/cache)
- [x] Agent descriptions counted in guaranteed baseline (split like skills)
- [x] Per-tool baselines — costs computed per consumer, never from the cross-tool union
- [x] Per-tool system overhead constants (shipped, date-stamped, overridable)

## 1. Estimation correctness — the numbers must survive comparison with a real invoice

- [ ] **Model turns vs API calls.** One user turn in an agentic tool is 10–50 API
      calls; each re-sends baseline + growing history (mostly cache reads, but
      0.1× on 100k+ context adds up). Add `apiCallsPerTurn` (configurable range,
      later measured from transcripts) and make "requests/day" explicitly mean
      user turns. This is the last ~10× error in the model.
- [ ] **Output token modeling.** Output is priced 5× input and is 20–40% of real
      spend. Add a configurable output-tokens-per-turn range (like `variable`),
      shown as a separate disclosed line.
- [ ] **Verify system overhead constants empirically.** Current 15k/9k/4k are
      estimates. Measure Claude Code's via `/context` in a bare repo or a
      transcript's first-request usage; re-stamp `SYSTEM_OVERHEAD_AS_OF`.
      Cursor/Copilot need at least a documented methodology.
- [ ] **Validate the ×1.2 anthropic calibration.** One-time benchmark against the
      `count_tokens` API over a corpus of real instruction files; publish the
      error distribution in the README. The validation data is the marketing.
- [ ] **`--accurate` flag.** Exact counts via Anthropic `count_tokens` (opt-in,
      needs a key). Cheap to build, large credibility win.
- [ ] **Cache TTL as a config axis.** 5-min (1.25× write) vs 1-hour (2× write);
      idle gaps between turns re-pay writes — `requestsPerSession` alone doesn't
      capture sparse usage.

## 2. Measurement over estimation — the product wedge

- [ ] **Read Claude Code local transcripts** (`~/.claude/projects/**/*.jsonl`).
      Per-API-call token usage, cache hits, output tokens — real, offline, no key.
      Calibrates every config guess (calls/turn, requests/session, history sizes)
      and enables the killer line: "your CLAUDE.md cost you $X last month."
      This turns an estimator into an auditor; ccusage tracks spend, we attribute it.
- [ ] **Measure MCP schemas** with opt-in `--measure-mcp`: spawn stdio servers
      from the config command, do an MCP `initialize` + `tools/list` handshake,
      tokenize the actual schemas. Closes the biggest self-declared unknown.
- [ ] **Bundled catalog** of measured schema sizes for popular MCP servers
      (github, postgres, playwright, …) as static data fallback.
- [ ] **Predicted-vs-actual reconciliation** against the Anthropic usage/cost API
      (org-wide, opt-in) once transcript reading exists locally.

## 3. Discovery gaps — undercounting what actually loads

- [ ] **Nested + parent CLAUDE.md.** Claude Code walks up from cwd and loads
      subtree CLAUDE.md files. Monorepos are the best customers and where this
      bites hardest.
- [ ] **Global scope beyond `~/.claude/CLAUDE.md`:** `~/.claude/agents/`,
      `~/.claude/commands/`, user-level MCP (`~/.claude.json`,
      `.claude/settings.json`), enterprise managed settings.
- [ ] **More MCP config locations:** `.cursor/mcp.json`, `.vscode/mcp.json`.
- [ ] **Parse `.mdc` frontmatter** (`alwaysApply`, `globs`) so scoped Cursor
      rules classify as conditional instead of guaranteed (~20 lines, removes a
      systematic overcount).
- [ ] **Other tools' rule files:** `.windsurfrules`, `.clinerules`, `GEMINI.md` —
      each becomes a consumer or maps to an existing one.

## 4. Infrastructure & polish

- [ ] **CI matrix (Linux + Windows)** — the path-separator class of bug must not
      be able to return. No CI workflow exists yet at all.
- [ ] **Pricing as versioned remote JSON** with the built-in table as offline
      fallback (opt-in fetch preserves the offline promise). A 90-day staleness
      warning otherwise makes every release look broken on a timer.
- [ ] **`TOOL_VERSION` drift** — `scan.ts` hardcodes 0.1.0 separately from
      package.json; read it at build time.
- [ ] **Finding suppression** (`--ignore <rule>` / config) — needed before CI
      adoption in real repos with intentional exceptions.
- [ ] **`formatUSD` shows `$0.0000`** for tiny nonzero values — bump precision or
      switch to per-1k-requests framing for sub-cent figures.
- [ ] **`npm audit`: 5 findings** in the vitest 2.x dev-dependency chain —
      resolve before publishing (vitest 3 upgrade likely clears it).

## 5. Product (post-correctness, pre-launch)

- [ ] **GitHub App PR comments** — "this PR adds 14,280 tokens ≈ $210/mo at your
      usage" — the bundle-size-bot playbook; snapshot/growth machinery is 80%
      of it. This is the paid wedge.
- [ ] **Findings engine expansion:** dead references (instructions pointing at
      deleted paths), stale instructions contradicting the codebase, per-finding
      dollar impact (needs the turns model above).
- [ ] **Historical trend output** (`--format json` over time → chart) as the
      dashboard seed.
