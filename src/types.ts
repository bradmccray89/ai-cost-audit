export type Usage = "guaranteed" | "conditional" | "variable";
export type Confidence = "high" | "medium" | "low";
export type Scope = "repo" | "global";
export type Severity = "info" | "warn" | "error";

export interface ContextSource {
  /** Repo-relative path; global files are prefixed with "~". */
  path: string;
  adapter: "claude-code" | "generic-mcp" | "instructions";
  kind:
    | "repo-instructions"
    | "local-instructions"
    | "global-instructions"
    | "agent"
    | "skill-description"
    | "skill-body"
    | "command"
    | "mcp-config"
    | "cursor-rules"
    | "copilot-instructions"
    | "referenced-doc";
  usage: Usage;
  scope: Scope;
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
  /** Prompt-cache cost multipliers relative to base input price. Absent = no cache modeling. */
  cache?: { write: number; read: number };
}

export interface ModelCost {
  model: string;
  provider: string;
  /** USD per request, baseline input only, no caching. */
  perRequestUncached: number | null;
  /** USD per request, steady-state with prompt caching. null if provider has no cache model. */
  perRequestCached: number | null;
  /** USD per day for each configured requests/day scenario. */
  daily: { requestsPerDay: number; uncached: number | null; cached: number | null }[];
  /** Days the monthly budget lasts (team-wide), cached model when available. */
  runwayDays: number | null;
}

export interface ReportTotals {
  /** Repo-scoped guaranteed tokens — the CI-gated number. */
  gatedBaseline: number;
  /** Global (user-level) guaranteed tokens, reported but not gated. */
  globalBaseline: number;
  guaranteed: number;
  conditional: number;
  byKind: Record<string, number>;
  byAdapter: Record<string, number>;
}

export interface Report {
  meta: {
    tool: string;
    version: string;
    scannedAt: string;
    projectPath: string;
    pricingAsOf: string;
    pricingStale: boolean;
    calibration: Record<string, number>;
    cacheFormula: string;
    disclosure: string;
  };
  totals: ReportTotals;
  sources: Omit<ContextSource, "text">[];
  costs: ModelCost[];
  requestRange: { min: number; max: number };
  findings: Finding[];
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
  requestsPerDay: number[];
  cache: { enabled: boolean; requestsPerSession: number };
  variable: { conversationHistory: [number, number]; taskFiles: [number, number] };
  calibration: Record<string, number>;
  pricingOverrides: Record<string, { inputPerMTok: number; outputPerMTok?: number }>;
  mcp: { knownSchemaTokens: Record<string, number> };
  duplication: { minBlockTokens: number; similarityThreshold: number };
  scan: { include: string[]; exclude: string[] };
  refDepth: number;
  includeGlobal: boolean;
}
