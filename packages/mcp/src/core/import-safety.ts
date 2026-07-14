import type {
  ImportSecretFinding,
  ImportValidationOptions,
  ImportValidationResult,
  PromptInjectionSignal,
  PublicUrlValidationOptions,
  PublicUrlValidationResult,
} from "./types";

const DENIED_FILE_PATTERNS: Array<[RegExp, string]> = [
  [/(?:^|\/)\.env(?:\.|$)/i, "Environment files are excluded by default."],
  [/(?:^|\/)(?:id_rsa|id_ed25519|credentials|secrets?)(?:\.|$)/i, "Credential and secret files are excluded."],
  [/\.(?:pem|key|p12|pfx|jks|keystore)$/i, "Certificate and private-key containers are excluded."],
  [/\.(?:zip|tar|gz|tgz|bz2|xz|7z|rar|dmg|iso)$/i, "Archives are not accepted as text imports."],
  [/\.(?:png|jpe?g|gif|webp|heic|pdf|mp[34]|mov|avi|woff2?|ttf|ico)$/i, "Binary media is not accepted as a text import."],
  [/(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|Cargo\.lock)$/i, "Lockfiles are excluded from naming context."],
  [/\.(?:map|min\.js)$/i, "Generated files are excluded from naming context."],
];

const SECRET_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { kind: "openai_style_key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
  { kind: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    kind: "credential_assignment",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret)\s*[:=]\s*["']?(?!\s|["']?(?:your|example|placeholder|changeme|todo|none|null)\b)[^\s,"']{8,}["']?/gi,
  },
  {
    kind: "credential_url",
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/:]+:[^\s/@]{4,}@[^\s]+/gi,
  },
];

const INJECTION_PATTERNS: Array<{ kind: string; pattern: RegExp; message: string }> = [
  {
    kind: "instruction_override",
    pattern: /\bignore (?:all |any )?(?:previous|prior|system|developer) instructions?\b/i,
    message: "Instruction-override language is preserved only as quoted project data.",
  },
  {
    kind: "role_impersonation",
    pattern: /\b(?:system|developer|assistant)\s*(?:message|prompt)?\s*:/i,
    message: "Role-like text is not promoted to an instruction.",
  },
  {
    kind: "secret_exfiltration",
    pattern: /\b(?:reveal|print|return|upload|exfiltrate)\b.{0,40}\b(?:secret|token|credential|system prompt)\b/i,
    message: "A possible data-exfiltration instruction was treated as inert text.",
  },
  {
    kind: "tool_instruction",
    pattern: /\b(?:call|invoke|run|execute)\b.{0,30}\b(?:tool|shell|command|curl|fetch)\b/i,
    message: "Tool-execution language is treated as content and is never executed by the compiler.",
  },
];

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function estimatedTokens(value: string): number {
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  return Math.ceil(Math.max(value.length / 4, words * 1.28));
}

function redactLine(line: string, findingKinds: Set<string>): string {
  let output = line;
  for (const item of SECRET_PATTERNS) {
    item.pattern.lastIndex = 0;
    if (!findingKinds.has(item.kind)) continue;
    output = output.replace(item.pattern, `[REDACTED:${item.kind}]`);
  }
  return output;
}

