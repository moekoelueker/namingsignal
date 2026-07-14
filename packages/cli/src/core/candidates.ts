import { compileBrief } from "./brief";
import { comparisonKey, normalizeName } from "./normalize";
import { candidateAvoidViolations } from "./brief-constraints";
import type { Candidate, CandidateVein, FallbackCandidateOptions, ProjectBrief } from "./types";

const STOP_WORDS = new Set(
  "a an and are as at be because been but by can could did do does for from has have helps how i in into is it its let lets may more most must no not of on or our should so than that the their them then there these they this those through to tool use user users using very was we what when where which who will with without would you your project product service platform software website application app api cli mcp build built make makes help".split(
    " ",
  ),
);

const VEIN_PARTS: Record<string, { left: string[]; right: string[]; rationale: string }> = {
  outcome: {
    left: ["Clear", "Ready", "Open", "Bright", "Better", "Next", "Sure", "Right", "Good", "Fresh"],
    right: ["Path", "Choice", "Signal", "Result", "Lift", "Start", "Fit", "Way", "Move", "Mark"],
    rationale: "Frames the name around the result the user wants rather than the implementation.",
  },
  functional: {
    left: ["Signal", "Context", "Pattern", "Project", "Source", "Intent", "Scope", "Brief", "Trace", "Field"],
    right: ["Lens", "Scout", "Map", "Kit", "Forge", "Index", "Pilot", "Compass", "Lab", "Works"],
    rationale: "Makes the product's working mechanism legible without becoming a feature list.",
  },
  metaphor: {
    left: ["North", "Harbor", "Beacon", "Trail", "Bridge", "Lighthouse", "Anchor", "Cairn", "Orbit", "River"],
    right: ["Star", "Line", "Mark", "Light", "Point", "Gate", "Stone", "Way", "Arc", "Rise"],
    rationale: "Uses a familiar navigation or progress metaphor with room for a broader product story.",
  },
  trust: {
    left: ["Proof", "True", "Known", "Sure", "Sound", "Verified", "Trust", "Solid", "Plain", "Honest"],
    right: ["Ledger", "Signal", "Mark", "Record", "Check", "Source", "Ground", "Proof", "Base", "Guide"],
    rationale: "Signals confidence and traceability while leaving legal or factual certainty to evidence.",
  },
  workflow: {
    left: ["Name", "Launch", "Build", "Maker", "Project", "Decision", "Choice", "Shortlist", "Brand", "Venture"],
    right: ["Desk", "Flow", "Loop", "Stack", "Board", "Lane", "Bench", "Foundry", "Dock", "Room"],
    rationale: "Names the recurring builder workflow and can extend to adjacent decision tools.",
  },
  lateral: {
    left: ["Field", "Relay", "Switch", "Thread", "Second", "Common", "Quiet", "Open", "Side", "Long"],
    right: ["Note", "Yard", "Line", "Table", "Room", "House", "Run", "Form", "Arc", "Fold"],
    rationale: "Moves outside category clichés to create a more ownable, memorable brand direction.",
  },
  coined: {
    left: ["Noma", "Veri", "Sona", "Lumi", "Klar", "Meto", "Orbi", "Vela", "Aven", "Faro"],
    right: ["lio", "via", "ora", "ary", "ivo", "una", "era", "ium", "aro", "ica"],
    rationale: "Explores a compact coined form; pronunciation, language, and collision checks remain mandatory.",
  },
};

const WORKOUT_VEIN_PARTS: Record<string, { left: string[]; right: string[]; rationale: string }> = {
  functional: {
    left: ["Tempo", "Pace", "Set", "Rep", "Cue", "Phase", "Rhythm", "Audio", "Motion", "Cadence"],
    right: ["Guide", "Carry", "Steer", "Flow", "Run", "Pilot", "Path", "Voice", "Track", "Arc"],
    rationale: "Makes the audio-guided workout mechanism legible without reducing the product to a timer.",
  },
  outcome: {
    left: ["Done", "Ready", "Finish", "Steady", "Full", "Easy", "Clear", "Next", "Sure", "Calm"],
    right: ["Flow", "Finish", "Resolve", "Carry", "Start", "Stride", "Motion", "Lift", "Run", "Way"],
    rationale: "Centers momentum, completion, and relief from managing the workout.",
  },
  metaphor: {
    left: ["Beacon", "Relay", "Compass", "Current", "Harbor", "Orbit", "Pulse", "Anchor", "Signal", "Trail"],
    right: ["Beat", "Guide", "Arc", "Path", "Carry", "Line", "Light", "Run", "Mark", "Rise"],
    rationale: "Uses a guidance or momentum metaphor that can extend across movement groups.",
  },
  lateral: {
    left: ["Quiet", "Brio", "Drift", "Hush", "Open", "Soft", "True", "Side", "Daily", "Low"],
    right: ["Loop", "Relay", "Arc", "Form", "Current", "Run", "Motion", "Fold", "Room", "Rise"],
    rationale: "Creates distance from aggressive fitness and generic timer language while preserving calm motion.",
  },
};

