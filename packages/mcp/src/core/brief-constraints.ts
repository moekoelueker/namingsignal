import { comparisonKey, normalizeName } from "./normalize";
import type { ProjectBrief } from "./types";

export function explicitAvoidTerms(brief?: ProjectBrief): string[] {
  if (!brief) return [];
  const terms = new Set<string>();
  for (const entry of brief.avoid) {
    const normalized = normalizeName(entry);
    const words = normalized.split(" ").filter(Boolean);
    if (words.length <= 2 && normalized.length <= 28) terms.add(comparisonKey(normalized));
    const examples = entry.match(/(?:such as|including|brands?\s*:?)\s+(.+)$/i)?.[1];
    if (examples) {
      for (const example of examples.split(/[,;/]|\band\b/i)) {
        const key = comparisonKey(example);
        if (key.length >= 3 && key.length <= 24) terms.add(key);
      }
    }
  }
  return [...terms].filter((term) => term.length >= 3);
}

export function candidateAvoidViolations(name: string, brief?: ProjectBrief): string[] {
  const key = comparisonKey(name);
  return explicitAvoidTerms(brief).filter((term) => key.includes(term));
}

export function candidateBriefConflicts(name: string, brief?: ProjectBrief): {
  blockers: string[];
  warnings: string[];
  penalty: number;
} {
  if (!brief) return { blockers: [], warnings: [], penalty: 0 };
  const key = comparisonKey(name);
  const context = normalizeName([
    brief.product,
    brief.pain,
    brief.outcome,
    brief.mechanism,
    brief.futureExpansion,
    ...brief.avoid,
  ].join(" "));
  const blockers: string[] = [];
  const warnings: string[] = [];
  let penalty = 0;

  const avoided = candidateAvoidViolations(name, brief);
  if (avoided.length) {
    blockers.push(`${name} contains an explicitly avoided term: ${avoided.join(", ")}.`);
  }
  if (/\b(?:audio|audible|voice|announces|calls every rep|podcast|music)\b/.test(context) && /(?:inaudible|voiceless|muted)/.test(key)) {
    blockers.push(`${name} contradicts the brief's audible-guidance mechanism.`);
  }
  if (/\b(?:finish|completion|purpose|useful|guided|carries the workout)\b/.test(context) && /(?:aimless|purposeless)/.test(key)) {
    blockers.push(`${name} contradicts the brief's purposeful-completion outcome.`);
  }
  if (/\b(?:avoid|not aggressive|gym bro|punishment|negative)\b/.test(context) && /(?:mindless|gainz|shred|beast|crush|punish)/.test(key)) {
    blockers.push(`${name} uses the negative or gym-bro language the brief excludes.`);
  }
  if (/\b(?:relief|without managing|low decision|mental overhead|autopilot)\b/.test(context) && /(?:tethered|trapped|bound)/.test(key)) {
    warnings.push(`${name} implies restriction while the brief promises relief from micromanagement.`);
    penalty += 18;
  }
  if (/\b(?:workout|exercise|reps|sets)\b/.test(context) && !/\b(?:cycling|bike|bicycle|ride)\b/.test(context) && /(?:pedal|bicycle|cycling)/.test(key)) {
    warnings.push(`${name} suggests cycling even though the brief describes a broader workout product.`);
    penalty += 22;
  }
  return {
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    penalty: Math.min(35, penalty),
  };
}
