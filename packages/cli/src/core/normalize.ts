const TRADEMARK_MARKS = /[\u00ae\u2122\u2120]/gu;
const DASHES = /[\u2010-\u2015\u2212]/gu;
const COMBINING_MARKS = /\p{M}+/gu;
const NON_NAME_CHARACTERS = /[^a-z0-9]+/g;

/**
 * Produce a comparison-safe form while keeping meaningful word boundaries.
 * This is intentionally not a display-name formatter or a domain lookup.
 */
export function normalizeName(input: string): string {
  if (typeof input !== "string") return "";

  return input
    .replace(TRADEMARK_MARKS, "")
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(DASHES, "-")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(NON_NAME_CHARACTERS, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function toDomainLabel(input: string): string {
  return normalizeName(input)
    .replace(/\band\b/g, "and")
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

/** Normalize and validate a fully-qualified domain, or build one from a name and TLD. */
export function normalizeDomain(input: string, tld?: string): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new TypeError("A domain or name is required.");
  }

  let hostname: string;
  if (tld !== undefined) {
    const label = toDomainLabel(input);
    const normalizedTld = String(tld).trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
    if (!label || !normalizedTld) throw new TypeError("The name and TLD must contain valid DNS characters.");
    hostname = `${label}.${normalizedTld}`;
  } else {
    const raw = input.trim();
    try {
      const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
      hostname = parsed.hostname;
    } catch {
      throw new TypeError(`Invalid fully-qualified domain: ${input}`);
    }
  }

  hostname = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (hostname.length > 253 || !hostname.includes(".")) {
    throw new TypeError(`Invalid fully-qualified domain: ${input}`);
  }

  const labels = hostname.split(".");
  if (
    labels.some(
      (label) =>
        label.length < 1 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    )
  ) {
    throw new TypeError(`Invalid fully-qualified domain: ${input}`);
  }

  return hostname;
}

export function comparisonKey(input: string): string {
  return normalizeName(input).replace(/\s+/g, "");
}