/** Validate arbitrary text before it can become provider input. */
export function validateImportText(text: string, options: ImportValidationOptions = {}): ImportValidationResult {
  const maxBytes = options.maxBytes ?? 250_000;
  const maxTokens = options.maxTokens ?? 12_000;
  const errors: string[] = [];
  const warnings: string[] = [];
  const secretFindings: ImportSecretFinding[] = [];
  const injectionSignals: PromptInjectionSignal[] = [];

  if (typeof text !== "string") {
    return {
      ok: false,
      valid: false,
      sanitizedText: "",
      safeText: "",
      byteLength: 0,
      estimatedTokens: 0,
      errors: ["Import must be text."],
      warnings,
      secretFindings,
      injectionSignals,
      source: options.source,
    };
  }

  const normalized = text.normalize("NFKC").replace(/\r\n?/g, "\n");
  const bytes = byteLength(normalized);
  const tokens = estimatedTokens(normalized);
  if (!normalized.trim()) errors.push("Import is empty.");
  if (bytes > maxBytes) errors.push(`Import is ${bytes} bytes; the limit is ${maxBytes} bytes.`);
  if (tokens > maxTokens) errors.push(`Import is approximately ${tokens} tokens; the model-input limit is ${maxTokens}.`);
  if (/\0/.test(normalized) || (normalized.match(/\uFFFD/g)?.length ?? 0) > Math.max(2, normalized.length / 100)) {
    errors.push("Import appears to contain binary or undecodable content.");
  }

  if (options.fileName) {
    for (const [pattern, message] of DENIED_FILE_PATTERNS) {
      if (pattern.test(options.fileName)) errors.push(message);
    }
  }

  const lines = normalized.split("\n");
  const sanitizedLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const kindsOnLine = new Set<string>();
    for (const secret of SECRET_PATTERNS) {
      secret.pattern.lastIndex = 0;
      if (secret.pattern.test(line)) {
        kindsOnLine.add(secret.kind);
        secretFindings.push({
          kind: secret.kind,
          line: index + 1,
          message: `Possible ${secret.kind.replace(/_/g, " ")} excluded on line ${index + 1}; the value is not returned.`,
        });
      }
    }
    for (const injection of INJECTION_PATTERNS) {
      if (injection.pattern.test(line)) {
        injectionSignals.push({ kind: injection.kind, line: index + 1, message: injection.message });
      }
    }
    sanitizedLines.push(options.redactSecrets === false ? line : redactLine(line, kindsOnLine));
  }

  if (secretFindings.length) {
    errors.push(
      `Import contains ${secretFindings.length} possible secret${secretFindings.length === 1 ? "" : "s"}; remove them before transmission.`,
    );
  }
  if (injectionSignals.length) {
    warnings.push(
      `${injectionSignals.length} instruction-like line${injectionSignals.length === 1 ? " was" : "s were"} detected and will be treated only as data.`,
    );
  }
  if (!options.fileName) warnings.push("No filename was supplied, so path-based secret exclusions could not be applied.");

  const sanitizedText = sanitizedLines.join("\n");
  return {
    ok: errors.length === 0,
    valid: errors.length === 0,
    sanitizedText,
    safeText: sanitizedText,
    byteLength: bytes,
    estimatedTokens: tokens,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    secretFindings,
    injectionSignals,
    source: options.source ?? options.fileName,
  };
}

function parseIpv4(hostname: string): number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  const numbers = parts.map(Number);
  return numbers.every((part) => part >= 0 && part <= 255) ? numbers : undefined;
}

