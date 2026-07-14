import { comparisonKey, normalizeName } from "./normalize";
import { candidateBriefConflicts } from "./brief-constraints";
import type {
  Candidate,
  NameCandidateInput,
  NameScore,
  ProjectBrief,
  RiskSignal,
  ScoreContext,
  ScoreDimension,
} from "./types";

const DEFAULT_SATURATED_ROOTS = ["ai", "bot", "gpt", "gen", "smart", "brand", "name", "app", "hub", "ify"];
const BLOCKING_SIGNALS = new Set([
  "active_same_category_collision",
  "hostile_domain_redirect",
  "family_of_marks",
  "voice_transcription_failure",
  "negative_meaning",
  "scope_lock",
]);

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function dimension(
  key: string,
  label: string,
  score: number,
  weight: number,
  note: string,
  source: ScoreDimension["source"],
  manual = false,
): ScoreDimension {
  return { key, label, score: clamp(score), weight, note, source, manual };
}

function wordRoots(value: string): string[] {
  const words = normalizeName(value)
    .split(" ")
    .filter((word) => word.length >= 3);
  return [...new Set(words.flatMap((word) => {
    if (word.length > 4 && word.endsWith("ies")) return [word, `${word.slice(0, -3)}y`];
    if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) return [word, word.slice(0, -1)];
    return [word];
  }))];
}

function lengthScore(name: string): number {
  const length = comparisonKey(name).length;
  if (length >= 5 && length <= 10) return 94;
  if (length >= 3 && length <= 13) return 82;
  if (length <= 16) return 66;
  if (length <= 20) return 45;
  return 24;
}

function pronunciationScore(name: string): { score: number; note: string } {
  const key = comparisonKey(name);
  if (!key) return { score: 0, note: "No pronounceable letters were found." };
  let score = 92;
  const warnings: string[] = [];
  if (/\d/.test(key)) {
    score -= 12;
    warnings.push("digits require a spoken convention");
  }
  if (/[^aeiouy]{4,}/.test(key)) {
    score -= 28;
    warnings.push("long consonant cluster");
  }
  if (/q(?!u)/.test(key)) {
    score -= 16;
    warnings.push("q without u is ambiguous");
  }
  if (/(?:[aeiou]{3,}|(.)\1\1)/.test(key)) {
    score -= 12;
    warnings.push("unusual repeated sound or letter");
  }
  const syllableGroups = key.match(/[aeiouy]+/g)?.length ?? 0;
  if (syllableGroups === 0) {
    score -= 45;
    warnings.push("no obvious vowel sound");
  } else if (syllableGroups >= 5) {
    score -= 18;
    warnings.push("likely five or more syllables");
  }
  return {
    score,
    note: warnings.length
      ? `Mechanical warning: ${warnings.join(", ")}. A real dictation test is still required.`
      : "No obvious text-level pronunciation issue; this is not a speech-recognition test.",
  };
}

function spellingScore(name: string): { score: number; note: string } {
  const raw = name.trim();
  const key = comparisonKey(name);
  let score = 91;
  const issues: string[] = [];
  if (/[-_.\s]/.test(raw)) {
    score -= 8;
    issues.push("word boundary may need explanation");
  }
  if (/\d/.test(raw)) {
    score -= 18;
    issues.push("digit-versus-word ambiguity");
  }
  if (/[xzq]{2}|ph|ght|ae|oe/.test(key)) {
    score -= 9;
    issues.push("more than one plausible spelling");
  }
  if (/[^a-z0-9\s-]/i.test(raw)) {
    score -= 20;
    issues.push("punctuation is not portable across namespaces");
  }
  return {
    score,
    note: issues.length ? `${issues.join("; ")}. Verify by asking someone to spell it after hearing it.` : "Text form is compact and mechanically predictable; verify with a listener.",
  };
}

function semanticFit(name: string, brief?: ProjectBrief): { score: number; note: string } {
  if (!brief) return { score: 50, note: "No brief was supplied, so strategic fit is unscored." };
  const roots = new Set(
    wordRoots([brief.product, brief.pain, brief.outcome, brief.mechanism, ...brief.brandTone].join(" ")),
  );
  const nameKey = comparisonKey(name);
  const hits = [...roots].filter((root) => nameKey.includes(root));
  if (hits.length >= 2) return { score: 91, note: `Connects directly to brief concepts: ${hits.slice(0, 3).join(", ")}.` };
  if (hits.length === 1) {
    const cliché = DEFAULT_SATURATED_ROOTS.find((root) => nameKey.startsWith(root) || nameKey.endsWith(root));
    if (cliché) return { score: 68, note: `Carries the brief root “${hits[0]},” but relies on the saturated “${cliché}” pattern.` };
    return { score: 80, note: `Carries one explicit brief concept: ${hits[0]}.` };
  }
  return {
    score: 38,
    note: "No literal brief root is present. Treat this as an intentionally lateral direction until a human can explain its connection.",
  };
}

