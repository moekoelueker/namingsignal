/** Shared, framework-independent contracts used by the web, API, CLI, and agents. */

export type EvidenceStatus = "confirmed" | "inferred" | "unknown" | "manual";
export type EvidenceConfidence = number | "high" | "medium" | "low";

export interface Evidence<T = unknown> {
  id?: string;
  label?: string;
  provider: string;
  sourceUrl: string;
  checkedAt: string;
  status: EvidenceStatus;
  confidence: EvidenceConfidence;
  value?: T;
  detail?: string;
}

export type DomainState =
  | "registered"
  | "likely_available"
  | "premium"
  | "parked"
  | "active"
  | "unsupported"
  | "unknown";

export interface DomainResult {
  domain: string;
  status: DomainState;
  evidence: Evidence;
  checkedAt: string;
  provider: string;
  detail?: string;
  manualUrl?: string;
  responseCode?: number;
  cached?: boolean;
  latencyMs?: number;
}

export type NamespaceKind =
  | "npm"
  | "pypi"
  | "apple_app_store"
  | "github"
  | "google_play"
  | "chrome_web_store"
  | "x"
  | "instagram"
  | "linkedin"
  | "youtube";

export type NamespaceState = "taken" | "likely_available" | "unknown" | "manual" | "conflict";

export interface NamespaceResult {
  namespace: NamespaceKind | string;
  label: string;
  status: NamespaceState;
  url: string;
  evidence: Evidence;
  detail?: string;
  responseCode?: number;
  cached?: boolean;
}

export interface ManualLink {
  label: string;
  url: string;
  reason?: string;
}

export interface BriefEvidence {
  source: string;
  excerpt: string;
  field?: "product" | "primaryUser" | "pain" | "outcome" | "mechanism" | "futureExpansion" | "avoid";
}

export interface ProjectBrief {
  product: string;
  primaryUser: string;
  pain: string;
  outcome: string;
  mechanism: string;
  platform: string[];
  acquisitionChannels: string[];
  brandTone: string[];
  futureExpansion: string;
  domainRequirements: string[];
  avoid: string[];
  uncertainties: string[];
  evidence: BriefEvidence[];
}

export type Brief = ProjectBrief;

export interface CompileBriefInput {
  text: string;
  source?: string;
  overrides?: Partial<ProjectBrief>;
}

export type CandidateVein =
  | "outcome"
  | "mechanism"
  | "metaphor"
  | "trust"
  | "workflow"
  | "lateral"
  | "coined"
  | "numeric"
  | string;

export interface Candidate {
  name: string;
  normalized: string;
  vein: CandidateVein;
  rationale: string;
  category?: string;
  provider?: string;
  score?: NameScore;
  domains?: DomainResult[];
  namespaces?: NamespaceResult[];
}

export type GeneratedCandidate = Candidate;

export interface NameCandidateInput {
  name: string;
  category?: string;
  normalized?: string;
  vein?: CandidateVein;
  rationale?: string;
  domains?: DomainResult[];
  namespaces?: NamespaceResult[];
}

export interface FallbackCandidateOptions {
  count?: number;
  avoid?: string[];
  existingNames?: string[];
  veins?: CandidateVein[];
}

export type ScoreDimensionSource = "mechanical" | "brief" | "evidence" | "human";

export interface ScoreDimension {
  key: string;
  label: string;
  score: number;
  weight: number;
  note: string;
  source: ScoreDimensionSource;
  manual?: boolean;
}

export interface NameScore {
  overall: number;
  label: string;
  dimensions: ScoreDimension[];
  hardBlockers: string[];
  warnings: string[];
  summary: string;
  founderResonanceRequired: boolean;
}

export type Score = NameScore;

export type RiskSignalKind =
  | "active_same_category_collision"
  | "hostile_domain_redirect"
  | "family_of_marks"
  | "trademark_unfinished"
  | "voice_transcription_failure"
  | "app_store_collision"
  | "defunct_company"
  | "negative_meaning"
  | "scope_lock"
  | "manual";

export interface RiskSignal {
  kind: RiskSignalKind | string;
  status: EvidenceStatus | "failed" | "passed";
  detail: string;
  severity?: "blocker" | "high" | "medium" | "low";
  evidence?: Evidence;
}

export interface ScoreContext {
  brief?: ProjectBrief;
  candidate?: Candidate;
  /** Lightweight context used by exact-name checks before a full brief exists. */
  category?: string;
  /** Acquisition or word-of-mouth channels supplied by a quick check. */
  channels?: string[];
  preferredTld?: string;
  domainResults?: DomainResult[];
  namespaceResults?: NamespaceResult[];
  competitorNames?: string[];
  saturatedRoots?: string[];
  riskSignals?: RiskSignal[];
  founderResonance?: number;
}

export interface RejectedName {
  name: string;
  reason: string;
  rejectedAt?: string;
  evidence?: Evidence[];
}

export interface NameAnalysis {
  name: string;
  normalized?: string;
  score: NameScore;
  domains?: DomainResult[];
  namespaces?: NamespaceResult[];
  evidence?: Evidence[];
  manualLinks?: ManualLink[];
  rationale?: string;
  strongestReasonFor?: string;
  strongestReasonAgainst?: string;
  riskSignals?: RiskSignal[];
  founderResonance?: number;
  namesakeResearch?: {
    provider: string;
    state: string;
    query?: string;
    sources?: Array<{
      title: string;
      url: string;
      publishedDate?: string;
      author?: string;
      highlights?: string[];
      excerpt?: string;
    }>;
    interpretation?: string;
  };
}