const NAMING_VEIN_PARTS: Record<string, { left: string[]; right: string[]; rationale: string }> = {
  functional: {
    left: ["Name", "Naming", "Nym", "Mark", "Decision", "Signal", "Evidence", "Proof", "Brand", "Launch"],
    right: ["Scout", "Guide", "Lens", "Ledger", "Dossier", "Map", "Signal", "Check", "Record", "Verdict"],
    rationale: "Makes the naming-decision workflow legible without presenting the product as a generic generator.",
  },
  outcome: {
    left: ["Ready", "Clear", "Chosen", "Settled", "Done", "Sure", "Launch", "Found", "Final", "True"],
    right: ["Name", "Choice", "Mark", "Signal", "Decision", "Launch", "Greenlight", "Result", "Pick", "Path"],
    rationale: "Centers the move from naming uncertainty to a decision the founder can ship.",
  },
  metaphor: {
    left: ["Cairn", "Beacon", "Compass", "Harbor", "Docket", "Verdict", "Record", "Trail", "Signal", "North"],
    right: ["Mark", "Guide", "Light", "Path", "Point", "Ledger", "Line", "Proof", "Arc", "Gate"],
    rationale: "Uses an evidence, navigation, or decision metaphor with room for a broader launch workflow.",
  },
  lateral: {
    left: ["Indie", "Plain", "Quiet", "Open", "True", "Ready", "Good", "Next", "Side", "Final"],
    right: ["Dossier", "Docket", "Signal", "Record", "Cairn", "Mark", "Choice", "Proof", "Brief", "Found"],
    rationale: "Creates useful distance from commodity AI-generator language while retaining a defensible naming story.",
  },
};

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function rotate<T>(values: T[], offset: number): T[] {
  if (!values.length) return [];
  const normalized = Math.abs(offset) % values.length;
  return [...values.slice(normalized), ...values.slice(0, normalized)];
}

function titleWord(value: string): string {
  const cleaned = normalizeName(value).replace(/\s+/g, "");
  return cleaned ? `${cleaned[0].toUpperCase()}${cleaned.slice(1)}` : "";
}

function rootsFromBrief(brief: ProjectBrief): string[] {
  const fields = [brief.product, brief.outcome, brief.mechanism, brief.pain];
  const words = fields
    .join(" ")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .match(/[a-z][a-z0-9-]{2,14}/g);

  // Keep roots as complete source words. A broad suffix stripper previously
  // turned ordinary product language into fragments such as "naming" ->
  // "nam" and "registered" -> "regist", which then leaked into generated
  // names and score explanations.
  const roots = (words ?? [])
    .filter((word) => word.length >= 3 && word.length <= 11 && !STOP_WORDS.has(word));
  return [...new Set(roots)].slice(0, 12);
}

function parseOptions(options?: number | FallbackCandidateOptions): Required<FallbackCandidateOptions> {
  const input = typeof options === "number" ? { count: options } : options ?? {};
  return {
    count: Math.max(1, Math.min(200, Math.floor(input.count ?? 36))),
    avoid: input.avoid ?? [],
    existingNames: input.existingNames ?? [],
    veins: input.veins ?? [],
  };
}

/**
 * A no-key fallback that creates a diverse, inspectable starting set. It does
 * not imply availability or diligence; live checks happen after generation.
 */
