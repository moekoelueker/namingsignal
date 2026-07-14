import { normalizeDomain } from "./normalize";
import type {
  DomainCalibration,
  DomainChecker,
  DomainCheckerOptions,
  DomainResult,
  Evidence,
  FetchLike,
  KeyValueCache,
  UsageLedgerLike,
} from "./types";

const IANA_RDAP_BOOTSTRAP = "https://data.iana.org/rdap/dns.json";

/** Known-registered canaries. In particular, github.io must never appear free. */
export const DEFAULT_RDAP_CANARIES: Readonly<Record<string, string>> = Object.freeze({
  com: "google.com",
  net: "example.net",
  org: "wikipedia.org",
  io: "github.io",
  dev: "google.dev",
  app: "google.app",
  ai: "google.ai",
  co: "google.co",
  me: "about.me",
  xyz: "abc.xyz",
  sh: "nic.sh",
});

type CacheEntry<T> = { value: T; expiresAt: number };
type BootstrapDocument = { services?: unknown };

class RequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestTimeoutError";
  }
}

function cloneResult(result: DomainResult, cached = result.cached): DomainResult {
  return { ...result, cached, evidence: { ...result.evidence } };
}

function iso(now: () => Date): string {
  return now().toISOString();
}

function confidence(value: "high" | "medium" | "low"): Evidence["confidence"] {
  return value;
}

function providerName(endpoint: string): string {
  try {
    return `Registry RDAP (${new URL(endpoint).hostname})`;
  } catch {
    return "Registry RDAP";
  }
}

function safeRegistryEndpoint(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:") return undefined;
    const host = url.hostname.toLowerCase();
    // Discovery must come from IANA; never fall back to a generic RDAP proxy.
    if (host === "rdap.org" || host.endsWith(".rdap.org")) return undefined;
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

async function fetchWithTimeout(fetcher: FetchLike, url: string, timeoutMs: number, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal) {
    if (upstreamSignal.aborted) abortFromUpstream();
    else upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort(new RequestTimeoutError(`Request exceeded ${timeoutMs}ms.`));
        reject(new RequestTimeoutError(`Request exceeded ${timeoutMs}ms.`));
      }, timeoutMs);
    });
    return await Promise.race([
      fetcher(url, { ...init, signal: controller.signal }),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}

function endpointForDomain(base: string, domain: string): string {
  return new URL(`domain/${encodeURIComponent(domain)}`, base).toString();
}

function parseBootstrap(document: BootstrapDocument): Record<string, string> {
  const endpoints: Record<string, string> = {};
  if (!Array.isArray(document.services)) throw new Error("IANA RDAP bootstrap did not contain services.");
  for (const service of document.services) {
    if (!Array.isArray(service) || service.length < 2) continue;
    const [rawTlds, rawUrls] = service;
    if (!Array.isArray(rawTlds) || !Array.isArray(rawUrls)) continue;
    const endpoint = rawUrls
      .filter((value): value is string => typeof value === "string")
      .map(safeRegistryEndpoint)
      .find(Boolean);
    if (!endpoint) continue;
    for (const rawTld of rawTlds) {
      if (typeof rawTld !== "string") continue;
      const tld = rawTld.toLowerCase().replace(/^\./, "");
      if (/^[a-z0-9-]+$/.test(tld)) endpoints[tld] = endpoint;
    }
  }
  return endpoints;
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // Status-only checks never need the upstream body. Cancellation is
    // best-effort because some test and edge runtimes expose locked streams.
  }
}