function isBlockedIpv4(parts: number[]): boolean {
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

function parseIpv6(address: string): number[] | undefined {
  let value = address.toLowerCase();
  const dotted = value.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const ipv4 = parseIpv4(dotted);
    if (!ipv4) return undefined;
    value = value.slice(0, -dotted.length) + `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  if ((value.match(/::/g)?.length ?? 0) > 1) return undefined;
  const [leftRaw, rightRaw = ""] = value.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((value.includes("::") && missing < 1) || (!value.includes("::") && missing !== 0)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return undefined;
  return groups.map((group) => Number.parseInt(group, 16));
}

function isBlockedAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const ipv4 = parseIpv4(value);
  if (ipv4) return isBlockedIpv4(ipv4);
  if (!value.includes(":")) return false;
  const groups = parseIpv6(value);
  if (!groups) return true;
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = groups;
  if (groups.every((group) => group === 0) || groups.slice(0, 7).every((group) => group === 0) && eighth === 1) return true;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return true;
  if (first === 0x2001 && second === 0x0db8) return true;
  if (first === 0x0064 && second === 0xff9b) return true;
  if (first === 0x0100 && second === 0 && third === 0 && fourth === 0) return true;
  if (first === 0x2002) return true;
  // IPv4-mapped and IPv4-compatible addresses can otherwise conceal loopback,
  // link-local, metadata, or RFC1918 destinations in hexadecimal form.
  if (first === 0 && second === 0 && third === 0 && fourth === 0 && fifth === 0 && (sixth === 0 || sixth === 0xffff)) {
    return isBlockedIpv4([seventh >> 8, seventh & 0xff, eighth >> 8, eighth & 0xff]);
  }
  return false;
}

const BLOCKED_HOST =
  /^(?:localhost|localhost\.localdomain|metadata|metadata\.google\.internal|instance-data|kubernetes\.default\.svc)$/i;
const BLOCKED_SUFFIX = /\.(?:localhost|local|internal|home|lan|corp|test|invalid|example|onion)$/i;

/**
 * Validate each URL and redirect before server-side fetching. Callers should
 * provide resolveHost in production and pin/recheck the chosen address at fetch
 * time to close DNS-rebinding gaps.
 */
export async function validatePublicUrl(
  input: string,
  options: PublicUrlValidationOptions = {},
): Promise<PublicUrlValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const resolvedAddresses: string[] = [];
  let parsed: URL | undefined;
  try {
    parsed = new URL(input);
  } catch {
    errors.push("URL is not valid.");
  }

  if (!parsed) {
    return { ok: false, valid: false, errors, warnings, resolvedAddresses, requiresDnsVerification: false };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") errors.push("Only HTTP and HTTPS URLs are allowed.");
  if (parsed.protocol === "http:" && options.allowHttp === false) errors.push("Plain HTTP URLs are disabled.");
  else if (parsed.protocol === "http:") warnings.push("Plain HTTP content is unauthenticated; prefer HTTPS.");
  if (parsed.username || parsed.password) errors.push("URLs containing credentials are not allowed.");

  const allowedPorts = options.allowedPorts ?? [80, 443];
  if (parsed.port && !allowedPorts.includes(Number(parsed.port))) errors.push(`Port ${parsed.port} is not allowed.`);

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || BLOCKED_HOST.test(hostname) || BLOCKED_SUFFIX.test(hostname)) errors.push("Private or local hostnames are not allowed.");
  if (hostname === "169.254.169.254" || hostname === "100.100.100.200") errors.push("Cloud metadata endpoints are not allowed.");
  if (isBlockedAddress(hostname)) errors.push("Private, loopback, link-local, documentation, or reserved IP addresses are not allowed.");
  if (!hostname.includes(".") && !hostname.includes(":")) errors.push("Single-label hostnames are not allowed.");

  const literalIp = Boolean(parseIpv4(hostname) || hostname.includes(":"));
  if (!errors.length && options.resolveHost && !literalIp) {
    try {
      const addresses = await options.resolveHost(hostname);
      resolvedAddresses.push(...new Set(addresses.map((address) => address.trim()).filter(Boolean)));
      if (!resolvedAddresses.length) errors.push("Hostname did not resolve to a public address.");
      if (resolvedAddresses.some(isBlockedAddress)) errors.push("Hostname resolves to a private or reserved address.");
    } catch {
      errors.push("Hostname resolution failed; URL fetch was denied.");
    }
  }

  const requiresDnsVerification = !literalIp && !options.resolveHost;
  if (requiresDnsVerification && !errors.length) {
    warnings.push("Resolve and verify the hostname again at fetch time; syntax validation alone does not prevent DNS rebinding.");
  }

  parsed.hash = "";
  return {
    ok: errors.length === 0,
    valid: errors.length === 0,
    url: errors.length ? undefined : parsed.toString(),
    hostname,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    resolvedAddresses,
    requiresDnsVerification,
  };
}
