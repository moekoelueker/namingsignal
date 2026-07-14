import type {
  BudgetCheckResult,
  BudgetLimits,
  BudgetViolation,
  ModelPricing,
  ModelTokenUsage,
  UsageEvent,
  UsageSummary,
} from "./types";

const ZERO_USAGE: UsageSummary = {
  providerCalls: 0,
  modelCalls: 0,
  domainRequests: 0,
  namespaceRequests: 0,
  searchQueries: 0,
  fetchedPages: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  outputTokens: 0,
  estimatedUsd: 0,
  cacheHits: 0,
  retries: 0,
  failures: 0,
  latencyMs: 0,
  events: 0,
};

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
function eventCost(event: UsageEvent): number {
  if (event.estimatedUsd !== undefined) return finiteNonNegative(event.estimatedUsd);
  if (event.kind === "model" && event.pricing) return estimateModelCost(event, event.pricing);
  return 0;
}

function addUsage(left: UsageSummary, right: Partial<UsageSummary>): UsageSummary {
  return {
    providerCalls: left.providerCalls + finiteNonNegative(right.providerCalls),
    modelCalls: left.modelCalls + finiteNonNegative(right.modelCalls),
    domainRequests: left.domainRequests + finiteNonNegative(right.domainRequests),
    namespaceRequests: left.namespaceRequests + finiteNonNegative(right.namespaceRequests),
    searchQueries: left.searchQueries + finiteNonNegative(right.searchQueries),
    fetchedPages: left.fetchedPages + finiteNonNegative(right.fetchedPages),
    inputTokens: left.inputTokens + finiteNonNegative(right.inputTokens),
    cachedInputTokens: left.cachedInputTokens + finiteNonNegative(right.cachedInputTokens),
    reasoningTokens: left.reasoningTokens + finiteNonNegative(right.reasoningTokens),
    outputTokens: left.outputTokens + finiteNonNegative(right.outputTokens),
    estimatedUsd: left.estimatedUsd + finiteNonNegative(right.estimatedUsd),
    cacheHits: left.cacheHits + finiteNonNegative(right.cacheHits),
    retries: left.retries + finiteNonNegative(right.retries),
    failures: left.failures + finiteNonNegative(right.failures),
    latencyMs: left.latencyMs + finiteNonNegative(right.latencyMs),
    events: left.events + finiteNonNegative(right.events),
  };
}

function eventToUsage(event: UsageEvent): UsageSummary {
  const calls = event.calls ?? 1;
  const requests = event.requests ?? calls;
  return {
    ...ZERO_USAGE,
    providerCalls: event.kind === "model" ? calls : 0,
    modelCalls: event.kind === "model" ? calls : 0,
    domainRequests: event.kind === "domain" ? requests : 0,
    namespaceRequests: event.kind === "namespace" ? requests : 0,
    searchQueries: event.searchQueries ?? (event.kind === "search" ? requests : 0),
    fetchedPages: event.fetchedPages ?? 0,
    inputTokens: finiteNonNegative(event.inputTokens),
    cachedInputTokens: finiteNonNegative(event.cachedInputTokens),
    reasoningTokens: finiteNonNegative(event.reasoningTokens),
    outputTokens: finiteNonNegative(event.outputTokens),
    estimatedUsd: eventCost(event),
    cacheHits: finiteNonNegative(event.cacheHits),
    retries: finiteNonNegative(event.retries),
    failures: finiteNonNegative(event.failures),
    latencyMs: finiteNonNegative(event.latencyMs),
    events: 1,
  };
}

export function estimateModelCost(usage: ModelTokenUsage, pricing: ModelPricing): number;
export function estimateModelCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
  cachedInputTokens?: number,
  reasoningTokens?: number,
): number;
export function estimateModelCost(
  usageOrInput: ModelTokenUsage | number,
  pricingOrOutput: ModelPricing | number,
  maybePricing?: ModelPricing,
  maybeCached = 0,
  maybeReasoning = 0,
): number {
  const usage: ModelTokenUsage =
    typeof usageOrInput === "number"
      ? {
          inputTokens: usageOrInput,
          outputTokens: typeof pricingOrOutput === "number" ? pricingOrOutput : 0,
          cachedInputTokens: maybeCached,
          reasoningTokens: maybeReasoning,
        }
      : usageOrInput;
  const pricing = (typeof pricingOrOutput === "object" ? pricingOrOutput : maybePricing) as ModelPricing | undefined;
  if (!pricing) throw new TypeError("Model pricing is required.");

  const input = finiteNonNegative(usage.inputTokens);
  const cached = Math.min(input, finiteNonNegative(usage.cachedInputTokens));
  const uncached = Math.max(0, input - cached);
  const output = finiteNonNegative(usage.outputTokens);
  const reasoning = finiteNonNegative(usage.reasoningTokens);
  const cost =
    (uncached * finiteNonNegative(pricing.inputPerMillionUsd)) / 1_000_000 +
    (cached * finiteNonNegative(pricing.cachedInputPerMillionUsd ?? pricing.inputPerMillionUsd)) / 1_000_000 +
    (output * finiteNonNegative(pricing.outputPerMillionUsd)) / 1_000_000 +
    (reasoning * finiteNonNegative(pricing.reasoningPerMillionUsd ?? pricing.outputPerMillionUsd)) / 1_000_000;
  return cost;
}

