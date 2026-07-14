export type CandidateSortKey =
  | "overall"
  | "editorial"
  | "strategic_fit"
  | "distinctiveness"
  | "pronunciation"
  | "memorability"
  | "spelling"
  | "domain"
  | "channel_fit";

export type SortableCandidate = {
  name: string;
  aiRank?: number;
  score?: { overall: number; dimensions: Array<{ key: string; score: number }> };
  domains?: Array<{ domain: string; status: string }>;
};

function dimensionValue(candidate: SortableCandidate, key: CandidateSortKey) {
  if (key === "overall") return candidate.score?.overall;
  if (key === "editorial") return candidate.aiRank;
  return candidate.score?.dimensions.find((dimension) => dimension.key === key)?.score;
}

function bestDomain(candidate: SortableCandidate, tlds: string[]) {
  return tlds
    .map((tld) => candidate.domains?.find((domain) => domain.domain.toLowerCase().endsWith(`.${tld}`)))
    .find((domain) => domain?.status === "likely_available");
}

/** Sort exactly by the named public key. AI review is never hidden inside overall score order. */
export function sortCandidatesForDisplay<T extends SortableCandidate>(
  candidates: T[],
  key: CandidateSortKey,
  tlds: string[],
): T[] {
  return [...candidates].sort((left, right) => {
    if (key === "editorial") {
      if (left.aiRank !== undefined && right.aiRank === undefined) return -1;
      if (right.aiRank !== undefined && left.aiRank === undefined) return 1;
      if (left.aiRank !== undefined && right.aiRank !== undefined && left.aiRank !== right.aiRank) {
        return left.aiRank - right.aiRank;
      }
    }
    const leftValue = dimensionValue(left, key);
    const rightValue = dimensionValue(right, key);
    if (leftValue === undefined && rightValue !== undefined) return 1;
    if (rightValue === undefined && leftValue !== undefined) return -1;
    const selectedDelta = key === "editorial"
      ? (leftValue ?? Number.MAX_SAFE_INTEGER) - (rightValue ?? Number.MAX_SAFE_INTEGER)
      : (rightValue ?? 0) - (leftValue ?? 0);
    if (selectedDelta) return selectedDelta;
    const leftTld = bestDomain(left, tlds)?.domain.split(".").pop();
    const rightTld = bestDomain(right, tlds)?.domain.split(".").pop();
    const tldDelta = (leftTld ? tlds.indexOf(leftTld) : tlds.length) - (rightTld ? tlds.indexOf(rightTld) : tlds.length);
    if (tldDelta) return tldDelta;
    const overallDelta = (right.score?.overall ?? 0) - (left.score?.overall ?? 0);
    return overallDelta || left.name.localeCompare(right.name);
  });
}