function distinctiveness(name: string, context: ScoreContext): { score: number; note: string } {
  const key = comparisonKey(name);
  const workoutCategory = /\b(?:workout|exercise|fitness|reps?|sets?|cadence|bodyweight)\b/i.test(
    [context.brief?.product, context.brief?.pain, context.brief?.outcome, context.brief?.mechanism, context.category].filter(Boolean).join(" "),
  );
  const contextualRoots = workoutCategory
    ? ["workout", "fitness", "gym", "rep", "set", "tempo", "pace", "cadence", "timer", "counter", "guide"]
    : [];
  const roots = [...DEFAULT_SATURATED_ROOTS, ...(context.saturatedRoots ?? [])]
    .map(comparisonKey)
    .filter((root) => root.length >= 2);
  const matched = roots.filter((root) => key.startsWith(root) || key.endsWith(root));
  const contextualMatched = contextualRoots.filter((root) => key.startsWith(root) || key.endsWith(root) || key.endsWith(`${root}s`));
  const competitors = (context.competitorNames ?? []).map(comparisonKey).filter(Boolean);
  const exact = competitors.find((competitor) => competitor === key);
  const near = competitors.find(
    (competitor) => competitor !== key && (competitor.includes(key) || key.includes(competitor)) && Math.min(competitor.length, key.length) >= 5,
  );
  if (exact) return { score: 0, note: "Exact competitor-name collision supplied in the scoring context." };
  if (near) return { score: 24, note: `Strong lexical overlap with supplied competitor “${near}”.` };
  const briefRoots = context.brief
    ? [...new Set(wordRoots([context.brief.product, context.brief.pain, context.brief.outcome, context.brief.mechanism].join(" ")))]
    : [];
  const descriptiveRoots = briefRoots.filter((root) => key.includes(root));
  if (descriptiveRoots.length >= 2) {
    return {
      score: 46,
      note: `Combines multiple literal category roots (${descriptiveRoots.slice(0, 3).join(", ")}); clear, but likely descriptive and crowded.`,
    };
  }
  if (descriptiveRoots.length === 1 && key === comparisonKey(descriptiveRoots[0])) {
    return { score: 52, note: `Uses only the literal category root “${descriptiveRoots[0]},” which is clear but difficult to own.` };
  }
  if (contextualMatched.length >= 2) return { score: 44, note: `Combines common fitness naming roots: ${contextualMatched.join(", ")}.` };
  if (contextualMatched.length === 1) return { score: 64, note: `Uses the familiar fitness naming root “${contextualMatched[0]}”; compare category crowding carefully.` };
  if (matched.length >= 2) return { score: 48, note: `Uses saturated category patterns: ${matched.join(", ")}.` };
  if (matched.length === 1) return { score: 48, note: `Uses a saturated category pattern: ${matched[0]}.` };
  return { score: 86, note: "No supplied competitor collision or default saturated affix was found." };
}

function domainScore(context: ScoreContext): { score: number; note: string } {
  const results = context.domainResults ?? context.candidate?.domains ?? [];
  if (!results.length) return { score: 50, note: "No live domain evidence supplied; domain quality remains unknown." };
  const preferred = context.preferredTld?.replace(/^\./, "").toLowerCase();
  const result =
    results.find((item) => preferred && item.domain.toLowerCase().endsWith(`.${preferred}`)) ??
    results.find((item) => item.status === "likely_available") ??
    results.find((item) => item.status === "premium" || item.status === "parked") ??
    results[0];
  const scores: Record<string, number> = {
    likely_available: 93,
    registered: 38,
    premium: 62,
    parked: 47,
    active: 22,
    unsupported: 45,
    unknown: 45,
  };
  const qualifiers: Record<string, string> = {
    likely_available: "Registry absence is an inferred signal, not a purchase guarantee.",
    registered: "The domain is registered; ownership, use, and acquisition posture still matter.",
    premium: "A premium option can be rational, but price and renewal terms need confirmation.",
    parked: "The matching domain appears parked and may be acquirable.",
    active: "An active matching site materially weakens the domain posture.",
    unsupported: "The TLD is unsupported by the live checker.",
    unknown: "Domain status is unknown because the check did not produce a trustworthy answer.",
  };
  return { score: scores[result.status] ?? 45, note: `${result.domain}: ${qualifiers[result.status]}` };
}

