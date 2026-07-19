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
- [x] Readable terminal output — dedicated `term` format (aligned columns, color),
      default on a TTY; piped/`-o` output stays plain markdown
- [x] Pricing as dated data — `src/data/pricing.json` with `asOf` + per-model
      effective-date ranges (fixes Sonnet 5 intro window by scan date), staleness
      keyed to `asOf`, `--refresh-pricing` fetches from `pricing.sourceUrl` with
      bundled fallback; reports disclose date + origin + source

## 1. Estimation correctness — the numbers must survive comparison with a real invoice

- [x] **Model turns vs API calls.** `apiCallsPerTurn` `[min,max]` range (default
      [1,15]); a turn = one message + its API calls, each re-sending the baseline.
      Per-turn costs are ranges; cache write amortized over `calls × turnsPerSession`
      session calls. Config renamed requests→turns. Still a configured guess —
      transcript measurement (tier 2) replaces it with per-user data. Left open:
      per-call *growing history* is still only in the variable range, not per-turn cost.
- [x] **Output token modeling.** `outputTokensPerTurn` `[min,max]` range (default
      [500,4000]), priced at the output rate, never cached, shown as a separate
      column with an all-in per-turn Total (cached input + output); daily/runway now
      use the total. Still a generic configured range — transcript measurement
      (tier 2) replaces it with measured `output_tokens` per turn.
- [ ] **Verify system overhead constants empirically.** Current 15k/9k/4k are
      estimates. Measure Claude Code's via `/context` in a bare repo or a
      transcript's first-request usage; re-stamp `SYSTEM_OVERHEAD_AS_OF`.
      Cursor/Copilot need at least a documented methodology.
- [ ] **Validate the ×1.2 anthropic calibration.** One-time benchmark against the
      `count_tokens` API over a corpus of real instruction files; publish the
      error distribution in the README. The validation data is the marketing.
- [ ] **`--accurate` flag.** Exact counts via Anthropic `count_tokens` (opt-in,
      needs a key). Cheap to build, large credibility win.
- [x] **Cache TTL as a config axis.** `cache.ttl` ("5m" → 1.25× write, "1h" → 2×
      write); read stays 0.1×. Formula disclosure shows the active TTL. Note left
      open: idle gaps > TTL re-pay writes — the single-write-per-session model
      still doesn't capture sparse usage; measured transcripts (tier 2) would.

## 2. Measurement over estimation — the product wedge

- [x] **Read Claude Code local transcripts** (`~/.claude/projects/**/*.jsonl`) via
      `scan --measure`. Measures calls/turn, output/turn, cache read rate + TTL split,
      turns/day, avg context/call, and **actual $ spent** (priced from recorded token
      usage); reconciles estimate vs actual; shows measured next to configured.
      Offline, no key. First slice done — follow-ups below:
  - [x] Auto-tailor the projection from measured usage. `projectMeasured()` scales
        the measured actual $/turn across the configured volume scenarios, the
        developer's real measured pace, and the team, with runway — a setup-specific
        forward forecast grounded in real cost (not the generic formula). Rendered
        in the measured section across all formats.
  - [x] Per-model cost breakdown + session duration + cost composition (cache
        reads/writes/output/fresh input) in the measured section. Answers "which
        model, how long, where did the money go." Profile now carries `tool`,
        `byModel`, `durationHours`, `composition`.
  - [ ] Attribute cost to specific context (per-file / per-CLAUDE.md dollar impact)
        — "your CLAUDE.md cost you $X"; needs mapping cached prefix to sources.
  - [ ] Multi-tool spend rollup (personal): flat-subscription tools (Copilot,
        ChatGPT, Claude plan) from config + measured Claude Code = total AI spend.
        Per-model only where per-token data exists; flat tools have no per-model cost.
  - [ ] Use measured cached-prefix size to validate the ×1.2 calibration and the
        system-overhead constants empirically (closes two tier-1 items with real data).
- [ ] **Measure MCP schemas** with opt-in `--measure-mcp`: spawn stdio servers
      from the config command, do an MCP `initialize` + `tools/list` handshake,
      tokenize the actual schemas. Closes the biggest self-declared unknown.
- [ ] **Bundled catalog** of measured schema sizes for popular MCP servers
      (github, postgres, playwright, …) as static data fallback.
- [ ] **Predicted-vs-actual reconciliation** against the Anthropic usage/cost API
      (org-wide, opt-in) once transcript reading exists locally.

## 2b. Plan advisor — subscription vs API (spend-optimization angle)

- [x] **Plan-vs-API advisor.** `scan --measure` compares measured API-equivalent
      monthly usage against subscription tiers (bundled, dated, overridable
      `plans.json`; `config.plan` for current), recommends stay/switch/tier with a
      direction-focused, limit-caveated recommendation. Measured cost relabeled
      "at API rates." Claude tiers only for now.
- [ ] **Usage vs plan allowance** (feature #1) — needs a per-plan usage-limit model;
      Anthropic limits are rolling-window/weekly, not published as token quotas.
      Blocked on sourcing limit data (config-provided, empirical-from-throttling, or
      disclosed estimates).
- [ ] **Plan-token runway / forecast** (feature #2) — "at your trend you'll hit your
      weekly limit by Thursday." Same limit-data dependency as above.
- [ ] Detect throttle/limit events in transcripts to *infer* the effective ceiling
      empirically — would unblock #1 and #2 without external limit data.

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
- [ ] **Scheduled pricing-update PRs.** The data file + `--refresh-pricing` shipped
      (see Done); what's left is keeping the hosted file fresh without a human
      watching: a GitHub Action that parses Anthropic's published prices, diffs
      against `pricing.json`, and opens a PR on change (open a PR for review, not
      auto-merge — a page-layout change should fail loudly, not ship wrong numbers).
      There is no official machine-readable Anthropic pricing feed, so the fetch
      parses the docs page or a third-party feed; own the numbers, don't trust a
      feed blindly.
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