export function generateFallbackCandidates(
  input: ProjectBrief | string,
  options?: number | FallbackCandidateOptions,
): Candidate[] {
  const brief = typeof input === "string" ? compileBrief(input) : input;
  const config = parseOptions(options);
  const seed = hashString(JSON.stringify(brief));
  const avoidKeys = new Set(
    [...brief.avoid, ...config.avoid, ...config.existingNames].map((value) => comparisonKey(value)).filter(Boolean),
  );
  const roots = rootsFromBrief(brief);
  const workoutProfile = /\b(?:workout|exercise|reps?|sets?|cadence|fitness)\b/i.test(
    [brief.product, brief.pain, brief.outcome, brief.mechanism].join(" "),
  );
  const namingProfile = /\b(?:product naming|naming decision|name candidates?|brand name|domain evidence|name generator)\b/i.test(
    [brief.product, brief.pain, brief.outcome, brief.mechanism].join(" "),
  );
  const partsFor = (vein: CandidateVein) =>
    (workoutProfile ? WORKOUT_VEIN_PARTS[vein] : undefined) ??
    (namingProfile ? NAMING_VEIN_PARTS[vein] : undefined) ??
    VEIN_PARTS[vein];
  const publicVeins: CandidateVein[] = ["functional", "outcome", "metaphor", "lateral"];
  const configuredVeins = config.veins.filter((vein) => publicVeins.includes(vein));
  const veins = [...new Set(configuredVeins.length ? configuredVeins : publicVeins)];
  const result: Candidate[] = [];
  const seen = new Set<string>(avoidKeys);

  const add = (name: string, vein: CandidateVein, rationale: string) => {
    const normalized = normalizeName(name);
    const key = comparisonKey(name);
    if (!key || key.length < 4 || key.length > 24 || seen.has(key)) return;
    if (candidateAvoidViolations(name, brief).length) return;
    if ([...avoidKeys].some((avoid) => avoid.length >= 3 && key.includes(avoid))) return;
    seen.add(key);
    result.push({ name, normalized, vein, rationale, provider: "deterministic-fallback" });
  };

  // Start every direction before filling deeper combinations. This protects
  // diversity when a caller requests a small batch.
  for (let veinIndex = 0; veinIndex < veins.length && result.length < config.count; veinIndex += 1) {
    const vein = veins[veinIndex];
    const parts = partsFor(vein);
    const left = rotate(parts.left, seed + veinIndex * 3);
    const right = rotate(parts.right, (seed >>> 3) + veinIndex * 5);
    add(`${left[0]}${right[0]}`, vein, parts.rationale);
  }

  for (let pass = 0; result.length < config.count && pass < 30; pass += 1) {
    for (let veinIndex = 0; veinIndex < veins.length && result.length < config.count; veinIndex += 1) {
      const vein = veins[veinIndex];
      const parts = partsFor(vein);
      const left = rotate(parts.left, seed + veinIndex * 3);
      const right = rotate(parts.right, (seed >>> 3) + veinIndex * 5);
      // The workout profile already has a curated vocabulary. Raw roots such
      // as "audio-first" or "autopilot" create clumsy compounds and can
      // collapse back into feature labels, so reserve root injection for the
      // generic fallback profile.
      const briefRoot = workoutProfile || namingProfile
        ? ""
        : titleWord(roots[(pass + veinIndex) % Math.max(roots.length, 1)] ?? "");

      if (briefRoot && vein !== "coined" && pass % 2 === 0) {
        const rootFirst = vein === "functional" || vein === "workflow";
        add(
          rootFirst ? `${briefRoot}${right[pass % right.length]}` : `${left[pass % left.length]}${briefRoot}`,
          vein,
          `${parts.rationale} Draws on “${briefRoot}” from the editable project brief.`,
        );
      } else {
        add(
          `${left[pass % left.length]}${right[(pass * 3 + veinIndex) % right.length]}`,
          vein,
          parts.rationale,
        );
      }
    }
  }

  // Preserve the brief-led ordering above for ordinary batches, then exhaust
  // deterministic left/right combinations so sparse briefs can still fill a
  // bounded 200-name creator sprint without inventing availability evidence.
  for (let pair = 0; result.length < config.count && pair < 100; pair += 1) {
    for (let veinIndex = 0; veinIndex < veins.length && result.length < config.count; veinIndex += 1) {
      const vein = veins[veinIndex];
      const parts = partsFor(vein);
      const left = rotate(parts.left, seed + veinIndex * 3);
      const right = rotate(parts.right, (seed >>> 3) + veinIndex * 5);
      const leftIndex = Math.floor(pair / right.length) % left.length;
      const rightIndex = (pair + veinIndex * 3) % right.length;
      add(`${left[leftIndex]}${right[rightIndex]}`, vein, parts.rationale);
    }
  }

  return result.slice(0, config.count);
}