function namespaceScore(context: ScoreContext): { score: number; note: string } {
  const results = context.namespaceResults ?? context.candidate?.namespaces ?? [];
  if (!results.length) return { score: 50, note: "No developer or app-store namespace evidence supplied." };
  const conflicts = results.filter((item) => item.status === "taken" || item.status === "conflict");
  const unknown = results.filter((item) => item.status === "unknown" || item.status === "manual");
  if (conflicts.length >= 3) return { score: 26, note: `${conflicts.length} exact namespace collisions were supplied.` };
  if (conflicts.length) return { score: 55, note: `${conflicts.length} exact namespace collision(s) need review.` };
  if (unknown.length) return { score: 67, note: `No confirmed collision, but ${unknown.length} result(s) remain unknown or manual.` };
  return { score: 91, note: "The supplied exact namespace checks found no collision; broader namesakes still need research." };
}

function extensibilityScore(name: string, context: ScoreContext): { score: number; note: string } {
  if (context.riskSignals?.some((signal) => signal.kind === "scope_lock" && signal.status !== "unknown")) {
    return { score: 10, note: "A supplied scope-lock signal conflicts with the roadmap." };
  }
  const key = comparisonKey(name);
  const narrow = ["ios", "iphone", "pouch", "tiktok", "chrome", "twitter", "shopify", "wordpress"].find((root) =>
    key.includes(root),
  );
  if (narrow) return { score: 42, note: `“${narrow}” may bind the brand to one platform or vertical.` };
  const movementExpansion = /\b(?:multiple movement|beyond pushups|future movement|exercise groups?|circuits?)\b/i.test(
    context.brief?.futureExpansion ?? "",
  );
  const repLock = movementExpansion && ["rep", "pushup", "squat", "burpee", "timer", "counter"].find((root) => key.includes(root));
  if (repLock) return { score: 64, note: `“${repLock}” may narrow a roadmap that explicitly spans multiple movement types.` };
  return context.brief?.futureExpansion
    ? { score: 82, note: "No obvious platform lock was found; compare the metaphor against the stated future scope." }
    : { score: 62, note: "No obvious platform lock was found, but future scope was not explicit." };
}

type ChannelProfile = "spoken" | "developer" | "app_store" | "search" | "sales";

function channelProfiles(
  context: ScoreContext,
  candidate?: Candidate | NameCandidateInput,
): { profiles: ChannelProfile[]; supplied: string[] } {
  const supplied = [
    ...(context.brief?.acquisitionChannels ?? []),
    ...(context.channels ?? []),
  ]
    .map((item) => item.trim())
    .filter(Boolean);
  const category = (context.category ?? candidate?.category ?? "").trim();
  const values = [...supplied, category].map((item) => item.toLocaleLowerCase("en-US"));
  const profiles = new Set<ChannelProfile>();

  if (
    values.some((value) =>
      /\b(?:word[ -]?of[ -]?mouth|spoken|voice|creator|ugc|video|tiktok|reels?|shorts?|podcasts?|radio|referrals?)\b/.test(
        value,
      ),
    )
  ) {
    profiles.add("spoken");
  }
  if (
    values.some((value) =>
      /\b(?:developer|software|agents?|codex|claude|cli|api|mcp|github|npm|pypi)\b/.test(value),
    )
  ) {
    profiles.add("developer");
  }
  if (
    values.some((value) =>
      /\b(?:app[ -]?stores?|consumer[ -]?app|health[ -]?app|mobile|ios|android|aso)\b/.test(value),
    )
  ) {
    profiles.add("app_store");
  }
  if (values.some((value) => /\b(?:search|seo|publication|content|editorial)\b/.test(value))) {
    profiles.add("search");
  }
  if (values.some((value) => /\b(?:business|sales|enterprise|outbound|partnerships?)\b/.test(value))) {
    profiles.add("sales");
  }

  return {
    profiles: [...profiles],
    supplied: [...new Set([...(category ? [`category: ${category}`] : []), ...supplied])],
  };
}

