export type Usage = "guaranteed" | "conditional" | "variable";
export type Confidence = "high" | "medium" | "low";
export type Scope = "repo" | "global";
export type Severity = "info" | "warn" | "error";
/** Prompt-cache time-to-live. Anthropic: 5-minute (1.25× write) or 1-hour (2× write). */
export type CacheTtl = "5m" | "1h";

/**
 * A tool that actually loads context sources. Baselines and costs are computed
 * per consumer: no single request ever loads CLAUDE.md AND Cursor rules AND
 * Copilot instructions, so summing across tools inflates every estimate.
 */
export type Consumer = "claude-code" | "cursor" | "copilot";

export interface ContextSource {
  /** Repo-relative path; global files are prefixed with "~". */
  path: string;
  adapter: "claude-code" | "generic-mcp" | "instructions";
  kind:
    | "repo-instructions"
    | "local-instructions"
    | "global-instructions"
    | "agent"
    | "agent-description"
    | "skill-description"
    | "skill-body"
    | "command"
    | "mcp-config"
    | "cursor-rules"
    | "copilot-instructions"
    | "referenced-doc";
  usage: Usage;
  scope: Scope;
  /** Tools that load this source into context. */
  consumers: Consumer[];
  /** Calibrated token estimate for this source. */
  tokens: number;
  confidence: Confidence;
  /** Inferences and caveats, e.g. "live MCP schema not measured". */
  note?: string;
  /** Set when the source was pulled in via an @import or markdown link. */
  referencedFrom?: string;
  /** Raw text, retained for duplication analysis. Not serialized in reports. */
  text: string;
}

export interface ContextAdapter {
  name: string;
  discover(projectPath: string, cfg: Config): Promise<ContextSource[]>;
}

export interface Finding {
  /** Stable rule ID, e.g. "duplicate-content". */
  rule: string;
  severity: Severity;
  message: string;
  /** Implicated source paths. */
  sources: string[];
  /** Tokens at stake, used for ranking. */
  tokens?: number;
}

export interface ModelPricing {
  /** Model ID, e.g. "claude-opus-4-8". */
  id: string;
  provider: string;
  /** USD per 1M input tokens. null = user must set in config. */
  inputPerMTok: number | null;
  /** USD per 1M output tokens. */
  outputPerMTok: number | null;
  note?: string;
}

export interface ProviderInfo {
  /** Multiplier applied to the o200k_base count to approximate this provider's tokenizer. */
  calibration: number;
  /**
   * Prompt-cache cost multipliers relative to base input price. Absent = no
   * cache modeling. Write cost depends on the cache TTL; read is TTL-independent.
   */
  cache?: { read: number; write: Record<CacheTtl, number> };
}

/** An inclusive low–high USD range, reflecting the apiCallsPerTurn range. */
export interface MoneyRange {
  min: number;
  max: number;
}

export interface DailyProjection {
  turnsPerDay: number;
  uncached: MoneyRange | null;
  cached: MoneyRange | null;
}

export interface ModelCost {
  /** The tool whose baseline this cost is computed from. */
  consumer: Consumer;
  model: string;
  provider: string;
  /**
   * USD per user turn, baseline input only, no caching. A turn is one user
   * message and the several API calls (tool-use round trips) it triggers; each
   * call re-sends the baseline, so the range spans apiCallsPerTurn min..max.
   */
  perTurnUncached: MoneyRange | null;
  /** USD per turn, steady-state with prompt caching. null if no cache model. */
  perTurnCached: MoneyRange | null;
  /** USD of output tokens per turn (never cached). null if no output pricing. */
  outputPerTurn: MoneyRange | null;
  /** All-in USD per turn: cached input (or uncached if no cache) + output. */
  totalPerTurn: MoneyRange | null;
  /** USD per day for each configured turns/day scenario (all-in total). */
  daily: DailyProjection[];
  /** Days the monthly budget lasts (team-wide), cached model when available. */
  runwayDays: MoneyRange | null;
}

export interface ConsumerTotals {
  /** Repo-scoped guaranteed tokens this tool loads. */
  gated: number;
  /** Global (user-level) guaranteed tokens this tool loads. */
  global: number;
  /** gated + global — the file-derived portion of this tool's baseline. */
  guaranteed: number;
  /**
   * The tool's own system prompt + built-in tool definitions — loaded before
   * any repo file. Shipped estimate, overridable via config.systemOverheadTokens.
   */
  systemOverhead: number;
  /** guaranteed + systemOverhead — the baseline cost estimates are computed from. */
  total: number;
}

export interface ReportTotals {
  /**
   * Union of repo-scoped guaranteed tokens across all tools — the CI-gated
   * number. This is what the repo ships, not what any one request loads;
   * per-request numbers live in byConsumer.
   */
  gatedBaseline: number;
  /** Union of global (user-level) guaranteed tokens, reported but not gated. */
  globalBaseline: number;
  guaranteed: number;
  conditional: number;
  /** Per-tool baselines — the numbers cost estimates are computed from. */
  byConsumer: Record<string, ConsumerTotals>;
  byKind: Record<string, number>;
  byAdapter: Record<string, number>;
}

