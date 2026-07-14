const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HTTP_SCHEME = /^http:\/\//i;
const HTTPS_SCHEME = /^https:\/\//i;
const SCHEME_RELATIVE = /^\/\//;
const HOST_WITH_PORT = /^[^/?#\s]+:\d+(?:[/?#]|$)/;

/**
 * Turn founder-friendly public web input into an HTTPS URL candidate.
 * Safety validation still happens after this normalization.
 */
export function normalizePublicHttpsUrlInput(input: string | URL): string {
  const raw = input instanceof URL ? input.toString().trim() : input.trim();
  if (!raw) return "";
  if (HTTPS_SCHEME.test(raw)) return raw;
  if (HTTP_SCHEME.test(raw)) return raw.replace(HTTP_SCHEME, "https://");
  if (SCHEME_RELATIVE.test(raw)) return `https:${raw}`;
  if (HOST_WITH_PORT.test(raw)) return `https://${raw}`;
  if (EXPLICIT_SCHEME.test(raw)) return raw;
  return `https://${raw}`;
}
