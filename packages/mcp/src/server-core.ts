import { createHash, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { AGENT_WORKFLOW_SUMMARY } from "./agent-guidance";
import {
  bestQualifyingDomain,
  chunkItems,
  classifyCandidate,
  sortCandidates,
  type AvailabilityRule,
} from "./core/batch";
import {
  normalizeName,
  type Candidate,
  type DomainResult,
  type NamespaceResult,
  type ProjectBrief,
} from "./core/index";

type ApiPayload = {
  brief?: ProjectBrief;
  candidates?: Candidate[];
  results?: Array<Candidate & Record<string, unknown>>;
  usage?: Record<string, number>;
  fallback?: boolean;
  fallbackReason?: string;
  preview?: Record<string, unknown>;
  error?: string;
  message?: string;
  code?: string;
  [key: string]: unknown;
};

export const DEFAULT_API_URL = "https://namingsignal.com";
const DEFAULT_TLDS = ["com", "io", "dev", "app"];

/** The complete tool surface, exported so tests and manifests stay in sync. */
export const NAMING_SIGNAL_TOOL_NAMES = [
  "compile_project_brief",
  "create_naming_sprint",
  "check_names",
  "analyze_candidates",
  "get_purchase_links",
] as const;

export type NamingSignalMcpServerOptions = {
  /** REST API origin the tools call; defaults to the hosted service. */
  baseUrl?: string;
  /** NamingSignal user API key forwarded as the Authorization Bearer token. */
  apiKey?: string;
  /**
   * Salt mixed into derived Idempotency-Keys. Stdio passes one random value
   * per process so an immediate retry of the same logical tool call replays
   * instead of re-charging. The remote endpoint passes a key-derived salt so
   * client retries across stateless POSTs keep the same replay behavior.
   */
  idempotencySalt?: string;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

function requestId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function mergeUsage(current: Record<string, number>, next?: Record<string, number>) {
  if (!next) return current;
  for (const [key, value] of Object.entries(next)) {
    if (typeof value === "number" && Number.isFinite(value)) current[key] = (current[key] ?? 0) + value;
  }
  return current;
}

// Single-copy payloads: compact JSON in one text block, no structuredContent
// duplication and no pretty-print indentation.
function toolResult(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
  };
}

type CandidateLike = {
  name?: string;
  score?: { overall?: number; hardBlockers?: string[] };
  domains?: DomainResult[];
  namespaces?: NamespaceResult[];
  strongestReasonFor?: unknown;
  strongestReasonAgainst?: unknown;
};

function compactDomainLine(domain: DomainResult) {
  const tld = domain.domain?.includes(".") ? domain.domain.slice(domain.domain.indexOf(".") + 1) : domain.domain;
  const provider = domain.provider || domain.evidence?.provider || "unknown";
  const checkedAt = String(domain.checkedAt ?? domain.evidence?.checkedAt ?? "").slice(0, 10);
  return `${tld}: ${domain.status} (${provider}${checkedAt ? `, ${checkedAt}` : ""})`;
}

function compactCandidate(row: CandidateLike) {
  const domains = Array.isArray(row.domains) ? row.domains : [];
  const namespaces = Array.isArray(row.namespaces) ? row.namespaces : [];
  const hardBlockers = Array.isArray(row.score?.hardBlockers) ? row.score.hardBlockers : [];
  const namespaceCollisions = namespaces
    .filter((namespace) => namespace.status === "taken" || namespace.status === "conflict")
    .slice(0, 5)
    .map((namespace) => `${namespace.namespace || namespace.label}: ${namespace.status}`);
  const firstDomain = domains[0];
  const verifyUrl = firstDomain?.manualUrl
    || (firstDomain ? `https://porkbun.com/checkout/search?q=${encodeURIComponent(firstDomain.domain.toLowerCase())}` : undefined);
  return {
    name: row.name,
    ...(typeof row.score?.overall === "number" ? { score: Math.round(row.score.overall) } : {}),
    domains: domains.map(compactDomainLine),
    ...(hardBlockers.length ? { hardBlockers } : {}),
    ...(namespaceCollisions.length ? { namespaceCollisions } : {}),
    ...(verifyUrl ? { verifyUrl } : {}),
  };
}

function normalizeTlds(values: string[]) {
  return [...new Set(values.map((value) => value.trim().toLowerCase().replace(/^\./, "")).filter(Boolean))].slice(0, 5);
}

/**
 * Build a fully wired NamingSignal MCP server. The stdio entry file and the
 * remote Streamable HTTP endpoint both call this factory so the tool surface,
 * compact output contract, progress notifications, and idempotency behavior
 * stay identical across transports.
 */
export function createNamingSignalMcpServer(options: NamingSignalMcpServerOptions = {}): McpServer {
  const apiBase = (options.baseUrl?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
  const apiKey = options.apiKey?.trim() || undefined;
  const fetchImpl = options.fetchImpl ?? fetch;
  // One salt per server: an immediate retry of the same logical tool call
  // re-derives the same Idempotency-Key and replays instead of re-charging.
  const sessionSalt = options.idempotencySalt || randomUUID();

  function idempotencyKey(path: string, body: unknown) {
    return `mcp_${createHash("sha256").update(`${sessionSalt}\n${path}\n${stableStringify(body)}`).digest("hex").slice(0, 32)}`;
  }

  function networkErrorMessage(path: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const keyHint = apiKey
      ? ""
      : " NAMING_SIGNAL_API_KEY is not set; hosted calls require a key created at https://namingsignal.com/developers.";
    return `Could not reach ${apiBase}${path} (${detail}). Check NAMING_SIGNAL_API_URL if you meant a different server (for local development set NAMING_SIGNAL_API_URL=http://localhost:3000).${keyHint}`;
  }

  async function post(path: string, body: unknown, sprintId = requestId("mcp_sprint")): Promise<ApiPayload> {
    let response: Response;
    try {
      response = await fetchImpl(`${apiBase}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey(path, body),
          "X-Name-Ledger-Sprint": sprintId,
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new Error(networkErrorMessage(path, cause));
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error(
        `${path} returned HTTP ${response.status} ${response.statusText || ""} from ${apiBase} with a non-JSON response (${contentType || "no content type"}). ` +
        `If this is a gateway error, retry; otherwise check NAMING_SIGNAL_API_URL.`,
      );
    }
    const payload = await response.json() as ApiPayload;
    if (!response.ok) {
      const hint = response.status === 401
        ? " Set NAMING_SIGNAL_API_KEY to a key created at /developers."
        : "";
      throw new Error(`${payload.error || payload.message || `${path} failed with HTTP ${response.status}`}${hint}`);
    }
    return payload;
  }

  const server = new McpServer(
    {
      name: "naming-signal",
      version: "0.2.0",
    },
    {
      instructions: `${AGENT_WORKFLOW_SUMMARY} Recommended MCP sequence: compile_project_brief when context quality is uncertain; review or correct the brief in conversation; create_naming_sprint with the corrected raw context and includeLedger=true when the complete checked field must be retained; check_names with namespaces enabled for a bounded survivor set; analyze_candidates for one to three finalists; then get_purchase_links for manual registrar verification. create_naming_sprint recompiles context, and runId is not a durable retrieval handle. Tool output is compact by default; pass verbose=true only when full evidence objects are required. Preserve strongestRegisteredOrBlocked and strongestNeedsReview instead of hiding trade-offs.`,
    },
  );

  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  } as const;

  server.registerTool(
    "compile_project_brief",
    {
      title: "Compile an editable naming brief",
      description: "Turn a sentence, product prompt, README, or agent summary into a bounded, editable project brief. Missing fields remain explicit rather than invented.",
      inputSchema: {
        context: z.string().min(3).max(250_000).describe("Product context, prompt, or README text"),
        source: z.string().min(1).max(200).default("MCP context").describe("Human-readable provenance label"),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ context, source }) => {
      const payload = await post("/api/v1/brief", { text: context, source });
      return toolResult({ brief: payload.brief, preview: payload.preview });
    },
  );

  server.registerTool(
    "create_naming_sprint",
    {
      title: "Create and check a naming sprint",
      description: "Generate and check a naming sprint across four directions. Use any count from 10 to 200; 100–200 for an initial sprint or 40 for a feedback round. Pass prior names as existingNames so an iteration never repeats the retained ledger.",
      inputSchema: {
        context: z.string().min(3).max(250_000).describe("Product description, prompt, or README text"),
        tlds: z.array(z.string().regex(/^\.?[a-z0-9-]{2,24}$/i)).min(1).max(5).default(DEFAULT_TLDS),
        count: z.number().int().min(10).max(200).default(100),
        availabilityRule: z.enum(["any_selected", "all_selected"]).default("any_selected"),
        top: z.number().int().min(1).max(50).default(20).describe("Number of ranked survivors returned inline"),
        includeLedger: z.boolean().default(false).describe("Return the complete checked candidate ledger in addition to the bounded shortlist"),
        verbose: z.boolean().default(false).describe("Return full evidence objects instead of the compact per-name shape"),
        feedback: z.string().min(3).max(2_000).optional().describe("Founder feedback for an iterative round"),
        likedNames: z.array(z.string().min(2).max(32)).max(30).default([]).describe("Examples whose qualities should guide the next round"),
        dislikedNames: z.array(z.string().min(2).max(32)).max(30).default([]).describe("Examples or patterns the next round should avoid"),
        existingNames: z.array(z.string().min(2).max(32)).max(500).default([]).describe("Names already generated in this project; all are excluded from the new round"),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ context, tlds: rawTlds, count, availabilityRule, top, includeLedger, verbose, feedback, likedNames, dislikedNames, existingNames }, extra) => {
      const progressToken = extra?._meta?.progressToken;
      const generationBatches = Math.ceil(count / 50);
      let progress = 0;
      let total = 1 + generationBatches + 2; // brief + generation + checks + done; refined once check batching is known.
      const notifyProgress = async (message: string) => {
        if (progressToken === undefined || progressToken === null) return;
        progress += 1;
        try {
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken, progress, total: Math.max(total, progress), message },
          });
        } catch {
          // Progress is best-effort; a transport hiccup must not fail the sprint.
        }
      };

      const sprintId = requestId("mcp_sprint");
      const tlds = normalizeTlds(rawTlds);
      const briefPayload = await post("/api/v1/brief", { text: context, source: "MCP naming sprint" }, sprintId);
      if (!briefPayload.brief) throw new Error("The brief route returned no project brief.");
      const brief = briefPayload.brief;
      await notifyProgress("Brief compiled");
      const candidates: Candidate[] = [];
      const seen = new Set<string>();
      const usage: Record<string, number> = {};
      const fallbackReasons = new Set<string>();
      let attempts = 0;

      while (candidates.length < count && attempts < generationBatches + 2) {
        // The generate route accepts 4–50 names per call; clamp small remainders up to 4.
        const requested = Math.min(50, Math.max(4, count - candidates.length));
        const payload = await post("/api/v1/generate", {
          brief: {
            ...brief,
            domainRequirements: [
              `${availabilityRule === "all_selected" ? "Every" : "At least one"} selected domain must be likely unregistered`,
              ...tlds.map((tld) => `.${tld}`),
            ],
          },
          count: requested,
          tlds,
          checkPrimaryDomain: false,
          excludedNames: [...existingNames, ...candidates.map((candidate) => candidate.name)].slice(-500),
          ...(feedback ? { iteration: { feedback, likedNames, dislikedNames } } : {}),
        }, sprintId);
        mergeUsage(usage, payload.usage);
        if (payload.fallback) fallbackReasons.add(payload.fallbackReason || "deterministic_fallback");
        let added = 0;
        for (const candidate of payload.candidates ?? []) {
          const key = normalizeName(candidate.name).replace(/\s+/g, "");
          if (!key || seen.has(key)) continue;
          seen.add(key);
          candidates.push(candidate);
          added += 1;
        }
        attempts += 1;
        await notifyProgress(`Generated ${Math.min(candidates.length, count)}/${count} candidates (batch ${attempts})`);
        if (!added) break;
      }
      if (!candidates.length) throw new Error("The naming sprint produced no distinct candidates.");
      if (candidates.length > count) candidates.length = count;

      const checked = new Map(candidates.map((candidate) => [normalizeName(candidate.name).replace(/\s+/g, ""), candidate]));
      const namesPerBatch = Math.max(1, Math.floor(100 / tlds.length));
      const checkBatches = chunkItems(candidates.map((candidate) => candidate.name), namesPerBatch);
      const checkGroups = chunkItems(checkBatches, 3);
      total = progress + checkGroups.length + 1;
      let checkedCount = 0;
      for (const batchGroup of checkGroups) {
        const payloads = await Promise.all(batchGroup.map((names) => post(
          "/api/v1/check",
          { names, tlds, context: brief, includeNamespaces: false },
          sprintId,
        )));
        for (const payload of payloads) {
          mergeUsage(usage, payload.usage);
          for (const result of payload.results ?? []) {
            const key = normalizeName(result.name).replace(/\s+/g, "");
            const original = checked.get(key);
            if (original) checked.set(key, { ...original, ...result });
          }
        }
        checkedCount += batchGroup.reduce((sum, names) => sum + names.length, 0);
        await notifyProgress(`Checked ${checkedCount}/${candidates.length} names`);
      }

      const completed = [...checked.values()];
      const rule = availabilityRule as AvailabilityRule;
      const registrySurvivors = sortCandidates(completed.filter((candidate) => classifyCandidate(candidate, tlds, rule) === "available"));
      const registeredOrBlocked = completed.filter((candidate) => classifyCandidate(candidate, tlds, rule) === "taken");
      const needsReview = completed.filter((candidate) => classifyCandidate(candidate, tlds, rule) === "review");
      await notifyProgress("Sprint complete");

      const shared = {
        runId: sprintId,
        constraints: { tlds, count, availabilityRule },
        counts: {
          generated: completed.length,
          registrySurvivors: registrySurvivors.length,
          registeredOrBlocked: registeredOrBlocked.length,
          needsReview: needsReview.length,
        },
        fallback: fallbackReasons.size > 0,
        fallbackReasons: [...fallbackReasons],
        usage,
        disclaimer: "Registry survivors are likely unregistered signals, not guaranteed registrability. Recheck at a registrar before purchase. Preliminary naming research is not legal clearance.",
      };

      if (!verbose) {
        return toolResult({
          ...shared,
          candidates: registrySurvivors.slice(0, top).map((candidate) => ({
            ...compactCandidate(candidate),
            vein: candidate.vein,
          })),
          strongestRegisteredOrBlocked: sortCandidates(registeredOrBlocked).slice(0, Math.min(5, top)).map(compactCandidate),
          strongestNeedsReview: sortCandidates(needsReview).slice(0, Math.min(5, top)).map(compactCandidate),
          ...(includeLedger ? { ledger: sortCandidates(completed).map(compactCandidate) } : {}),
        });
      }

      return toolResult({
        ...shared,
        brief,
        candidates: registrySurvivors.slice(0, top).map((candidate) => ({
          name: candidate.name,
          vein: candidate.vein,
          rationale: candidate.rationale,
          overallScore: candidate.score?.overall,
          bestDomain: bestQualifyingDomain(candidate, tlds, rule),
          domains: candidate.domains,
        })),
        strongestRegisteredOrBlocked: sortCandidates(registeredOrBlocked).slice(0, Math.min(10, top)).map((candidate) => ({
          name: candidate.name,
          vein: candidate.vein,
          rationale: candidate.rationale,
          overallScore: candidate.score?.overall,
          domains: candidate.domains,
        })),
        strongestNeedsReview: sortCandidates(needsReview).slice(0, Math.min(10, top)).map((candidate) => ({
          name: candidate.name,
          vein: candidate.vein,
          rationale: candidate.rationale,
          overallScore: candidate.score?.overall,
          domains: candidate.domains,
        })),
        ...(includeLedger ? {
          ledger: sortCandidates(completed).map((candidate) => ({
            name: candidate.name,
            vein: candidate.vein,
            rationale: candidate.rationale,
            overallScore: candidate.score?.overall,
            bestDomain: bestQualifyingDomain(candidate, tlds, rule),
            domains: candidate.domains,
          })),
        } : {}),
      });
    },
  );

  server.registerTool(
    "check_names",
    {
      title: "Check names and selected domain endings",
      description: "Check exact domain registry evidence and optional developer namespaces for one or more names. Unknown, timeout, unsupported, or conflicting evidence never becomes available.",
      inputSchema: {
        names: z.array(z.string().min(2).max(64)).min(1).max(100),
        tlds: z.array(z.string().regex(/^\.?[a-z0-9-]{2,24}$/i)).min(1).max(5).default(DEFAULT_TLDS),
        includeNamespaces: z.boolean().default(true),
        verbose: z.boolean().default(false).describe("Return full evidence objects instead of the compact per-name shape"),
        context: z.string().max(10_000).optional().describe("Optional product context for transparent scoring"),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ names, tlds: rawTlds, includeNamespaces, verbose, context }) => {
      const tlds = normalizeTlds(rawTlds);
      const sprintId = requestId("mcp_check");
      const domainBatchSize = Math.max(1, Math.floor(100 / tlds.length));
      const batchSize = includeNamespaces ? Math.min(domainBatchSize, 20) : domainBatchSize;
      const results: Array<Candidate & Record<string, unknown>> = [];
      const usage: Record<string, number> = {};
      const boundedDegradation: unknown[] = [];
      for (const batch of chunkItems(names, batchSize)) {
        const payload = await post("/api/v1/check", { names: batch, tlds, includeNamespaces, context: context ? { product: context } : undefined }, sprintId);
        results.push(...(payload.results ?? []));
        mergeUsage(usage, payload.usage);
        if (payload.boundedDegradation) boundedDegradation.push(payload.boundedDegradation);
      }
      const interpretation = "RDAP not-found is likely unregistered, not a purchase guarantee.";
      if (!verbose) {
        return toolResult({
          results: results.map(compactCandidate),
          usage,
          ...(boundedDegradation.length ? { boundedDegradation } : {}),
          interpretation,
        });
      }
      return toolResult({ results, usage, boundedDegradation, interpretation });
    },
  );

  server.registerTool(
    "analyze_candidates",
    {
      title: "Analyze one to three finalists",
      description: "Run deeper source-backed namesake, namespace, domain, and preliminary trademark-risk research for one to three finalists. Returns unknowns and manual checks explicitly.",
      inputSchema: {
        names: z.array(z.string().min(2).max(64)).min(1).max(3),
        context: z.string().min(3).max(100_000),
        tlds: z.array(z.string().regex(/^\.?[a-z0-9-]{2,24}$/i)).min(1).max(5).default(DEFAULT_TLDS),
        verbose: z.boolean().default(false).describe("Return full research evidence instead of the compact per-name shape"),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ names, context, tlds: rawTlds, verbose }) => {
      const sprintId = requestId("mcp_research");
      const tlds = normalizeTlds(rawTlds);
      const briefPayload = await post("/api/v1/brief", { text: context, source: "MCP finalist context" }, sprintId);
      const payload = await post("/api/v1/research", { names, brief: briefPayload.brief, tlds }, sprintId);
      const disclaimer = "Preliminary research only; not legal advice or legal clearance.";
      if (!verbose) {
        const rows = (payload.results ?? []) as CandidateLike[];
        return toolResult({
          results: rows.map((row) => ({
            ...compactCandidate(row),
            ...(typeof row.strongestReasonFor === "string" ? { strongestReasonFor: row.strongestReasonFor } : {}),
            ...(typeof row.strongestReasonAgainst === "string" ? { strongestReasonAgainst: row.strongestReasonAgainst } : {}),
          })),
          usage: payload.usage,
          disclaimer,
        });
      }
      return toolResult({ results: payload.results, usage: payload.usage, disclaimer });
    },
  );

  server.registerTool(
    "get_purchase_links",
    {
      title: "Get registrar verification links",
      description: "Create exact-domain Porkbun search links for a fresh manual availability and price check. This never purchases, reserves, or claims a domain is available.",
      inputSchema: {
        domains: z.array(z.string().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i)).min(1).max(20),
      },
      annotations: { ...readOnlyAnnotations, openWorldHint: false },
    },
    async ({ domains }) => toolResult({
      links: domains.map((domain) => ({
        domain: domain.toLowerCase(),
        registrar: "Porkbun",
        url: `https://porkbun.com/checkout/search?q=${encodeURIComponent(domain.toLowerCase())}`,
        evidenceState: "manual",
      })),
      disclosure: "Availability and prices can change. Review first-year and renewal prices, premium status, minimum term, fees, taxes, and final registrability at checkout. NamingSignal does not reserve or purchase domains.",
    }),
  );

  return server;
}
