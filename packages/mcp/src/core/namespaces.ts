import { comparisonKey, toDomainLabel } from "./normalize";
import type {
  Evidence,
  FetchLike,
  NamespaceCheckOptions,
  NamespaceKind,
  NamespaceResult,
} from "./types";

const AUTOMATED: NamespaceKind[] = ["npm", "pypi", "apple_app_store", "github"];
const MANUAL: NamespaceKind[] = ["google_play", "chrome_web_store", "x", "instagram", "linkedin", "youtube"];
const defaultCache = new Map<string, { value: NamespaceResult; expiresAt: number }>();
const defaultInflight = new Map<string, Promise<NamespaceResult>>();

class NamespaceTimeoutError extends Error {
  constructor() {
    super("Namespace request timed out.");
    this.name = "NamespaceTimeoutError";
  }
}

async function timedFetch(fetcher: FetchLike, url: string, timeoutMs: number, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new NamespaceTimeoutError());
      }, timeoutMs);
    });
    return await Promise.race([fetcher(url, { ...init, signal: controller.signal }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // Status-only endpoints do not need their bodies; tolerate runtimes that
    // expose a body stream which is already locked.
  }
}

async function readBoundedJson<T>(response: Response, maxBytes: number): Promise<T> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await cancelResponseBody(response);
    throw new Error("Namespace JSON response exceeded its byte limit.");
  }
  if (!response.body) throw new Error("Namespace JSON response body was empty.");

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
        await reader.cancel("Namespace JSON response exceeded its byte limit.").catch(() => undefined);
        throw new Error("Namespace JSON response exceeded its byte limit.");
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

function source(
  kind: NamespaceKind,
  name: string,
  label: string,
  status: NamespaceResult["status"],
  provider: string,
  sourceUrl: string,
  checkedAt: string,
  detail: string,
  evidenceStatus: Evidence["status"],
  confidence: Evidence["confidence"],
  responseCode?: number,
): NamespaceResult {
  return {
    namespace: kind,
    label,
    status,
    url: manualUrl(kind, name),
    responseCode,
    detail,
    evidence: {
      id: `namespace:${kind}:${comparisonKey(name)}`,
      label: `${provider} exact-name check`,
      provider,
      sourceUrl,
      checkedAt,
      status: evidenceStatus,
      confidence,
      value: { namespace: kind, status, responseCode },
      detail,
    },
  };
}

function manualUrl(kind: NamespaceKind, rawName: string): string {
  const slug = toDomainLabel(rawName);
  const encoded = encodeURIComponent(rawName.trim());
  switch (kind) {
    case "npm":
      return `https://www.npmjs.com/package/${encodeURIComponent(slug)}`;
    case "pypi":
      return `https://pypi.org/project/${encodeURIComponent(slug)}/`;
    case "github":
      return `https://github.com/${encodeURIComponent(slug.slice(0, 39))}`;
    case "apple_app_store":
      return `https://apps.apple.com/us/search?term=${encoded}`;
    case "google_play":
      return `https://play.google.com/store/search?q=${encoded}&c=apps`;
    case "chrome_web_store":
      return `https://chromewebstore.google.com/search/${encoded}`;
    case "x":
      return `https://x.com/${encodeURIComponent(slug.slice(0, 15))}`;
    case "instagram":
      return `https://www.instagram.com/${encodeURIComponent(slug.slice(0, 30))}/`;
    case "linkedin":
      return `https://www.linkedin.com/search/results/companies/?keywords=${encoded}`;
    case "youtube":
      return `https://www.youtube.com/results?search_query=${encoded}`;
  }
}

function exactEndpoint(kind: NamespaceKind, rawName: string, country: string): string {
  const slug = toDomainLabel(rawName);
  switch (kind) {
    case "npm":
      return `https://registry.npmjs.org/${encodeURIComponent(slug)}`;
    case "pypi":
      return `https://pypi.org/pypi/${encodeURIComponent(slug)}/json`;
    case "github":
      return `https://api.github.com/users/${encodeURIComponent(slug.slice(0, 39))}`;
    case "apple_app_store":
      return `https://itunes.apple.com/search?term=${encodeURIComponent(rawName.trim())}&entity=software&limit=50&country=${encodeURIComponent(country)}`;
    default:
      return manualUrl(kind, rawName);
  }
}

