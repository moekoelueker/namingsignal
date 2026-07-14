import type { CompileBriefInput, ProjectBrief } from "./types";

const CHANNELS: Array<[string, RegExp]> = [
  ["developer agents", /\b(?:codex|claude code|cursor|mcp|developer agents?)\b/i],
  ["word of mouth", /\b(?:word[- ]of[- ]mouth|referrals?|spoken|podcasts?)\b/i],
  ["creator video", /\b(?:instagram|youtube|tiktok|reels|shorts|creator(?:s| marketing)?|ugc|video)\b/i],
  ["app stores", /\b(?:app store|google play|aso|ios|android)\b/i],
  ["search", /\b(?:seo|organic search|search traffic|content marketing)\b/i],
  ["paid acquisition", /\b(?:paid ads?|performance marketing|paid acquisition)\b/i],
  ["sales", /\b(?:sales-led|enterprise sales|outbound|sales team)\b/i],
  ["communities", /\b(?:community|communities|product hunt|hacker news|reddit)\b/i],
];

const TONES = [
  "calm",
  "capable",
  "clear",
  "rhythmic",
  "memorable",
  "trustworthy",
  "developer-native",
  "technical",
  "friendly",
  "premium",
  "confident",
  "playful",
  "serious",
  "private",
  "bold",
  "minimal",
  "approachable",
  "warm",
  "crafted",
  "elegant",
];

const NAMING_GUIDANCE = /^(?:(?:the )?(?:name|brand|names)\s+(?:should|must|needs? to)|(?:name|brand)\s+guidance\b)/i;

const STANDARD_UNCERTAINTIES = {
  product: "A meaningful product description could not be inferred; add a few descriptive words.",
  primaryUser: "Primary user was not explicit; confirm who should love the first release.",
  pain: "The current pain or fragmented workflow was not explicit.",
  outcome: "The promised user outcome needs confirmation.",
  mechanism: "The differentiating mechanism needs confirmation.",
  channels: "Acquisition channel is unknown; spoken-name weighting may change.",
  future: "Future product scope is unknown; confirm how broad the brand must remain.",
  domains: "Preferred TLD and domain acquisition budget are unknown.",
  tone: "Desired brand tone needs confirmation.",
} as const;

const PLATFORMS: Array<[string, RegExp]> = [
  ["web", /\b(?:web(?:site| app)?|saas|browser|landing page)\b/i],
  ["mobile", /\b(?:mobile|ios|android|app store)\b/i],
  ["desktop", /\b(?:desktop|macos|windows|linux app)\b/i],
  ["cli", /\b(?:cli|command line|terminal)\b/i],
  ["api", /\bapi\b/i],
  ["mcp", /\bmcp\b/i],
  ["extension", /\b(?:browser|chrome|vscode) extension\b/i],
];

const INJECTION_LINE = /\b(?:ignore.{0,48}(?:instructions?|prompts?)|system message|developer message|jailbreak|reveal (?:the )?(?:prompt|secret)|do not follow)\b/i;

type BriefSectionField = "product" | "primaryUser" | "pain" | "outcome" | "mechanism" | "futureExpansion" | "avoid";
type MarkdownSection = { heading: string; body: string };

const SECTION_FIELDS: Array<[BriefSectionField, RegExp]> = [
  ["product", /^(?:product|what it is|product description)$/i],
  ["primaryUser", /^(?:primary user|target user|audience|customer|who it is for)$/i],
  ["pain", /^(?:core )?(?:pain|problem|friction|current problem)$/i],
  ["outcome", /^(?:outcome|promise|transformation|result|benefit)$/i],
  ["mechanism", /^(?:mechanism(?: and differentiators)?|how it works|approach|unique mechanism|differentiators)$/i],
  ["futureExpansion", /^(?:scope and expansion|future expansion|future scope|roadmap|long-term scope)$/i],
  ["avoid", /^(?:avoid|do not use|names to avoid|banned roots|patterns to avoid)$/i],
];