export interface DecisionRecord {
  version?: string;
  title?: string;
  project?: string;
  brief?: ProjectBrief;
  selectedName?: string;
  recommendation?: string;
  candidates?: Candidate[];
  shortlist?: Array<Candidate | NameAnalysis>;
  finalists?: NameAnalysis[];
  rejected?: RejectedName[];
  usage?: UsageSummary;
  humanActions?: string[];
  notes?: string[];
  createdAt?: string;
  updatedAt?: string;
  exportedAt?: string;
  disclaimer?: string;
}

export interface ImportSecretFinding {
  kind: string;
  line: number;
  message: string;
}

export interface PromptInjectionSignal {
  kind: string;
  line: number;
  message: string;
}

export interface ImportValidationOptions {
  fileName?: string;
  source?: string;
  maxBytes?: number;
  maxTokens?: number;
  redactSecrets?: boolean;
}

export interface ImportValidationResult {
  ok: boolean;
  valid: boolean;
  sanitizedText: string;
  safeText: string;
  byteLength: number;
  estimatedTokens: number;
  errors: string[];
  warnings: string[];
  secretFindings: ImportSecretFinding[];
  injectionSignals: PromptInjectionSignal[];
  source?: string;
}

export interface PublicUrlValidationOptions {
  allowHttp?: boolean;
  allowedPorts?: number[];
  resolveHost?: (hostname: string) => Promise<string[]>;
}

export interface PublicUrlValidationResult {
  ok: boolean;
  valid: boolean;
  url?: string;
  hostname?: string;
  errors: string[];
  warnings: string[];
  resolvedAddresses: string[];
  requiresDnsVerification: boolean;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface KeyValueCache {
  get<T>(key: string): T | undefined | Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): void | Promise<void>;
  delete?(key: string): void | Promise<void>;
}

export interface DomainCalibration {
  tld: string;
  canary?: string;
  healthy: boolean;
  checkedAt: string;
  detail: string;
  evidence: Evidence;
}

export interface DomainCheckerOptions {
  fetch?: FetchLike;
  now?: () => Date;
  bootstrapUrl?: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  negativeCacheTtlMs?: number;
  unknownCacheTtlMs?: number;
  bootstrapCacheTtlMs?: number;
  calibrationCacheTtlMs?: number;
  calibrationCanaries?: Record<string, string | undefined>;
  requireCalibration?: boolean;
  maxDomains?: number;
  concurrency?: number;
  cache?: KeyValueCache;
  usageLedger?: UsageLedgerLike;
}

export interface DomainChecker {
  check(domain: string): Promise<DomainResult>;
  checkMany(domains: string[]): Promise<DomainResult[]>;
  checkDomain(domain: string): Promise<DomainResult>;
  checkDomains(domains: string[]): Promise<DomainResult[]>;
  calibrate(tld: string): Promise<DomainCalibration>;
  clearCache(): void;
}

export interface NamespaceCheckOptions {
  fetch?: FetchLike;
  now?: () => Date;
  timeoutMs?: number;
  cacheTtlMs?: number;
  unknownCacheTtlMs?: number;
  include?: NamespaceKind[];
  includeManual?: boolean;
  githubToken?: string;
  country?: string;
  cache?: KeyValueCache;
  usageLedger?: UsageLedgerLike;
}

export type UsageKind = "model" | "domain" | "namespace" | "search" | "fetch" | "other";

export interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedInputPerMillionUsd?: number;
  reasoningPerMillionUsd?: number;
}

export interface ModelTokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  outputTokens?: number;
}

export interface UsageEvent extends ModelTokenUsage {
  id?: string;
  kind: UsageKind;
  provider: string;
  task: string;
  model?: string;
  calls?: number;
  requests?: number;
  searchQueries?: number;
  fetchedPages?: number;
  cacheHits?: number;
  retries?: number;
  failures?: number;
  latencyMs?: number;
  estimatedUsd?: number;
  pricing?: ModelPricing;
  occurredAt?: string;
}

export interface UsageSummary {
  providerCalls: number;
  modelCalls: number;
  domainRequests: number;
  namespaceRequests: number;
  searchQueries: number;
  fetchedPages: number;
  inputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  cacheHits: number;
  retries: number;
  failures: number;
  latencyMs: number;
  events: number;
}

export interface UsageLedgerLike {
  record(event: UsageEvent): unknown;
  snapshot?(): UsageSummary;
}

export interface BudgetLimits {
  maxProviderCalls?: number;
  maxModelCalls?: number;
  maxDomainRequests?: number;
  maxNamespaceRequests?: number;
  maxSearchQueries?: number;
  maxFetchedPages?: number;
  maxInputTokens?: number;
  maxCachedInputTokens?: number;
  maxReasoningTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxEstimatedUsd?: number;
  maxRetries?: number;
  maxFailures?: number;
}

export interface BudgetViolation {
  metric: keyof BudgetLimits;
  limit: number;
  actual: number;
  overBy: number;
}

export interface BudgetCheckResult {
  ok: boolean;
  withinBudget: boolean;
  violations: BudgetViolation[];
  remaining: Partial<Record<keyof BudgetLimits, number>>;
  usage: UsageSummary;
}

export interface ExportOptions {
  now?: () => Date;
  pretty?: boolean;
  title?: string;
}