function channelFitScore(
  name: string,
  context: ScoreContext,
  candidate: Candidate | NameCandidateInput | undefined,
  inputs: {
    pronunciation: number;
    spelling: number;
    length: number;
    semantic: number;
    distinctiveness: number;
    namespace: number;
  },
): { score: number; note: string } {
  const { profiles, supplied } = channelProfiles(context, candidate);
  if (!profiles.length) {
    return {
      score: 50,
      note:
        "No acquisition channel or recognized product category was supplied, so channel fit remains a conservative unknown.",
    };
  }

  const profileScores: Record<ChannelProfile, number> = {
    // Text heuristics cannot prove dictation or caption accuracy, so spoken fit
    // stays capped until a person runs the actual speech tests.
    spoken: Math.min(76, inputs.pronunciation * 0.6 + inputs.spelling * 0.4),
    developer: Math.min(
      84,
      inputs.spelling * 0.45 + inputs.length * 0.25 + inputs.namespace * 0.3,
    ),
    app_store: Math.min(
      82,
      inputs.length * 0.35 + inputs.pronunciation * 0.3 + inputs.namespace * 0.35,
    ),
    search: Math.min(
      76,
      inputs.spelling * 0.45 + inputs.semantic * 0.35 + inputs.distinctiveness * 0.2,
    ),
    sales: Math.min(
      78,
      inputs.pronunciation * 0.45 + inputs.spelling * 0.3 + inputs.semantic * 0.25,
    ),
  };
  const score = profiles.reduce((sum, profile) => sum + profileScores[profile], 0) / profiles.length;
  const focus = profiles
    .map((profile) =>
      ({
        spoken: "spoken recall and dictation",
        developer: "typing and developer namespaces",
        app_store: "title fit and app-store collisions",
        search: "spelling and search legibility",
        sales: "sayability and explanation",
      })[profile],
    )
    .join(", ");
  return {
    score,
    note: `Context (${supplied.join(", ")}) emphasizes ${focus}. This is a mechanical proxy for “${name},” not a real audience, dictation, caption, or conversion test.`,
  };
}

function classifySignals(signals: RiskSignal[] = []): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  for (const signal of signals) {
    const confirmed = signal.status === "confirmed" || signal.status === "failed";
    if ((signal.severity === "blocker" || BLOCKING_SIGNALS.has(signal.kind)) && confirmed) blockers.push(signal.detail);
    else if (signal.kind === "trademark_unfinished") warnings.push(`Preliminary trademark work is unfinished: ${signal.detail}`);
    else if (signal.status === "unknown" || signal.status === "manual") warnings.push(`Unresolved: ${signal.detail}`);
    else if (signal.severity === "high" || signal.severity === "medium") warnings.push(signal.detail);
  }
  return { blockers: [...new Set(blockers)], warnings: [...new Set(warnings)] };
}

function asContext(input?: ScoreContext | ProjectBrief): ScoreContext {
  if (!input) return {};
  if ("product" in input && "primaryUser" in input && !("brief" in input)) return { brief: input };
  return input as ScoreContext;
}