export interface Stats {
  min: number;
  median: number;
  max: number;
}

/** Per-model usage aggregate within a measured tool. */
export interface ModelUsage {
  model: string;
  calls: number;
  outputTokens: number;
  /** Cached-prefix tokens seen (cache_read + cache_creation). */
  contextTokens: number;
  costUSD: number;
  /** costUSD / total cost, 0..1. */
  share: number;
}

/** Where the measured cost went, in USD (sums to actualCostUSD). */
export interface CostComposition {
  cacheRead: number;
  cacheWrite: number;
  freshInput: number;
  output: number;
}

/** Measured usage read from local Claude Code transcripts (ground truth). */
export interface UsageProfile {
  /** The tool these transcripts belong to (e.g., "Claude Code"). */
  tool: string;
  sessions: number;
  apiCalls: number;
  turns: number;
  firstAt: string;
  lastAt: string;
  /** Wall-clock hours between first and last event. */
  durationHours: number;
  activeDays: number;
  models: string[];
  /** Per-model breakdown of calls, tokens, and cost. */
  byModel: ModelUsage[];
  /** Decomposition of actualCostUSD by token type. */
  composition: CostComposition;
  apiCallsPerTurn: Stats;
  outputTokensPerTurn: Stats;
  turnsPerDay: number;
  cacheReadRate: number;
  ttlSplit: Record<CacheTtl, number>;
  avgContextTokens: number;
  actualCostUSD: number;
  actualCostPerTurn: number;
  unpricedCalls: number;
}

export interface Plan {
  id: string;
  label: string;
  monthlyUSD: number;
  note?: string;
}

export interface PlanOption {
  id: string;
  label: string;
  monthlyUSD: number;
  isCurrent: boolean;
  /** True for the API pay-as-you-go option (cost varies with usage). */
  isApi: boolean;
}

/** Plan-vs-API guidance from measured usage. */
export interface PlanAdvice {
  /** Measured API-equivalent monthly cost per developer (usage at API rates). */
  apiEquivMonthly: number;
  /** Measured turns/day per developer used for the projection. */
  turnsPerDay: number;
  /** All plan tiers plus API pay-as-you-go, sorted cheapest first. */
  options: PlanOption[];
  cheapest: PlanOption;
  /** The configured current plan, if config.plan is set. */
  current: PlanOption | null;
  /** current.monthlyUSD - cheapest.monthlyUSD; positive = savings available. */
  savingsVsCurrent: number | null;
  /** Date stamp of the bundled plan data. */
  asOf: string;
}

export interface Report {
  meta: {
    tool: string;
    version: string;
    scannedAt: string;
    projectPath: string;
    pricingAsOf: string;
    pricingStale: boolean;
    /** Where the prices came from: "bundled" or "remote". */
    pricingOrigin: "bundled" | "remote";
    /** The pricing source: a URL when refreshed, else the table's own source. */
    pricingSource: string;
    /** Date stamp of the shipped per-tool system-overhead estimates. */
    systemOverheadAsOf: string;
    calibration: Record<string, number>;
    cacheFormula: string;
    disclosure: string;
  };
  totals: ReportTotals;
  sources: Omit<ContextSource, "text">[];
  costs: ModelCost[];
  /** Per-tool token range for a single API call (baseline + variable context). */
  requestRanges: Record<string, { min: number; max: number }>;
  findings: Finding[];
  /** Measured usage from local transcripts, when --measure is used and found. */
  measured: UsageProfile | null;
  /** Plan-vs-API guidance, when measured usage is available. */
  planAdvice: PlanAdvice | null;
}

export interface SnapshotEntry {
  path: string;
  tokens: number;
}

export interface Snapshot {
  version: 1;
  createdAt: string;
  gatedBaseline: number;
  sources: SnapshotEntry[];
}

export interface Config {
  providers: string[];
  models: string[];
  monthlyBudget: number | null;
  developers: number;
  baselineTokenLimit: number | null;
  growthThresholdPct: number;
  /** A turn is one user message and the API calls it triggers (see apiCallsPerTurn). */
  turnsPerDay: number[];
  /** API calls (tool-use round trips) per user turn, as a [min, max] range. */
  apiCallsPerTurn: [number, number];
  /** Total output tokens generated per user turn, as a [min, max] range. */
  outputTokensPerTurn: [number, number];
  cache: { enabled: boolean; turnsPerSession: number; ttl: CacheTtl };
  variable: { conversationHistory: [number, number]; taskFiles: [number, number] };
  calibration: Record<string, number>;
  /** Per-tool override of the shipped system-overhead estimates. 0 excludes it. */
  systemOverheadTokens: Record<string, number>;
  pricingOverrides: Record<
    string,
    { inputPerMTok: number; outputPerMTok?: number; provider?: string }
  >;
  mcp: { knownSchemaTokens: Record<string, number> };
  pricing: { sourceUrl: string };
  /** Current subscription: a bundled plan id, a custom {label, monthlyUSD}, or null. */
  plan: string | { label: string; monthlyUSD: number } | null;
  duplication: { minBlockTokens: number; similarityThreshold: number };
  scan: { exclude: string[] };
  refDepth: number;
  includeGlobal: boolean;
}