async function readBoundedJson<T>(response: Response, maxBytes: number): Promise<T> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelResponseBody(response);
    throw new Error("JSON response exceeded its byte limit.");
  }
  if (!response.body) throw new Error("JSON response body was empty.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("JSON response exceeded its byte limit.").catch(() => undefined);
        throw new Error("JSON response exceeded its byte limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function manualLookup(domain: string): string {
  return `https://lookup.icann.org/en/lookup?name=${encodeURIComponent(domain)}`;
}

class RdapDomainChecker implements DomainChecker {
  private readonly fetcher: FetchLike;
  private readonly now: () => Date;
  private readonly bootstrapUrl: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly negativeCacheTtlMs: number;
  private readonly unknownCacheTtlMs: number;
  private readonly bootstrapCacheTtlMs: number;
  private readonly calibrationCacheTtlMs: number;
  private readonly canaries: Record<string, string | undefined>;
  private readonly requireCalibration: boolean;
  private readonly maxDomains: number;
  private readonly concurrency: number;
  private readonly externalCache?: KeyValueCache;
  private readonly ledger?: UsageLedgerLike;
  private readonly resultCache = new Map<string, CacheEntry<DomainResult>>();
  private readonly calibrationCache = new Map<string, CacheEntry<DomainCalibration>>();
  private readonly inflight = new Map<string, Promise<DomainResult>>();
  private readonly calibrationInflight = new Map<string, Promise<DomainCalibration>>();
  private bootstrap?: CacheEntry<Record<string, string>>;
  private bootstrapInflight?: Promise<Record<string, string>>;

  constructor(options: DomainCheckerOptions = {}) {
    const globalFetch = globalThis.fetch?.bind(globalThis) as FetchLike | undefined;
    if (!options.fetch && !globalFetch) throw new Error("A Fetch-compatible function is required for domain checks.");
    this.fetcher = options.fetch ?? (globalFetch as FetchLike);
    this.now = options.now ?? (() => new Date());
    this.bootstrapUrl = options.bootstrapUrl ?? IANA_RDAP_BOOTSTRAP;
    if (this.bootstrapUrl !== IANA_RDAP_BOOTSTRAP) {
      const parsed = new URL(this.bootstrapUrl);
      if (parsed.protocol !== "https:" || parsed.hostname !== "data.iana.org") {
        throw new TypeError("RDAP bootstrap must use IANA data.iana.org/dns.json.");
      }
    }
    this.timeoutMs = Math.max(50, options.timeoutMs ?? 5_000);
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 15 * 60_000);
    this.negativeCacheTtlMs = Math.max(0, options.negativeCacheTtlMs ?? 60_000);
    this.unknownCacheTtlMs = Math.max(0, options.unknownCacheTtlMs ?? 15_000);
    this.bootstrapCacheTtlMs = Math.max(0, options.bootstrapCacheTtlMs ?? 24 * 60 * 60_000);
    this.calibrationCacheTtlMs = Math.max(0, options.calibrationCacheTtlMs ?? 10 * 60_000);
    this.canaries = { ...DEFAULT_RDAP_CANARIES, ...(options.calibrationCanaries ?? {}) };
    this.requireCalibration = options.requireCalibration ?? true;
    this.maxDomains = Math.max(1, Math.min(1_000, options.maxDomains ?? 500));
    this.concurrency = Math.max(1, Math.min(25, options.concurrency ?? 8));
    this.externalCache = options.cache;
    this.ledger = options.usageLedger;
  }

  private cacheKey(domain: string): string {
    return `domain:rdap:v1:${domain}`;
  }

  private async readResultCache(domain: string): Promise<DomainResult | undefined> {
    const now = this.now().getTime();
    const local = this.resultCache.get(domain);
    if (local && local.expiresAt > now) {
      this.ledger?.record({ kind: "domain", provider: "core-cache", task: "domain.cache", calls: 0, requests: 0, cacheHits: 1 });
      return cloneResult(local.value, true);
    }
    if (local) this.resultCache.delete(domain);
    const external = await this.externalCache?.get<DomainResult>(this.cacheKey(domain));
    if (external) {
      this.ledger?.record({ kind: "domain", provider: "core-cache", task: "domain.cache", calls: 0, requests: 0, cacheHits: 1 });
      return cloneResult(external, true);
    }
    return undefined;
  }

  private ttlFor(result: DomainResult): number {
    if (result.status === "likely_available") return this.negativeCacheTtlMs;
    if (result.status === "unknown") return this.unknownCacheTtlMs;
    if (result.status === "unsupported") return this.calibrationCacheTtlMs;
    return this.cacheTtlMs;
  }

  private async writeResultCache(domain: string, result: DomainResult): Promise<void> {
    const ttl = this.ttlFor(result);
    if (ttl <= 0) return;
    const clean = cloneResult(result, false);
    this.resultCache.set(domain, { value: clean, expiresAt: this.now().getTime() + ttl });
    await this.externalCache?.set(this.cacheKey(domain), clean, ttl);
  }

  private async loadBootstrap(): Promise<Record<string, string>> {
    const now = this.now().getTime();
    if (this.bootstrap && this.bootstrap.expiresAt > now) return this.bootstrap.value;
    if (this.bootstrapInflight) return this.bootstrapInflight;

    this.bootstrapInflight = (async () => {
      const cacheKey = "rdap:iana-bootstrap:v1";
      const external = await this.externalCache?.get<Record<string, string>>(cacheKey);
      if (external && Object.keys(external).length) {
        this.bootstrap = { value: external, expiresAt: this.now().getTime() + this.bootstrapCacheTtlMs };
        return external;
      }
      const started = Date.now();
      const response = await fetchWithTimeout(this.fetcher, this.bootstrapUrl, this.timeoutMs, {
        headers: { accept: "application/json" },
      });
      this.ledger?.record({
        kind: "fetch",
        provider: "IANA",
        task: "rdap.bootstrap",
        requests: 1,
        calls: 0,
        failures: response.ok ? 0 : 1,
        latencyMs: Date.now() - started,
      });
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new Error(`IANA RDAP bootstrap returned HTTP ${response.status}.`);
      }
      const endpoints = parseBootstrap(await readBoundedJson<BootstrapDocument>(response, 1_000_000));
      if (!Object.keys(endpoints).length) throw new Error("IANA RDAP bootstrap did not contain usable registry endpoints.");
      this.bootstrap = { value: endpoints, expiresAt: this.now().getTime() + this.bootstrapCacheTtlMs };
      await this.externalCache?.set(cacheKey, endpoints, this.bootstrapCacheTtlMs);
      return endpoints;
    })().finally(() => {
      this.bootstrapInflight = undefined;
    });
    return this.bootstrapInflight;
  }

  private result(
    domain: string,
    status: DomainResult["status"],
    provider: string,
    sourceUrl: string,
    evidenceStatus: Evidence["status"],
    evidenceConfidence: Evidence["confidence"],
    detail: string,
    responseCode?: number,
    latencyMs?: number,
  ): DomainResult {
    const checkedAt = iso(this.now);
    return {
      domain,
      status,
      checkedAt,
      provider,
      detail,
      responseCode,
      latencyMs,
      manualUrl: manualLookup(domain),
      evidence: {
        id: `domain:${domain}`,
        label: `${domain} registry status`,
        provider,
        sourceUrl,
        checkedAt,
        status: evidenceStatus,
        confidence: evidenceConfidence,
        value: { domain, status, responseCode },
        detail,
      },
    };
  }

  async calibrate(rawTld: string): Promise<DomainCalibration> {
    const tld = rawTld.toLowerCase().replace(/^\./, "").split(".").pop() ?? "";
    if (!/^[a-z0-9-]+$/.test(tld)) throw new TypeError(`Invalid TLD: ${rawTld}`);
    const cached = this.calibrationCache.get(tld);
    if (cached && cached.expiresAt > this.now().getTime()) return { ...cached.value, evidence: { ...cached.value.evidence } };
    const existing = this.calibrationInflight.get(tld);
    if (existing) return existing;

    const operation = (async (): Promise<DomainCalibration> => {
      const checkedAt = iso(this.now);
      const canary = this.canaries[tld];
      let endpoints: Record<string, string>;
      try {
        endpoints = await this.loadBootstrap();
      } catch (error) {
        const detail = `Could not load IANA RDAP discovery: ${error instanceof Error ? error.message : "unknown error"}`;
        return {
          tld,
          canary,
          healthy: false,
          checkedAt,
          detail,
          evidence: {
            provider: "IANA RDAP bootstrap",
            sourceUrl: this.bootstrapUrl,
            checkedAt,
            status: "unknown",
            confidence: confidence("low"),
            detail,
          },
        };
      }
      const endpoint = endpoints[tld];
      if (!endpoint) {
        const detail = `IANA did not publish a usable authoritative RDAP endpoint for .${tld}.`;
        return {
          tld,
          canary,
          healthy: false,
          checkedAt,
          detail,
          evidence: {
            provider: "IANA RDAP bootstrap",
            sourceUrl: this.bootstrapUrl,
            checkedAt,
            status: "manual",
            confidence: confidence("high"),
            detail,
          },
        };
      }
      if (!canary) {
        const detail = `No known-registered canary is configured for .${tld}; absence cannot be called likely available.`;
        return {
          tld,
          healthy: false,
          checkedAt,
          detail,
          evidence: {
            provider: providerName(endpoint),
            sourceUrl: endpoint,
            checkedAt,
            status: "manual",
            confidence: confidence("medium"),
            detail,
          },
        };
      }

      const url = endpointForDomain(endpoint, normalizeDomain(canary));
      const started = Date.now();
      try {
        const response = await fetchWithTimeout(this.fetcher, url, this.timeoutMs, {
          headers: { accept: "application/rdap+json, application/json" },
        });
        const latencyMs = Date.now() - started;
        const healthy = response.status >= 200 && response.status < 300;
        const detail = healthy
          ? `Canary ${canary} returned HTTP ${response.status}; the registry recognizes a known registered domain.`
          : `Canary ${canary} returned HTTP ${response.status}; .${tld} absence results are not trusted.`;
        this.ledger?.record({
          kind: "domain",
          provider: providerName(endpoint),
          task: "domain.canary",
          requests: 1,
          calls: 0,
          failures: healthy ? 0 : 1,
          latencyMs,
        });
        await cancelResponseBody(response);
        return {
          tld,
          canary,
          healthy,
          checkedAt,
          detail,
          evidence: {
            provider: providerName(endpoint),
            sourceUrl: url,
            checkedAt,
            status: healthy ? "confirmed" : "unknown",
            confidence: healthy ? confidence("high") : confidence("low"),
            value: { canary, responseCode: response.status },
            detail,
          },
        };
      } catch (error) {
        const detail = `Canary ${canary} failed: ${error instanceof RequestTimeoutError || (error instanceof Error && error.name === "AbortError") ? "timeout" : "network error"}; absence results are not trusted.`;
        this.ledger?.record({
          kind: "domain",
          provider: providerName(endpoint),
          task: "domain.canary",
          requests: 1,
          calls: 0,
          failures: 1,
          latencyMs: Date.now() - started,
        });
        return {
          tld,
          canary,
          healthy: false,
          checkedAt,
          detail,
          evidence: {
            provider: providerName(endpoint),
            sourceUrl: url,
            checkedAt,
            status: "unknown",
            confidence: confidence("low"),
            detail,
          },
        };
      }
    })();

    this.calibrationInflight.set(tld, operation);
    try {
      const result = await operation;
      const ttl = result.healthy ? this.calibrationCacheTtlMs : this.unknownCacheTtlMs;
      if (ttl > 0) this.calibrationCache.set(tld, { value: result, expiresAt: this.now().getTime() + ttl });
      return { ...result, evidence: { ...result.evidence } };
    } finally {
      this.calibrationInflight.delete(tld);
    }
  }

  private async checkUncached(domain: string): Promise<DomainResult> {
    const tld = domain.split(".").pop() as string;
    let endpoints: Record<string, string>;
    try {
      endpoints = await this.loadBootstrap();
    } catch (error) {
      return this.result(
        domain,
        "unknown",
        "IANA RDAP bootstrap",
        this.bootstrapUrl,
        "unknown",
        confidence("low"),
        `Registry discovery failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }

    const endpoint = endpoints[tld];
    if (!endpoint) {
      return this.result(
        domain,
        "unsupported",
        "IANA RDAP bootstrap",
        this.bootstrapUrl,
        "manual",
        confidence("high"),
        `No usable authoritative RDAP endpoint is published for .${tld}; verify manually.`,
      );
    }

    const url = endpointForDomain(endpoint, domain);
    const provider = providerName(endpoint);
    const started = Date.now();
    try {
      const response = await fetchWithTimeout(this.fetcher, url, this.timeoutMs, {
        headers: { accept: "application/rdap+json, application/json" },
      });
      const latencyMs = Date.now() - started;
      this.ledger?.record({
        kind: "domain",
        provider,
        task: "domain.lookup",
        requests: 1,
        calls: 0,
        failures: response.status === 429 || response.status >= 500 ? 1 : 0,
        latencyMs,
      });
      await cancelResponseBody(response);

      if (response.status >= 200 && response.status < 300) {
        return this.result(
          domain,
          "registered",
          provider,
          url,
          "confirmed",
          confidence("high"),
          `Authoritative registry RDAP returned HTTP ${response.status}; the domain is registered.`,
          response.status,
          latencyMs,
        );
      }

      if (response.status === 404) {
        const calibration = this.requireCalibration ? await this.calibrate(tld) : undefined;
        if (this.requireCalibration && !calibration?.healthy) {
          return this.result(
            domain,
            "unknown",
            provider,
            url,
            "unknown",
            confidence("low"),
            `Registry returned 404, but the known-registered canary failed calibration. ${calibration?.detail ?? ""}`.trim(),
            response.status,
            latencyMs,
          );
        }
        return this.result(
          domain,
          "likely_available",
          provider,
          url,
          "inferred",
          this.requireCalibration ? confidence("high") : confidence("medium"),
          this.requireCalibration
            ? `Registry returned 404 after its known-registered canary passed. The domain is likely unregistered, not guaranteed purchasable.`
            : "Registry returned 404 without canary enforcement. This is an unverified availability signal, not a purchase guarantee.",
          response.status,
          latencyMs,
        );
      }

      if ([405, 406, 501].includes(response.status)) {
        return this.result(
          domain,
          "unsupported",
          provider,
          url,
          "manual",
          confidence("medium"),
          `Registry endpoint returned HTTP ${response.status}; this lookup requires manual verification.`,
          response.status,
          latencyMs,
        );
      }

      const detail =
        response.status === 429
          ? "Registry rate-limited the request; status remains unknown."
          : `Registry returned ambiguous HTTP ${response.status}; status remains unknown.`;
      return this.result(
        domain,
        "unknown",
        provider,
        url,
        "unknown",
        confidence("low"),
        detail,
        response.status,
        latencyMs,
      );
    } catch (error) {
      const timeout = error instanceof RequestTimeoutError || (error instanceof Error && error.name === "AbortError");
      this.ledger?.record({
        kind: "domain",
        provider,
        task: "domain.lookup",
        requests: 1,
        calls: 0,
        failures: 1,
        latencyMs: Date.now() - started,
      });
      return this.result(
        domain,
        "unknown",
        provider,
        url,
        "unknown",
        confidence("low"),
        timeout ? "Registry request timed out; status remains unknown." : "Registry request failed; status remains unknown.",
        undefined,
        Date.now() - started,
      );
    }
  }

  async check(rawDomain: string): Promise<DomainResult> {
    const domain = normalizeDomain(rawDomain);
    const cached = await this.readResultCache(domain);
    if (cached) return cached;
    const existing = this.inflight.get(domain);
    if (existing) return cloneResult(await existing);

    const operation = (async () => {
      const result = await this.checkUncached(domain);
      await this.writeResultCache(domain, result);
      return result;
    })();
    this.inflight.set(domain, operation);
    try {
      return cloneResult(await operation);
    } finally {
      this.inflight.delete(domain);
    }
  }

  checkDomain(domain: string): Promise<DomainResult> {
    return this.check(domain);
  }

  async checkMany(domains: string[]): Promise<DomainResult[]> {
    if (!Array.isArray(domains)) throw new TypeError("Domains must be an array.");
    if (domains.length > this.maxDomains) throw new RangeError(`At most ${this.maxDomains} domains may be checked at once.`);
    const results = new Array<DomainResult>(domains.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, Math.max(1, domains.length)) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= domains.length) break;
        results[index] = await this.check(domains[index]);
      }
    });
    await Promise.all(workers);
    return results;
  }

  checkDomains(domains: string[]): Promise<DomainResult[]> {
    return this.checkMany(domains);
  }

  clearCache(): void {
    this.resultCache.clear();
    this.calibrationCache.clear();
    this.bootstrap = undefined;
  }
}

export function createDomainChecker(options: DomainCheckerOptions = {}): DomainChecker {
  return new RdapDomainChecker(options);
}

let defaultChecker: DomainChecker | undefined;

function resolveChecker(checkerOrOptions?: DomainChecker | DomainCheckerOptions): DomainChecker {
  if (checkerOrOptions && "check" in checkerOrOptions && typeof checkerOrOptions.check === "function") {
    return checkerOrOptions as DomainChecker;
  }
  if (checkerOrOptions) return createDomainChecker(checkerOrOptions as DomainCheckerOptions);
  defaultChecker ??= createDomainChecker();
  return defaultChecker;
}

export function checkDomain(domain: string, checkerOrOptions?: DomainChecker | DomainCheckerOptions): Promise<DomainResult> {
  return resolveChecker(checkerOrOptions).check(domain);
}

export function checkDomains(
  domains: string[],
  checkerOrOptions?: DomainChecker | DomainCheckerOptions,
): Promise<DomainResult[]> {
  return resolveChecker(checkerOrOptions).checkMany(domains);
}

export type DomainCheckResult = DomainResult;