/** A transparent triage score. It never substitutes for collision, speech, or legal diligence. */
export function scoreName(nameOrCandidate: string | Candidate | NameCandidateInput, inputContext?: ScoreContext | ProjectBrief): NameScore {
  const candidate = typeof nameOrCandidate === "string" ? undefined : nameOrCandidate;
  const name = typeof nameOrCandidate === "string" ? nameOrCandidate : nameOrCandidate.name;
  if (!normalizeName(name)) throw new TypeError("A non-empty candidate name is required.");
  const baseContext = asContext(inputContext);
  const context: ScoreContext = {
    ...baseContext,
    domainResults: baseContext.domainResults ?? candidate?.domains,
    namespaceResults: baseContext.namespaceResults ?? candidate?.namespaces,
  };

  const pronunciation = pronunciationScore(name);
  const spelling = spellingScore(name);
  const fit = semanticFit(name, context.brief);
  const difference = distinctiveness(name, context);
  const domain = domainScore(context);
  const namespace = namespaceScore(context);
  const extensibility = extensibilityScore(name, context);
  const founderProvided = Number.isFinite(context.founderResonance);
  const founderScore = founderProvided ? clamp(context.founderResonance as number) : 50;
  const channel = channelFitScore(name, context, candidate, {
    pronunciation: pronunciation.score,
    spelling: spelling.score,
    length: lengthScore(name),
    semantic: fit.score,
    distinctiveness: difference.score,
    namespace: namespace.score,
  });
  const evidenceWeight = founderProvided ? 0.88 : 1;
  const weight = (base: number) => base * evidenceWeight;

  const dimensions: ScoreDimension[] = [
    dimension("strategic_fit", "Strategic fit", fit.score, weight(0.22), fit.note, "brief"),
    dimension("memorability", "Memorability", (lengthScore(name) + difference.score) / 2, weight(0.09), "A compact, differentiated text form is easier to retain; real recall testing is still human.", "mechanical"),
    dimension("distinctiveness", "Distinctiveness", difference.score, weight(0.14), difference.note, "brief"),
    dimension("pronunciation", "Pronunciation", pronunciation.score, weight(0.09), pronunciation.note, "mechanical"),
    dimension("spelling", "Spelling predictability", spelling.score, weight(0.07), spelling.note, "mechanical"),
    dimension("length", "Length and title fit", lengthScore(name), weight(0.04), `${comparisonKey(name).length} alphanumeric characters; channel-specific title limits still need checking.`, "mechanical"),
    dimension("domain", "Domain posture", domain.score, weight(0.11), domain.note, "evidence"),
    dimension("namespace", "Namespace posture", namespace.score, weight(0.07), namespace.note, "evidence"),
    dimension("extensibility", "Future extensibility", extensibility.score, weight(0.08), extensibility.note, "brief"),
    dimension(
      "channel_fit",
      "Channel and word-of-mouth fit",
      channel.score,
      weight(0.09),
      channel.note,
      context.brief || context.channels?.length || context.category || candidate?.category
        ? "brief"
        : "mechanical",
    ),
    dimension(
      "founder_resonance",
      "Founder resonance",
      founderScore,
      founderProvided ? 0.12 : 0,
      founderProvided
        ? "Human-entered resonance is included. It may legitimately outweigh a small score delta."
        : "Human judgment required. This dimension is excluded from the total until the founder supplies it.",
      "human",
      !founderProvided,
    ),
  ];

  const weighted = dimensions.filter((item) => item.weight > 0);
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  let overall = weighted.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight;
  const risks = classifySignals(context.riskSignals);
  const briefConflicts = candidateBriefConflicts(name, context.brief);
  const blockers = [...new Set([...risks.blockers, ...briefConflicts.blockers])];
  const warnings = [...risks.warnings, ...briefConflicts.warnings];
  overall -= briefConflicts.penalty;

  if (!context.domainResults?.length) warnings.push("Domain status is unknown until a live registry check runs.");
  if (!context.namespaceResults?.length) warnings.push("Developer and app-store namespaces have not been checked.");
  if (!context.riskSignals?.some((signal) => signal.kind.includes("trademark"))) {
    warnings.push("Preliminary trademark similarity research has not been supplied; this score is not legal clearance.");
  }
  if (!founderProvided) warnings.push("Founder resonance remains a human decision and is not included in the total.");
  if (blockers.length) overall = Math.min(overall, 39);

  const rounded = clamp(overall);
  const label = blockers.length
    ? "Blocked pending resolution"
    : rounded >= 84
      ? "Strong signal"
      : rounded >= 70
        ? "Worth investigating"
        : rounded >= 55
          ? "Mixed signal"
          : "Needs work";
  const summary = blockers.length
    ? `${name} has ${blockers.length} hard blocker${blockers.length === 1 ? "" : "s"}; the numeric score must not override them.`
    : `${name} is a preliminary ${label.toLowerCase()}; live collision evidence and founder judgment remain separate.`;

  return {
    overall: rounded,
    label,
    dimensions,
    hardBlockers: blockers,
    warnings: [...new Set(warnings)],
    summary,
    founderResonanceRequired: !founderProvided,
  };
}

export function scoreNames(
  names: Array<string | Candidate | NameCandidateInput>,
  context?: ScoreContext | ProjectBrief | ((name: string, index: number) => ScoreContext | ProjectBrief),
): NameScore[] {
  return names.map((name, index) => {
    const resolved = typeof context === "function" ? context(typeof name === "string" ? name : name.name, index) : context;
    return scoreName(name, resolved);
  });
}