export class UsageLedger {
  private readonly eventsInternal: UsageEvent[] = [];
  private readonly now: () => Date;
  private sequence = 0;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  record(event: UsageEvent): UsageEvent {
    if (!event || !event.kind || !event.provider || !event.task) {
      throw new TypeError("Usage events require kind, provider, and task.");
    }
    this.sequence += 1;
    const recorded: UsageEvent = {
      ...event,
      id: event.id ?? `usage_${this.sequence}`,
      occurredAt: event.occurredAt ?? this.now().toISOString(),
      estimatedUsd: eventCost(event),
    };
    this.eventsInternal.push(Object.freeze(recorded));
    return recorded;
  }

  recordModel(
    event: Omit<UsageEvent, "kind"> & { pricing?: ModelPricing },
  ): UsageEvent {
    return this.record({ ...event, kind: "model" });
  }

  recordDomain(provider: string, task: string, requests = 1, extra: Partial<UsageEvent> = {}): UsageEvent {
    return this.record({ ...extra, provider, task, requests, kind: "domain" });
  }

  recordNamespace(provider: string, task: string, requests = 1, extra: Partial<UsageEvent> = {}): UsageEvent {
    return this.record({ ...extra, provider, task, requests, kind: "namespace" });
  }

  getEvents(): readonly UsageEvent[] {
    return this.eventsInternal.map((event) => ({ ...event }));
  }

  snapshot(): UsageSummary {
    return this.eventsInternal.reduce((summary, event) => addUsage(summary, eventToUsage(event)), { ...ZERO_USAGE });
  }

  merge(other: UsageLedger | readonly UsageEvent[]): this {
    const events = other instanceof UsageLedger ? other.getEvents() : other;
    for (const event of events) this.record({ ...event, id: undefined });
    return this;
  }

  clear(): void {
    this.eventsInternal.length = 0;
  }

  toJSON(): UsageSummary & { eventLog: readonly UsageEvent[] } {
    return { ...this.snapshot(), eventLog: this.getEvents() };
  }
}

function usageFrom(input: UsageLedger | UsageSummary | Partial<UsageSummary> | UsageEvent): UsageSummary {
  if (input instanceof UsageLedger) return input.snapshot();
  if ("kind" in input && "provider" in input && "task" in input) return eventToUsage(input as UsageEvent);
  return addUsage({ ...ZERO_USAGE }, input as Partial<UsageSummary>);
}

const LIMIT_METRICS: Array<{
  limit: keyof BudgetLimits;
  actual: (usage: UsageSummary) => number;
}> = [
  { limit: "maxProviderCalls", actual: (usage) => usage.providerCalls },
  { limit: "maxModelCalls", actual: (usage) => usage.modelCalls },
  { limit: "maxDomainRequests", actual: (usage) => usage.domainRequests },
  { limit: "maxNamespaceRequests", actual: (usage) => usage.namespaceRequests },
  { limit: "maxSearchQueries", actual: (usage) => usage.searchQueries },
  { limit: "maxFetchedPages", actual: (usage) => usage.fetchedPages },
  { limit: "maxInputTokens", actual: (usage) => usage.inputTokens },
  { limit: "maxCachedInputTokens", actual: (usage) => usage.cachedInputTokens },
  { limit: "maxReasoningTokens", actual: (usage) => usage.reasoningTokens },
  { limit: "maxOutputTokens", actual: (usage) => usage.outputTokens },
  { limit: "maxTotalTokens", actual: (usage) => usage.inputTokens + usage.reasoningTokens + usage.outputTokens },
  { limit: "maxEstimatedUsd", actual: (usage) => usage.estimatedUsd },
  { limit: "maxRetries", actual: (usage) => usage.retries },
  { limit: "maxFailures", actual: (usage) => usage.failures },
];