function platformLabel(kind: NamespaceKind): string {
  return {
    npm: "npm package",
    pypi: "PyPI project",
    github: "GitHub account",
    apple_app_store: "Apple App Store",
    google_play: "Google Play",
    chrome_web_store: "Chrome Web Store",
    x: "X handle",
    instagram: "Instagram handle",
    linkedin: "LinkedIn company",
    youtube: "YouTube handle",
  }[kind];
}

function providerLabel(kind: NamespaceKind): string {
  return {
    npm: "npm Registry",
    pypi: "PyPI JSON API",
    github: "GitHub REST API",
    apple_app_store: "Apple iTunes Search API",
    google_play: "Google Play manual search",
    chrome_web_store: "Chrome Web Store manual search",
    x: "X manual verification",
    instagram: "Instagram manual verification",
    linkedin: "LinkedIn manual verification",
    youtube: "YouTube manual verification",
  }[kind];
}

function manualResult(kind: NamespaceKind, name: string, now: () => Date): NamespaceResult {
  const checkedAt = now().toISOString();
  const social = ["x", "instagram", "linkedin", "youtube"].includes(kind);
  const detail = social
    ? "No supported public API confirms handle availability. Automated or blocked page responses are not interpreted; verify manually."
    : "The platform does not provide a suitable public catalog API for this exact check; use the manual search link.";
  return source(
    kind,
    name,
    platformLabel(kind),
    social ? "unknown" : "manual",
    providerLabel(kind),
    manualUrl(kind, name),
    checkedAt,
    detail,
    "manual",
    "low",
  );
}

async function automatedResult(kind: NamespaceKind, name: string, options: NamespaceCheckOptions): Promise<NamespaceResult> {
  const fetcher = options.fetch ?? (globalThis.fetch?.bind(globalThis) as FetchLike | undefined);
  if (!fetcher) throw new Error("A Fetch-compatible function is required for namespace checks.");
  const now = options.now ?? (() => new Date());
  const timeoutMs = Math.max(50, options.timeoutMs ?? 4_000);
  const country = (options.country ?? "us").toLowerCase();
  const endpoint = exactEndpoint(kind, name, country);
  const provider = providerLabel(kind);
  const checkedAt = now().toISOString();
  const headers: Record<string, string> = { accept: "application/json" };
  if (kind === "github") {
    headers["x-github-api-version"] = "2022-11-28";
    headers["user-agent"] = "naming-signal/0.1";
    if (options.githubToken) headers.authorization = `Bearer ${options.githubToken}`;
  }
  const started = Date.now();

  try {
    const response = await timedFetch(fetcher, endpoint, timeoutMs, { headers });
    const latencyMs = Date.now() - started;
    options.usageLedger?.record({
      kind: "namespace",
      provider,
      task: `namespace.${kind}`,
      calls: 0,
      requests: 1,
      failures: response.status === 429 || response.status >= 500 ? 1 : 0,
      latencyMs,
    });

    if (kind === "apple_app_store" && response.ok) {
      let payload: { results?: Array<{ trackName?: unknown }> };
      try {
        payload = await readBoundedJson<{ results?: Array<{ trackName?: unknown }> }>(
          response,
          1_000_000,
        );
      } catch {
        return source(kind, name, platformLabel(kind), "unknown", provider, endpoint, checkedAt, "Apple returned an unreadable response; status remains unknown.", "unknown", "low", response.status);
      }
      const target = comparisonKey(name);
      const exact = (payload.results ?? []).filter(
        (item) => typeof item.trackName === "string" && comparisonKey(item.trackName) === target,
      );
      if (exact.length) {
        return source(
          kind,
          name,
          platformLabel(kind),
          "conflict",
          provider,
          endpoint,
          checkedAt,
          `${exact.length} exact normalized title match${exact.length === 1 ? "" : "es"} found in the ${country.toUpperCase()} storefront.`,
          "confirmed",
          "high",
          response.status,
        );
      }
      return source(
        kind,
        name,
        platformLabel(kind),
        "likely_available",
        provider,
        endpoint,
        checkedAt,
        `No exact normalized title match appeared in the first 50 ${country.toUpperCase()} storefront results; other storefronts and title rules remain unchecked.`,
        "inferred",
        "low",
        response.status,
      );
    }

    await cancelResponseBody(response);

    if (response.ok) {
      return source(
        kind,
        name,
        platformLabel(kind),
        "taken",
        provider,
        endpoint,
        checkedAt,
        `Exact ${platformLabel(kind).toLowerCase()} lookup returned HTTP ${response.status}.`,
        "confirmed",
        "high",
        response.status,
      );
    }
    if (response.status === 404) {
      return source(
        kind,
        name,
        platformLabel(kind),
        "likely_available",
        provider,
        endpoint,
        checkedAt,
        `Exact lookup returned 404. The namespace appears unused, but reserved names and registration rules can still block it.`,
        "inferred",
        kind === "github" ? "medium" : "high",
        response.status,
      );
    }
    return source(
      kind,
      name,
      platformLabel(kind),
      "unknown",
      provider,
      endpoint,
      checkedAt,
      response.status === 429
        ? "The provider rate-limited this check; status remains unknown."
        : `Provider returned ambiguous HTTP ${response.status}; status remains unknown.`,
      "unknown",
      "low",
      response.status,
    );
  } catch (error) {
    options.usageLedger?.record({
      kind: "namespace",
      provider,
      task: `namespace.${kind}`,
      calls: 0,
      requests: 1,
      failures: 1,
      latencyMs: Date.now() - started,
    });
    return source(
      kind,
      name,
      platformLabel(kind),
      "unknown",
      provider,
      endpoint,
      checkedAt,
      error instanceof NamespaceTimeoutError || (error instanceof Error && error.name === "AbortError")
        ? "Provider request timed out; status remains unknown."
        : "Provider request failed; status remains unknown.",
      "unknown",
      "low",
    );
  }
}