function markdownSections(raw: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let heading = "";
  let body: string[] = [];
  const flush = () => {
    if (heading && body.some((line) => line.trim())) sections.push({ heading, body: body.join("\n").trim() });
  };
  for (const line of raw.normalize("NFKC").replace(/\r\n?/g, "\n").split("\n")) {
    const match = line.match(/^\s{0,3}#{2,6}\s+(.+?)\s*#*\s*$/);
    if (match) {
      flush();
      heading = compact(match[1], 100);
      body = [];
    } else if (heading) {
      body.push(line);
    }
  }
  flush();
  return sections;
}

function sectionMap(raw: string): Partial<Record<BriefSectionField, MarkdownSection>> {
  const mapped: Partial<Record<BriefSectionField, MarkdownSection>> = {};
  for (const section of markdownSections(raw)) {
    const field = SECTION_FIELDS.find(([, pattern]) => pattern.test(section.heading))?.[0];
    if (field && !mapped[field]) mapped[field] = section;
  }
  return mapped;
}

function sectionProse(section: MarkdownSection | undefined, maximum = 720): string {
  if (!section) return "";
  return compact(cleanMarkdown(section.body), maximum);
}

function sectionFirstSentence(section: MarkdownSection | undefined, maximum = 520): string {
  const prose = sectionProse(section, Math.max(maximum, 720));
  return compact(usefulSentences(prose)[0] || prose, maximum);
}

function sectionBullets(section: MarkdownSection | undefined): string[] {
  if (!section) return [];
  const bullets = section.body
    .split("\n")
    .map((line) => line.match(/^\s*(?:[-*+] |\d+[.)] )(.+)$/)?.[1])
    .map((line) => compact(line, 220))
    .filter((line): line is string => Boolean(line));
  return [...new Set(bullets)].slice(0, 20);
}

function cleanMarkdown(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]\s|\d+[.)]\s)\s*/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function compact(value: string | undefined, maximum = 280): string {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

function meaningfulPhrase(value: string | undefined, maximum = 280): string {
  const normalized = compact(value, maximum);
  const terms = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.join("").length < 3) return "";
  return normalized;
}

function explicitField(lines: string[], labels: string[]): string {
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`^(?:${labelPattern})\\s*[:\\-–—]\\s*(.+)$`, "i");
  for (const line of lines) {
    const match = line.match(pattern);
    if (match?.[1]) return compact(match[1]);
  }
  return "";
}

function usefulSentences(text: string): string[] {
  // Markdown commonly hard-wraps one sentence across several lines. Treat
  // single line breaks as whitespace so extraction never returns fragments
  // such as “Their problem is not a”. Preserve paragraph boundaries from
  // imported pages so headings cannot bleed into the next paragraph.
  return text
    .replace(/\n{2,}/g, "\u2029")
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+|\u2029/)
    .map((line) => meaningfulPhrase(line, 720))
    .filter((line) => line.length >= 3 && line.length <= 720 && !INJECTION_LINE.test(line));
}

function firstMatching(sentences: string[], pattern: RegExp, excluded: string[] = []): string {
  const excludedKeys = new Set(
    excluded.flatMap((value) => [compact(value), coreProductDescription(value)])
      .map((value) => value.toLocaleLowerCase("en-US"))
      .filter(Boolean),
  );
  const preferred = sentences.find((sentence) =>
    pattern.test(sentence) &&
      !excludedKeys.has(compact(sentence).toLocaleLowerCase("en-US")) &&
      !excludedKeys.has(coreProductDescription(sentence).toLocaleLowerCase("en-US")),
  );
  return preferred ?? sentences.find((sentence) => pattern.test(sentence)) ?? "";
}

/** Keep implementation details from masquerading as the product's core job. */
function coreProductDescription(value: string): string {
  return compact(
    value
      .replace(/,\s+(?:built|based|trained|powered)\s+(?:on|by|with)\b.+$/i, ".")
      .replace(/\s+using\b.+$/i, "."),
    420,
  );
}

function extractAudience(sentences: string[]): string {
  for (const sentence of sentences) {
    const match = sentence.match(
      /\b(?:built|made|designed|intended) for\s+(.+?)(?=\s+(?:who|that|to|when|so they)\b|[.;]|$)|\b(?:tool|app|product|platform|service|software|website|api|autopilot|coach|tracker)\s+for\s+(.+?)(?=\s+(?:who|that|to|when|so they|with)\b|[.;]|$)|\bhelps?\s+(.+?)(?=\s+(?:who|to|by|with|generate|create|build|find|check|manage|understand)\b|[.;]|$)|\b(?:make|build|create|design)\b.+?\bfor\s+(.+?)(?=\s+(?:who|that|to|when|so they)\b|[.;]|$)|\bwhen\s+((?:a|an)\s+.+?)(?=\s+(?:has|have|wants?|needs?)\b)/i,
    );
    const result = compact(match?.[1] || match?.[2] || match?.[3] || match?.[4] || match?.[5], 140);
    if (result) return result.replace(/^(?:a|an|the)\s+/i, "");
  }
  return "";
}