export function checkBudget(
  usageInput: UsageLedger | UsageSummary | Partial<UsageSummary> | UsageEvent,
  limits: BudgetLimits,
  pending?: UsageSummary | Partial<UsageSummary> | UsageEvent,
): BudgetCheckResult {
  const current = usageFrom(usageInput);
  const usage = pending ? addUsage(current, usageFrom(pending)) : current;
  const violations: BudgetViolation[] = [];
  const remaining: Partial<Record<keyof BudgetLimits, number>> = {};

  for (const item of LIMIT_METRICS) {
    const rawLimit = limits[item.limit];
    if (rawLimit === undefined) continue;
    const limit = finiteNonNegative(rawLimit);
    const actual = item.actual(usage);
    remaining[item.limit] = Math.max(0, limit - actual);
    if (actual > limit) violations.push({ metric: item.limit, limit, actual, overBy: actual - limit });
  }

  return { ok: violations.length === 0, withinBudget: violations.length === 0, violations, remaining, usage };
}

export class BudgetExceededError extends Error {
  readonly result: BudgetCheckResult;

  constructor(result: BudgetCheckResult) {
    const detail = result.violations
      .map((violation) => `${violation.metric}=${violation.actual} exceeds ${violation.limit}`)
      .join(", ");
    super(`Budget exceeded: ${detail}`);
    this.name = "BudgetExceededError";
    this.result = result;
  }
}

export function assertWithinBudget(
  usage: UsageLedger | UsageSummary | Partial<UsageSummary> | UsageEvent,
  limits: BudgetLimits,
  pending?: UsageSummary | Partial<UsageSummary> | UsageEvent,
): BudgetCheckResult {
  const result = checkBudget(usage, limits, pending);
  if (!result.ok) throw new BudgetExceededError(result);
  return result;
}

export class BudgetGuard {
  readonly ledger: UsageLedger;
  readonly limits: BudgetLimits;
  private reserved: UsageSummary = { ...ZERO_USAGE };
  private readonly reservations = new Map<string, UsageSummary>();
  private sequence = 0;

  constructor(limits: BudgetLimits, ledger = new UsageLedger()) {
    this.limits = { ...limits };
    this.ledger = ledger;
  }

  check(pending?: Partial<UsageSummary> | UsageEvent): BudgetCheckResult {
    const withReservations = addUsage(this.ledger.snapshot(), this.reserved);
    return checkBudget(withReservations, this.limits, pending);
  }

  assert(pending?: Partial<UsageSummary> | UsageEvent): BudgetCheckResult {
    const result = this.check(pending);
    if (!result.ok) throw new BudgetExceededError(result);
    return result;
  }

  record(event: UsageEvent): UsageEvent {
    this.assert(event);
    return this.ledger.record(event);
  }

  reserve(pending: Partial<UsageSummary> | UsageEvent): string {
    this.assert(pending);
    const usage = usageFrom(pending);
    this.sequence += 1;
    const id = `reservation_${this.sequence}`;
    this.reservations.set(id, usage);
    this.reserved = addUsage(this.reserved, usage);
    return id;
  }

  release(reservationId: string): void {
    const usage = this.reservations.get(reservationId);
    if (!usage) return;
    this.reservations.delete(reservationId);
    this.reserved = {
      providerCalls: Math.max(0, this.reserved.providerCalls - usage.providerCalls),
      modelCalls: Math.max(0, this.reserved.modelCalls - usage.modelCalls),
      domainRequests: Math.max(0, this.reserved.domainRequests - usage.domainRequests),
      namespaceRequests: Math.max(0, this.reserved.namespaceRequests - usage.namespaceRequests),
      searchQueries: Math.max(0, this.reserved.searchQueries - usage.searchQueries),
      fetchedPages: Math.max(0, this.reserved.fetchedPages - usage.fetchedPages),
      inputTokens: Math.max(0, this.reserved.inputTokens - usage.inputTokens),
      cachedInputTokens: Math.max(0, this.reserved.cachedInputTokens - usage.cachedInputTokens),
      reasoningTokens: Math.max(0, this.reserved.reasoningTokens - usage.reasoningTokens),
      outputTokens: Math.max(0, this.reserved.outputTokens - usage.outputTokens),
      estimatedUsd: Math.max(0, this.reserved.estimatedUsd - usage.estimatedUsd),
      cacheHits: Math.max(0, this.reserved.cacheHits - usage.cacheHits),
      retries: Math.max(0, this.reserved.retries - usage.retries),
      failures: Math.max(0, this.reserved.failures - usage.failures),
      latencyMs: Math.max(0, this.reserved.latencyMs - usage.latencyMs),
      events: Math.max(0, this.reserved.events - usage.events),
    };
  }

  commit(reservationId: string, event: UsageEvent): UsageEvent {
    this.release(reservationId);
    return this.record(event);
  }
}