async function checkOne(kind: NamespaceKind, name: string, options: NamespaceCheckOptions): Promise<NamespaceResult> {
  const now = options.now ?? (() => new Date());
  if (!AUTOMATED.includes(kind)) return manualResult(kind, name, now);
  const cacheKey = `namespace:v1:${kind}:${comparisonKey(name)}:${options.country ?? "us"}`;
  const local = !options.fetch ? defaultCache.get(cacheKey) : undefined;
  if (local && local.expiresAt > now().getTime()) {
    options.usageLedger?.record({ kind: "namespace", provider: "core-cache", task: `namespace.${kind}.cache`, calls: 0, requests: 0, cacheHits: 1 });
    return { ...local.value, cached: true, evidence: { ...local.value.evidence } };
  }
  const external = await options.cache?.get<NamespaceResult>(cacheKey);
  if (external) {
    options.usageLedger?.record({ kind: "namespace", provider: "core-cache", task: `namespace.${kind}.cache`, calls: 0, requests: 0, cacheHits: 1 });
    return { ...external, cached: true, evidence: { ...external.evidence } };
  }

  const existing = !options.fetch ? defaultInflight.get(cacheKey) : undefined;
  if (existing) {
    const result = await existing;
    return { ...result, evidence: { ...result.evidence } };
  }
  const operation = automatedResult(kind, name, options);
  if (!options.fetch) defaultInflight.set(cacheKey, operation);
  try {
    const result = await operation;
    const ttl = result.status === "unknown" ? options.unknownCacheTtlMs ?? 15_000 : options.cacheTtlMs ?? 5 * 60_000;
    if (ttl > 0) {
      if (!options.fetch) defaultCache.set(cacheKey, { value: result, expiresAt: now().getTime() + ttl });
      await options.cache?.set(cacheKey, result, ttl);
    }
    return { ...result, evidence: { ...result.evidence } };
  } finally {
    if (!options.fetch) defaultInflight.delete(cacheKey);
  }
}

/** Check exact public namespaces. Unsupported/social platforms remain manual or unknown, never "free". */
export async function checkNamespaces(name: string, options: NamespaceCheckOptions = {}): Promise<NamespaceResult[]> {
  if (typeof name !== "string" || !toDomainLabel(name)) throw new TypeError("A non-empty name is required.");
  let kinds = options.include ? [...new Set(options.include)] : [...AUTOMATED];
  if (options.includeManual) kinds = [...new Set([...kinds, ...MANUAL])];
  return Promise.all(kinds.map((kind) => checkOne(kind, name, options)));
}

export type NamespaceCheckResult = NamespaceResult;
