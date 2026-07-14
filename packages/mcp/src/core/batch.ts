import type { Candidate, DomainResult, NameScore } from "./types";

export type AvailabilityRule = "any_selected" | "all_selected";

export type CandidateBucket = "available" | "taken" | "review";

export type CandidateSortKey =
  | "overall"
  | "strategic_fit"
  | "memorability"
  | "distinctiveness"
  | "pronunciation"
  | "spelling"
  | "length"
  | "domain"
  | "namespace"
  | "extensibility"
  | "channel_fit"
  | "founder_resonance";

type TldState = CandidateBucket;

const TAKEN_DOMAIN_STATES = new Set<DomainResult["status"]>([
  "registered",
  "premium",
  "parked",
  "active",
]);

function normalizeTld(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  return /^[a-z0-9-]+$/.test(normalized) ? normalized : "";
}

function selectedTlds(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const tld = normalizeTld(value);
    if (!tld || seen.has(tld)) continue;
    seen.add(tld);
    result.push(tld);
  }
  return result;
}

function domainTld(domain: string): string {
  const labels = domain.trim().toLowerCase().replace(/\.$/, "").split(".");
  return labels.length > 1 ? labels.at(-1) ?? "" : "";
}

function stateForTld(domains: readonly DomainResult[], tld: string): TldState {
  const states = new Set<TldState>();
  for (const domain of domains) {
    if (domainTld(domain.domain) !== tld) continue;
    if (domain.status === "likely_available") states.add("available");
    else if (TAKEN_DOMAIN_STATES.has(domain.status)) states.add("taken");
    else states.add("review");
  }

  // Missing evidence and conflicting duplicate evidence both require review.
  if (states.size !== 1) return "review";
  return states.values().next().value ?? "review";
}

export function chunkItems<T>(items: readonly T[], chunkSize: number): T[][] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError("Chunk size must be a positive safe integer.");
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

/**
 * Classify only against the selected TLDs. Unknown, unsupported, missing, or
 * conflicting evidence never becomes available or taken by implication.
 */
export function classifyCandidate(
  candidate: Candidate,
  tlds: readonly string[],
  rule: AvailabilityRule,
): CandidateBucket {
  const normalizedTlds = selectedTlds(tlds);
  if (!normalizedTlds.length) return "review";
  const states = normalizedTlds.map((tld) => stateForTld(candidate.domains ?? [], tld));

  if (rule === "any_selected") {
    if (states.includes("available")) return "available";
    return states.every((state) => state === "taken") ? "taken" : "review";
  }
  if (rule === "all_selected") {
    if (states.every((state) => state === "available")) return "available";
    return states.includes("taken") ? "taken" : "review";
  }
  throw new TypeError(`Unsupported availability rule: ${String(rule)}`);
}

/** Return the highest-priority selected domain that satisfies the rule. */
export function bestQualifyingDomain(
  candidate: Candidate,
  tlds: readonly string[],
  rule: AvailabilityRule = "any_selected",
): DomainResult | undefined {
  if (classifyCandidate(candidate, tlds, rule) !== "available") return undefined;
  const domains = candidate.domains ?? [];
  for (const tld of selectedTlds(tlds)) {
    const result = domains.find(
      (domain) => domainTld(domain.domain) === tld && domain.status === "likely_available",
    );
    if (result) return result;
  }
  return undefined;
}

function finiteScore(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function scoreForKey(score: NameScore | undefined, key: CandidateSortKey): number | undefined {
  if (!score) return undefined;
  if (key === "overall") return finiteScore(score.overall);
  return finiteScore(score.dimensions.find((dimension) => dimension.key === key)?.score);
}

function compareScoresDescending(left: number | undefined, right: number | undefined): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return right - left;
}

/**
 * Return a new deterministic ranking. The selected score descends first,
 * followed by overall score, display name, and original order as the final
 * stable tie-break.
 */
export function sortCandidates(
  candidates: readonly Candidate[],
  key: CandidateSortKey = "overall",
): Candidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      const primary = compareScoresDescending(
        scoreForKey(left.candidate.score, key),
        scoreForKey(right.candidate.score, key),
      );
      if (primary) return primary;

      if (key !== "overall") {
        const overall = compareScoresDescending(
          finiteScore(left.candidate.score?.overall),
          finiteScore(right.candidate.score?.overall),
        );
        if (overall) return overall;
      }

      const insensitiveName = left.candidate.name.localeCompare(right.candidate.name, "en", {
        numeric: true,
        sensitivity: "base",
      });
      if (insensitiveName) return insensitiveName;
      const exactName = left.candidate.name.localeCompare(right.candidate.name, "en", {
        numeric: true,
        sensitivity: "variant",
      });
      return exactName || left.index - right.index;
    })
    .map(({ candidate }) => candidate);
}