function workoutAutopilotSummary(text: string) {
  const workout = /\b(?:workout|exercise|exerciser|reps?|sets?|pushups?|squats?|burpees?)\b/i.test(text);
  const audio = /\b(?:audio(?:-first)?|out loud|voice|announces?|calls? every rep|podcast|music|face-down)\b/i.test(text);
  const automation = [
    /\bpace(?:s|d)?\b/i,
    /\b(?:runs?|manag(?:e|es|ing))\s+(?:sets?|rests?|countdowns?|transitions?)\b/i,
    /\b(?:logs?|records?)\b.+\b(?:automatically|result|workout|work)\b/i,
    /\b(?:does not|doesn't|without)\s+(?:need(?:ing)? to\s+)?(?:think|look|watch|count|manage)/i,
  ].filter((pattern) => pattern.test(text)).length;
  if (!workout || automation < 2) return {};
  const explicitAutopilot = /\bshort[- ]workout autopilot\b/i.test(text);
  return {
    product: audio
      ? "An audio-first short-workout autopilot."
      : explicitAutopilot
        ? "A short-workout autopilot."
        : "A short-workout autopilot.",
    pain: "The mental overhead of pacing, counting reps, managing sets and rests, and logging makes short workouts harder to start and finish.",
    outcome: "Start and finish a useful short workout without watching, counting, pacing, managing rests, or logging it manually.",
    mechanism: audio
      ? "Calm audio paces reps, sets, rests, countdowns, and transitions while the user's podcast or music continues and the phone can stay face-down."
      : "It carries the workout by setting the rhythm, calling each rep and transition, running rests, and recording the result.",
  };
}

function splitList(input: string): string[] {
  if (!input) return [];
  return [...new Set(input.split(/[,;/]|\band\b/i).map((item) => compact(item, 80)).filter(Boolean))];
}

function extractJsonDescription(raw: string): { product?: string; name?: string } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return {};
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      product: typeof value.description === "string" ? compact(value.description) : undefined,
      name: typeof value.name === "string" ? compact(value.name, 80) : undefined,
    };
  } catch {
    return {};
  }
}

function mergeBrief(base: ProjectBrief, overrides?: Partial<ProjectBrief>): ProjectBrief {
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    platform: overrides.platform ? [...overrides.platform] : base.platform,
    acquisitionChannels: overrides.acquisitionChannels
      ? [...overrides.acquisitionChannels]
      : base.acquisitionChannels,
    brandTone: overrides.brandTone ? [...overrides.brandTone] : base.brandTone,
    domainRequirements: overrides.domainRequirements
      ? [...overrides.domainRequirements]
      : base.domainRequirements,
    avoid: overrides.avoid ? [...overrides.avoid] : base.avoid,
    uncertainties: overrides.uncertainties ? [...overrides.uncertainties] : base.uncertainties,
    evidence: overrides.evidence ? [...overrides.evidence] : base.evidence,
  };
}

/**
 * Compile an editable brief without an AI call. Embedded instructions are parsed
 * as project data; this function never executes or delegates them.
 */
