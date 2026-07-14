import { comparisonKey, normalizeName } from "./normalize";
import type { ProjectBrief } from "./types";

export type NamesakeSourceLike = {
  title: string;
  url: string;
  highlights?: string[];
  excerpt?: string;
};

export type NamesakeSemanticClass =
  | "exact_active_same_category"
  | "near_active_same_category"
  | "exact_same_category"
  | "exact_other_category"
  | "lexical_near_match"
  | "unrelated";

export type ClassifiedNamesakeSource<T extends NamesakeSourceLike = NamesakeSourceLike> = T & {
  semanticClass: NamesakeSemanticClass;
  exactName: boolean;
  nearName: boolean;
  sameCategory: boolean;
  activeProductSignal: boolean;
  blocker: boolean;
};

const CATEGORY_PROFILES = [
  [/(?:product naming|naming decision|brand name|name generator|domain.*name|trademark)/i, /(?:product naming|naming decision|brand name|name generator|domain|trademark|social handle|name validation)/i],
  [/(?:workout|exercise|fitness|reps?|sets?|cadence|bodyweight)/i, /(?:workout|exercise|fitness|training|interval timer|reps?|sets?|bodyweight)/i],
  [/(?:developer|software|api|cli|code|programming)/i, /(?:developer|software|api|cli|code|programming|documentation)/i],
  [/(?:bookkeep|accounting|expense|invoice)/i, /(?:bookkeep|accounting|expense|invoice|finance)/i],
] as const;

function semanticNameKey(value: string) {
  return value.replace(/^naming/, "name");
}

function sourceHost(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function classifyNamesakeSources<T extends NamesakeSourceLike>(
  name: string,
  brief: ProjectBrief | undefined,
  sources: T[],
): Array<ClassifiedNamesakeSource<T>> {
  const nameKey = comparisonKey(name);
  const briefText = [brief?.product, brief?.pain, brief?.outcome, brief?.mechanism].filter(Boolean).join(" ");
  return sources.map((source) => {
    const host = sourceHost(source.url);
    const sourceText = [source.title, source.url, ...(source.highlights ?? []), source.excerpt ?? ""].join(" ");
    const sourceWords = new Set(normalizeName(sourceText).split(" ").map(comparisonKey).filter(Boolean));
    const exactName = sourceWords.has(nameKey) || host.split(".")[0] === nameKey;
    const nearName = !exactName && (
      [...sourceWords].some((word) => semanticNameKey(word) === semanticNameKey(nameKey)) ||
      semanticNameKey(host.split(".")[0]) === semanticNameKey(nameKey)
    );
    const lexicalNear = !exactName && [...sourceWords].some((word) =>
      word.length > nameKey.length && nameKey.length >= 5 && word.startsWith(nameKey),
    );
    const profile = CATEGORY_PROFILES.find(([briefPattern]) => briefPattern.test(briefText));
    const sameCategory = profile ? profile[1].test(sourceText) : false;
    const codeTokenNoise = !sameCategory && /\b(?:api documentation|programming reference|class|method|symbol|code token)\b/i.test(sourceText);
    const trustedStore = host === "play.google.com" || host === "apps.apple.com" || host === "appstore.com";
    const officialMatchingHost = host.split(".")[0] === nameKey;
    const activeProductSignal = (exactName || nearName) && (trustedStore || officialMatchingHost || /\b(?:app|product|company|service|platform|validation)\b/i.test(source.title));
    const blocker = (exactName || nearName) && sameCategory && activeProductSignal;
    const semanticClass: NamesakeSemanticClass = exactName && blocker
      ? "exact_active_same_category"
      : nearName && blocker
        ? "near_active_same_category"
      : exactName && sameCategory
        ? "exact_same_category"
        : exactName && !codeTokenNoise
          ? "exact_other_category"
          : lexicalNear
            ? "lexical_near_match"
            : "unrelated";
    return { ...source, semanticClass, exactName, nearName, sameCategory, activeProductSignal, blocker };
  });
}
