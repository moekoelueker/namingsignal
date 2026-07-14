export type EditorialReview = {
  verdict: "recommend" | "caution" | "reject";
  concern: string;
  penalty: number;
};

type EditorialScore = {
  overall: number;
  label?: string;
  warnings?: string[];
  summary?: string;
};

function scoreLabel(score: number) {
  if (score >= 84) return "Strong signal";
  if (score >= 70) return "Worth investigating";
  if (score >= 55) return "Mixed signal";
  return "Needs work";
}

/** Apply the ranker's structured concern instead of leaving it as detached prose. */
export function applyEditorialPenalty<T extends EditorialScore>(score: T, review: EditorialReview): T {
  if (review.penalty <= 0) return score;
  const penalty = Math.max(0, Math.min(30, Math.round(review.penalty)));
  const overall = Math.max(0, Math.round(score.overall - penalty));
  const warning = `AI editorial ${review.verdict}: ${review.concern} (${penalty}-point penalty).`;
  return {
    ...score,
    overall,
    label: scoreLabel(overall),
    warnings: [...new Set([...(score.warnings ?? []), warning])],
    summary: `${score.summary ?? "Preliminary score."} ${warning}`,
  };
}