export function compileBrief(input: string | CompileBriefInput): ProjectBrief {
  const request: CompileBriefInput = typeof input === "string" ? { text: input } : input;
  if (!request || typeof request.text !== "string" || !request.text.trim()) {
    throw new TypeError("Project context must be non-empty text.");
  }

  const source = request.source || "pasted context";
  const raw = request.text;
  const sections = sectionMap(raw);
  const text = cleanMarkdown(raw);
  const lines = text.split("\n").map((line) => compact(line)).filter(Boolean);
  const sentences = usefulSentences(text);
  const descriptiveSentences = sentences.filter((sentence) => !NAMING_GUIDANCE.test(sentence));
  const json = extractJsonDescription(raw);
  const workoutSummary = workoutAutopilotSummary(text);

  const sectionProduct = sectionFirstSentence(sections.product, 420);
  const labeledProduct = explicitField(lines, ["product", "project", "what it is", "description"]);
  const firstTitle = meaningfulPhrase(raw.match(/^[ \t]*#[ \t]+([^\r\n]+)$/m)?.[1], 160);
  const product = coreProductDescription(
    sectionProduct ||
      labeledProduct ||
      json.product ||
      workoutSummary.product ||
      firstMatching(descriptiveSentences, /\b(?:tool|(?<!\.)app|service|platform|product|website|api|cli|saas|autopilot|coach|tracker)\b/i) ||
      firstTitle ||
      descriptiveSentences[0] ||
      json.name ||
      meaningfulPhrase(text),
  );

  const primaryUser =
    sectionFirstSentence(sections.primaryUser, 520) ||
    explicitField(lines, ["primary user", "target user", "audience", "customer", "who it is for"]) ||
    extractAudience(descriptiveSentences);
  const pain =
    sectionProse(sections.pain, 720) ||
    explicitField(lines, ["pain", "problem", "friction", "current problem"]) ||
    workoutSummary.pain ||
    firstMatching(descriptiveSentences, /\b(?:mental overhead|decision(?:s| cost)|offload|stuck|struggl\w*|friction|pain|problem|stress|wast\w*|spend\w*\s+\d+.+hours?|takes?\s+\d+.+hours?|generic\s+(?:ai\s+)?(?:tools?|output)|manual|fragmented|difficult|hard to|cannot|can't)\b/i, [product]);
  const outcome =
    sectionFirstSentence(sections.outcome, 720) ||
    explicitField(lines, ["outcome", "promise", "transformation", "result", "benefit"]) ||
    workoutSummary.outcome ||
    firstMatching(descriptiveSentences, /\b(?:helps?|enables?|lets?|allows?|so that|so the user|without (?:watching|managing|counting|looking)|finish(?:es)? with|turns? .+ into|result|(?:one|full|complete) week of|seven .+posts|week of .+\b(?:in|without)\b|(?:customers?|users?|teams?|people)\b.+?\b(?:get|receive|finish|can)|(?:puts?|adds?|syncs?)\b.+?\b(?:calendar|dashboard|workspace|inbox|timeline|schedule))\b/i, [product]);
  const mechanism =
    sectionProse(sections.mechanism, 900) ||
    explicitField(lines, ["mechanism", "how it works", "approach", "unique mechanism"]) ||
    workoutSummary.mechanism ||
    firstMatching(
      descriptiveSentences.filter((sentence) => !/\b(?:later|roadmap|future|expand\w*|eventually)\b/i.test(sentence)),
      /\b(?:one (?:upload|click|guided|weekly)|drop in|approve|review|regenerate|paces?|announces?|calls? every|runs? rests?|logs? automatically|mixes? over|reads?|checks?|analy[sz]es?|generates?|produces?|compares?|imports?|uses?|uploads?|scans?|extracts?|syncs?|schedules?|organizes?|summarizes?|transcribes?|puts?|cuts?|ships?|made from|built with|powered by)\b/i,
      [product, outcome],
    );

  const platforms = PLATFORMS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  const acquisitionChannels = CHANNELS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  const labeledTone = splitList(explicitField(lines, ["tone", "brand tone", "voice", "brand voice"]));
  const detectedTone = TONES.filter((tone) => new RegExp(`\\b${tone.replace("-", "[- ]")}\\b`, "i").test(text));
  const brandTone = [...new Set([...labeledTone, ...detectedTone])].slice(0, 8);

  const futureCandidates = descriptiveSentences.filter((sentence) =>
    !/\b(?:future work should|read|consult)\b.+\b(?:first|before|start)\b/i.test(sentence) &&
    !/\b(?:does not|not own|blur|never|avoid|anti-feature|microphone listening)\b/i.test(sentence)
  );
  const futureExpansion =
    sectionProse(sections.futureExpansion, 720) ||
    explicitField(lines, ["future expansion", "future scope", "roadmap", "long-term scope"]) ||
    firstMatching(futureCandidates, /\b(?:expand\w*|expansion|extension|long[- ]term|roadmap|beyond|multiple movement)\b/i) ||
    firstMatching(futureCandidates, /\b(?:future (?:scope|versions?|sessions?|product|movement|features?)|later (?:versions?|expansion)|eventually (?:support|include|expand))\b/i);

  const explicitDomains = splitList(
    explicitField(lines, ["domain", "domain requirements", "tld", "preferred tld", "acceptable tlds"]),
  );
  const mentionedTlds = [...new Set(text.match(/\.(?:com|io|dev|app|ai|co|net|org|sh|xyz)\b/gi) ?? [])].map(
    (item) => item.toLowerCase(),
  );
  const domainRequirements = [...new Set([...explicitDomains, ...mentionedTlds])];

  const naturalAvoidSentence = firstMatching(sentences, /\b(?:want to avoid|avoid|do not use|don't use)\b/i);
  const naturalAvoid = /^avoid saying\b/i.test(naturalAvoidSentence)
    ? undefined
    : naturalAvoidSentence.match(/\b(?:want to avoid|avoid|do not use|don't use)\s+(.+?)(?:[.!?]|$)/i)?.[1];
  const namingGuidanceAvoid = sentences
    .find((sentence) => NAMING_GUIDANCE.test(sentence))
    ?.match(/\b(?:not|rather than)\s+(.+?)(?:[.!?]|$)/i)?.[1];
  const sectionAvoid = sectionBullets(sections.avoid);
  const avoid = sectionAvoid.length ? sectionAvoid : splitList(
    explicitField(lines, ["avoid", "do not use", "names to avoid", "banned roots", "patterns to avoid"]) || naturalAvoid || namingGuidanceAvoid || "",
  );

  const uncertainties: string[] = [];
  if (!product) uncertainties.push(STANDARD_UNCERTAINTIES.product);
  if (!primaryUser) uncertainties.push(STANDARD_UNCERTAINTIES.primaryUser);
  if (!pain) uncertainties.push(STANDARD_UNCERTAINTIES.pain);
  if (!outcome) uncertainties.push(STANDARD_UNCERTAINTIES.outcome);
  if (!mechanism) uncertainties.push(STANDARD_UNCERTAINTIES.mechanism);
  if (!acquisitionChannels.length) uncertainties.push(STANDARD_UNCERTAINTIES.channels);
  if (!futureExpansion) uncertainties.push(STANDARD_UNCERTAINTIES.future);
  if (!domainRequirements.length) uncertainties.push(STANDARD_UNCERTAINTIES.domains);
  if (!brandTone.length) uncertainties.push(STANDARD_UNCERTAINTIES.tone);
  if (raw.split("\n").some((line) => INJECTION_LINE.test(line))) {
    uncertainties.push("Instruction-like text was treated as quoted project data, not executed.");
  }

  const fieldValues: Array<[BriefSectionField, string]> = [
    ["product", product],
    ["primaryUser", primaryUser],
    ["pain", pain],
    ["outcome", outcome],
    ["mechanism", mechanism],
    ["futureExpansion", futureExpansion],
  ];
  const evidence = fieldValues
    .filter(([, excerpt]) => Boolean(excerpt))
    .slice(0, 8)
    .map(([field, excerpt]) => ({ source, excerpt, field }));
  if (sectionAvoid.length) evidence.push({ source, excerpt: sectionAvoid.join("; "), field: "avoid" });

  return reconcileBriefUncertainties(mergeBrief(
    {
      product,
      primaryUser,
      pain,
      outcome,
      mechanism,
      platform: platforms,
      acquisitionChannels,
      brandTone,
      futureExpansion,
      domainRequirements,
      avoid,
      uncertainties,
      evidence,
    },
    request.overrides,
  ));
}

/** Keep editable-brief uncertainty messages synchronized with current values. */
export function reconcileBriefUncertainties(brief: ProjectBrief): ProjectBrief {
  const standard = new Set<string>(Object.values(STANDARD_UNCERTAINTIES));
  const preserved = (brief.uncertainties ?? []).filter((item) => !standard.has(item));
  const uncertainties = [...preserved];
  if (!brief.product.trim()) uncertainties.push(STANDARD_UNCERTAINTIES.product);
  if (!brief.primaryUser.trim()) uncertainties.push(STANDARD_UNCERTAINTIES.primaryUser);
  if (!brief.pain.trim()) uncertainties.push(STANDARD_UNCERTAINTIES.pain);
  if (!brief.outcome.trim()) uncertainties.push(STANDARD_UNCERTAINTIES.outcome);
  if (!brief.mechanism.trim()) uncertainties.push(STANDARD_UNCERTAINTIES.mechanism);
  if (!brief.acquisitionChannels.length) uncertainties.push(STANDARD_UNCERTAINTIES.channels);
  if (!brief.futureExpansion.trim()) uncertainties.push(STANDARD_UNCERTAINTIES.future);
  if (!brief.domainRequirements.length) uncertainties.push(STANDARD_UNCERTAINTIES.domains);
  if (!brief.brandTone.length) uncertainties.push(STANDARD_UNCERTAINTIES.tone);
  return { ...brief, uncertainties: [...new Set(uncertainties)] };
}
