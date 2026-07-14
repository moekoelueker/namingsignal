#!/usr/bin/env node

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import {
  checkDomains,
  checkNamespaces,
  compileBrief,
  exportDecisionJson,
  exportDecisionMarkdown,
  generateFallbackCandidates,
  reconcileBriefUncertainties,
  scoreName,
  validateImportText,
  type DecisionRecord,
  type NameAnalysis,
  type ProjectBrief,
  type RiskSignal,
} from "./core/index";

type FlagValue = string | boolean;

const VERSION = "0.2.0";
const DEFAULT_API_URL = "https://namingsignal.com";
// Flags that never consume a following positional argument (they may still
// take an explicit literal "true"/"false" or an inline --flag=value form).
const BOOLEAN_FLAGS = new Set(["namespaces", "json", "dry-run", "help", "version"]);
const MAX_FILE_BYTES = 100_000;
const MAX_TOTAL_BYTES = 250_000;
const MAX_CONTEXT_FILES = 10;
const ALLOWED_FILES = [
  /^readme(?:\.[a-z0-9]+)?$/i,
  /^claude\.md$/i,
  /^agents\.md$/i,
  /^goal\.md$/i,
  /^package\.json$/i,
  /^pyproject\.toml$/i,
  /^cargo\.toml$/i,
  /^go\.mod$/i,
  /^app\.json$/i,
  /^manifest\.json$/i,
];
const ALLOWED_DOC_EXTENSIONS = new Set([".md", ".txt"]);
const DENIED_SEGMENTS = new Set([
  ".git",
  ".env",
  ".next",
  ".output",
  ".turbo",
  ".wrangler",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, FlagValue> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [rawKey, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) {
      flags[rawKey] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (BOOLEAN_FLAGS.has(rawKey)) {
      // Boolean flags never swallow a positional: `check alpha --namespaces beta`
      // must treat beta as a second name, not as the flag's value.
      if (next === "true" || next === "false") {
        flags[rawKey] = next;
        index += 1;
      } else {
        flags[rawKey] = true;
      }
      continue;
    }
    if (next && !next.startsWith("--")) {
      flags[rawKey] = next;
      index += 1;
    } else {
      flags[rawKey] = true;
    }
  }
  return { positional, flags };
}

function flagString(flags: Record<string, FlagValue>, key: string, fallback = "") {
  const value = flags[key];
  return typeof value === "string" ? value : fallback;
}

function flagBoolean(flags: Record<string, FlagValue>, key: string) {
  return flags[key] === true || flags[key] === "true";
}

function withExitCode(error: Error, exitCode: number) {
  (error as Error & { exitCode?: number }).exitCode = exitCode;
  return error;
}

function usageError(message: string) {
  return withExitCode(new Error(message), 2);
}

function exitCodeForStatus(status: number) {
  if (status === 401 || status === 403) return 3;
  if (status === 402 || status === 429) return 4;
  return 1;
}

function printHelp() {
  process.stdout.write(`NamingSignal CLI ${VERSION}

Evidence-backed product naming for developer agents.

USAGE
  namingsignal <command> [arguments] [options]

COMMANDS
  check <name...>             Score names and run live domain checks
  brief <path|file>           Compile a privacy-bounded project brief locally
  generate --brief <file>     Generate deterministic candidate veins from a brief
  research <name...>          Ask a running NamingSignal API for finalist research
  compare <name...>           Produce a portable decision record
  health                      Inspect a running API's provider readiness

CHECK OPTIONS
  --tlds com,io,dev           Domain extensions (default: com,io,dev,app)
  --namespaces                Also check npm, PyPI, GitHub, and Apple
  --category developer-tool   Context for transparent scoring
  --json                      Machine-readable JSON (recommended for agents)

BRIEF OPTIONS
  --out naming-brief.json     Write the brief instead of stdout
  --include docs/overview.md  Explicitly add one safe text file
  --dry-run                   List selected/excluded files without compiling

API OPTIONS
  --api <url>                 Base URL (default: ${DEFAULT_API_URL};
                              env NAMING_SIGNAL_API_URL overrides, for
                              example http://localhost:3000 for local dev)
  NAMING_SIGNAL_API_KEY       User key for hosted API calls (never commit it)
  --format json|md            Export format

COMPARE OPTIONS
  --brief naming-brief.json   Use the approved strategic brief when scoring
  --evidence check-output.json Reuse prior check, research, or run evidence

EXIT CODES
  0 success   1 unexpected or network error   2 usage error
  3 auth error (401/403)   4 quota or rate limit (402/429)

AGENT GUIDES
  https://namingsignal.com/agent-guide.txt  Hosted workflow guide
  https://namingsignal.com/openapi.json     REST discovery contract
  https://github.com/moekoelueker/namingsignal/blob/main/docs/agent-workflow.md
                              Complete AI workflow and evidence rules

PRIVACY
  Repository inspection is local and allowlisted. It excludes source code,
  dependencies, .env files, keys, credentials, lockfiles, and generated output.
  Use --dry-run to see the exact selected files before producing a brief.
`);
}

function isDeniedPath(path: string) {
  return path.split(/[\\/]/).some((segment) => DENIED_SEGMENTS.has(segment) || segment.startsWith(".env"));
}

function isAllowedFile(path: string, explicit = false) {
  const name = basename(path);
  if (isDeniedPath(path)) return false;
  if (ALLOWED_FILES.some((pattern) => pattern.test(name))) return true;
  return explicit && ALLOWED_DOC_EXTENSIONS.has(extname(name).toLowerCase());
}

function documentPriority(path: string) {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const name = basename(normalized);
  if (name === "agents.md") return 0;
  if (name === "claude.md") return 1;
  if (/^goal(?:\d+)?\.md$/.test(name)) return 2;
  if (/product[-_ ]strategy|positioning|product[-_ ]brief/.test(normalized)) return 3;
  if (/^readme(?:\.|$)/.test(name)) return 4;
  if (/\b(?:spec|current-focus|overview)\.md$/.test(normalized)) return 5;
  if (/competitive|app-store|naming/.test(normalized)) return 7;
  if (normalized.includes("/docs/")) return 8;
  return 6;
}

async function declaredContextFiles(root: string, governingFiles: string[]) {
  const declared: string[] = [];
  for (const governing of governingFiles) {
    const text = await readFile(governing, "utf8");
    const precedence = text.match(/##\s+Documents and precedence\b([\s\S]*?)(?=\n##\s|$)/i)?.[0] ?? "";
    const preamble = text.slice(0, Math.max(0, text.search(/##\s+Documents and precedence\b/i)) || Math.min(text.length, 2_000));
    const governingContext = `${precedence}\n${preamble}`;
    const references = [
      ...governingContext.matchAll(/`([^`\n]+\.(?:md|txt))`/gi),
      ...governingContext.matchAll(/\*\*([^*\n]+\.(?:md|txt))\*\*/gi),
      ...governingContext.matchAll(/\b((?:docs\/)?[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)*\.(?:md|txt))\b/gi),
    ].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
    for (const match of references) {
      const reference = match[1]?.trim().replace(/^\.\//, "");
      if (!reference || reference.includes("..")) continue;
      const path = resolve(root, reference);
      if (!path.startsWith(`${resolve(root)}/`) || !isAllowedFile(path, true)) continue;
      try {
        if ((await stat(path)).isFile() && !declared.includes(path)) declared.push(path);
      } catch {
        // A stale declaration is shown by the absence of a selected file; it
        // must never make the scanner leave the repository boundary.
      }
    }
  }
  return declared;
}

async function discoverContextFiles(root: string, explicit?: string) {
  let selected: string[] = [];
  const excluded: { path: string; reason: string }[] = [];
  const rootStat = await stat(root);
  if (rootStat.isFile()) {
    if (!isAllowedFile(root, true)) throw usageError(`Unsupported input file: ${root}`);
    return { selected: [root], excluded };
  }

  const candidates: string[] = [];
  const governing: string[] = [];
  const top = (await readdir(root, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of top) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (DENIED_SEGMENTS.has(entry.name) || entry.name.startsWith(".")) {
        excluded.push({ path, reason: "excluded directory" });
        continue;
      }
      if (entry.name.toLowerCase() === "docs") {
        const docs = (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
        for (const doc of docs) {
          const docPath = join(path, doc.name);
          if (doc.isFile() && isAllowedFile(docPath, true)) candidates.push(docPath);
        }
      }
      continue;
    }
    if (isAllowedFile(path)) {
      candidates.push(path);
      if (/^(?:agents|claude)\.md$/i.test(entry.name)) governing.push(path);
    }
    else excluded.push({ path, reason: "not in context allowlist" });
  }

  const declared = await declaredContextFiles(root, governing);
  const declaredOrder = new Map(declared.map((path, index) => [path, index]));
  selected = [...new Set([...governing, ...declared, ...candidates])]
    .sort((left, right) => {
      const leftDeclared = declaredOrder.get(left);
      const rightDeclared = declaredOrder.get(right);
      if (leftDeclared !== undefined || rightDeclared !== undefined) {
        if (leftDeclared === undefined) return 1;
        if (rightDeclared === undefined) return -1;
        return leftDeclared - rightDeclared;
      }
      return documentPriority(left) - documentPriority(right) || left.localeCompare(right);
    });

  if (explicit) {
    const explicitPath = resolve(root, explicit);
    const rootPrefix = `${resolve(root)}/`;
    if (!explicitPath.startsWith(rootPrefix)) throw usageError("--include must stay inside the project root");
    if (!isAllowedFile(explicitPath, true)) throw usageError("--include accepts only safe Markdown or text files");
    if (!selected.includes(explicitPath)) selected.unshift(explicitPath);
  }

  if (selected.length > MAX_CONTEXT_FILES) {
    for (const path of selected.slice(MAX_CONTEXT_FILES)) {
      excluded.push({ path, reason: `lower-priority context file; pass --include to select it explicitly` });
    }
    selected = selected.slice(0, MAX_CONTEXT_FILES);
  }

  return { selected, excluded };
}

async function readBoundedContext(paths: string[]) {
  let totalBytes = 0;
  const used: { path: string; bytes: number }[] = [];
  const excluded: { path: string; reason: string }[] = [];
  const chunks: string[] = [];
  const documents: { path: string; text: string }[] = [];
  const seenContent = new Set<string>();

  for (const path of paths) {
    const metadata = await stat(path);
    if (metadata.size > MAX_FILE_BYTES) {
      excluded.push({ path, reason: `over ${MAX_FILE_BYTES.toLocaleString()} byte per-file cap` });
      continue;
    }
    if (totalBytes + metadata.size > MAX_TOTAL_BYTES) {
      excluded.push({ path, reason: `over ${MAX_TOTAL_BYTES.toLocaleString()} byte total cap` });
      continue;
    }
    const text = await readFile(path, "utf8");
    const validation = validateImportText(text, { maxBytes: MAX_FILE_BYTES, source: path });
    if (!validation.ok) {
      excluded.push({ path, reason: validation.errors.join("; ") });
      continue;
    }
    const safeText = validation.sanitizedText ?? text;
    const comparison = safeText.replace(/\s+/g, " ").trim();
    if (comparison && seenContent.has(comparison)) {
      excluded.push({ path, reason: "duplicate of a higher-priority selected context file" });
      continue;
    }
    if (comparison) seenContent.add(comparison);
    totalBytes += Buffer.byteLength(safeText);
    used.push({ path, bytes: Buffer.byteLength(safeText) });
    documents.push({ path, text: safeText });
    // Keep provenance in `used`; synthetic source markers must not become part
    // of the semantic brief and outrank terse project descriptions.
    chunks.push(safeText);
  }
  return { text: chunks.join("\n"), documents, used, excluded, totalBytes };
}

function briefSourcePriority(path: string) {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const name = basename(normalized);
  if (/product[-_ ]strategy|positioning|product[-_ ]brief/.test(normalized)) return 0;
  if (/^goal(?:\d+)?\.md$/.test(name)) return 1;
  if (/^readme(?:\.|$)/.test(name)) return 2;
  if (/\b(?:spec|overview)\.md$/.test(normalized)) return 3;
  if (name === "agents.md" || name === "claude.md") return 5;
  return 4;
}

function compileRepositoryBrief(
  root: string,
  documents: Array<{ path: string; text: string }>,
): ProjectBrief {
  const compiled = documents
    .map((document) => ({
      path: document.path,
      priority: briefSourcePriority(document.path),
      brief: compileBrief({
        text: document.text,
        source: `local:${relative(root, document.path) || basename(document.path)}`,
      }),
    }))
    .sort((left, right) => left.priority - right.priority || left.path.localeCompare(right.path));
  const primary = compiled[0]?.brief;
  if (!primary) throw new Error("No safe project context files were found.");
  const scalar = (key: "product" | "primaryUser" | "pain" | "outcome" | "mechanism" | "futureExpansion") =>
    compiled.map((item) => item.brief[key]).find((value) => value.trim()) ?? "";
  const array = (key: "platform" | "acquisitionChannels" | "brandTone" | "domainRequirements" | "avoid") =>
    compiled
      // Governance files often contain implementation do-not lists (for
      // example, "avoid Flutter") that are not naming constraints.
      .filter((item) => key !== "avoid" || !/^(?:agents|claude)\.md$/i.test(basename(item.path)))
      .map((item) => item.brief[key])
      .find((value) => value.length) ?? [];
  const evidence = compiled.flatMap((item) => item.brief.evidence).slice(0, 8);
  return reconcileBriefUncertainties({
    product: scalar("product"),
    primaryUser: scalar("primaryUser"),
    pain: scalar("pain"),
    outcome: scalar("outcome"),
    mechanism: scalar("mechanism"),
    platform: array("platform"),
    acquisitionChannels: array("acquisitionChannels"),
    brandTone: array("brandTone"),
    futureExpansion: scalar("futureExpansion"),
    domainRequirements: array("domainRequirements"),
    avoid: array("avoid"),
    uncertainties: primary.uncertainties,
    evidence,
  });
}

async function commandBrief(args: string[], flags: Record<string, FlagValue>) {
  const input = resolve(args[0] || ".");
  const discovered = await discoverContextFiles(input, flagString(flags, "include") || undefined);
  const root = (await stat(input)).isDirectory() ? input : resolve(input, "..");
  const bounded = await readBoundedContext(discovered.selected);
  const preview = {
    root,
    selected: bounded.used.map((file) => ({ path: relative(root, file.path) || basename(file.path), bytes: file.bytes })),
    excluded: [...discovered.excluded, ...bounded.excluded].map((file) => ({ ...file, path: relative(root, file.path) || basename(file.path) })),
    totalBytes: bounded.totalBytes,
    transmitted: [],
  };

  if (flagBoolean(flags, "dry-run")) {
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    return;
  }
  if (!bounded.text.trim()) throw new Error("No safe project context files were found. Pass a README or use --include with a text file.");
  const brief = compileRepositoryBrief(root, bounded.documents);
  const output = JSON.stringify({ brief, preview }, null, 2);
  const out = flagString(flags, "out");
  if (out) {
    await writeFile(resolve(out), `${output}\n`, "utf8");
    process.stderr.write(`Wrote ${resolve(out)}\n`);
    return;
  }
  process.stdout.write(`${output}\n`);
}

async function commandCheck(names: string[], flags: Record<string, FlagValue>) {
  if (!names.length) throw usageError("Provide at least one name.");
  if (names.length > 100) throw usageError("A single check accepts at most 100 names.");
  const tlds = [...new Set(flagString(flags, "tlds", "com,io,dev,app")
    .split(",")
    .map((item) => item.replace(/^\./, "").trim().toLowerCase())
    .filter(Boolean))];
  if (!tlds.length || tlds.length > 5 || tlds.some((tld) => !/^[a-z0-9-]{2,24}$/.test(tld))) {
    throw usageError("Use one to five valid TLDs, for example --tlds com,app,dev.");
  }
  if (names.length * tlds.length > 100) {
    throw usageError("A single check accepts at most 100 name × TLD combinations.");
  }
  if (flagBoolean(flags, "namespaces") && names.length > 20) {
    throw usageError("Namespace checks accept at most 20 names per command.");
  }
  const category = flagString(flags, "category", "software");
  const started = Date.now();
  const domains = await checkDomains(names.flatMap((name) => {
    const label = name.toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (!label) throw usageError(`Name ${JSON.stringify(name)} has no valid domain-label characters.`);
    return tlds.map((tld) => `${label}.${tld}`);
  }));
  const byDomain = new Map(domains.map((domain) => [domain.domain, domain]));
  const results = [];
  for (const name of names) {
    const label = name.toLowerCase().replace(/[^a-z0-9-]/g, "");
    const nameDomains = tlds.map((tld) => byDomain.get(`${label}.${tld}`)).filter((domain): domain is NonNullable<typeof domain> => Boolean(domain));
    const namespaces = flagBoolean(flags, "namespaces") ? await checkNamespaces(name) : [];
    const score = scoreName(
      { name, category, domains: nameDomains, namespaces },
      { category },
    );
    results.push({ name, score, domains: nameDomains, namespaces });
  }
  const record = { checkedAt: new Date().toISOString(), latencyMs: Date.now() - started, results };
  if (flagBoolean(flags, "json") || !process.stdout.isTTY) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return;
  }
  for (const result of results) {
    process.stdout.write(`\n${result.name} — ${Math.round(result.score.overall)}/100\n`);
    for (const domain of result.domains) process.stdout.write(`  ${domain.domain.padEnd(30)} ${domain.status}\n`);
    for (const namespace of result.namespaces) process.stdout.write(`  ${namespace.namespace.padEnd(30)} ${namespace.status}\n`);
  }
  process.stdout.write(`\nChecked in ${record.latencyMs}ms. RDAP absence is not a purchase guarantee.\n`);
}

async function readBrief(path: string): Promise<ProjectBrief> {
  const raw = JSON.parse(await readFile(resolve(path), "utf8"));
  return raw.brief ?? raw;
}

type EvidenceRow = NameAnalysis & { rationale?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readEvidenceArtifact(path: string): Promise<{ rows: EvidenceRow[]; brief?: ProjectBrief }> {
  const raw = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  const queue: Array<{ value: unknown; depth: number }> = [{ value: raw, depth: 0 }];
  const rows = new Map<string, EvidenceRow>();
  let brief: ProjectBrief | undefined;
  let visited = 0;
  while (queue.length && visited < 5_000) {
    const current = queue.shift()!;
    visited += 1;
    if (current.depth > 6) continue;
    if (typeof current.value === "string" && current.value.trim().startsWith("{")) {
      try { queue.push({ value: JSON.parse(current.value), depth: current.depth + 1 }); } catch { /* Non-JSON evidence text. */ }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) queue.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (!isRecord(current.value)) continue;
    if (!brief && isRecord(current.value.brief) && typeof current.value.brief.product === "string") {
      brief = current.value.brief as unknown as ProjectBrief;
    }
    if (typeof current.value.name === "string" && (Array.isArray(current.value.domains) || Array.isArray(current.value.namespaces) || isRecord(current.value.score))) {
      const key = current.value.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (key) rows.set(key, current.value as unknown as EvidenceRow);
    }
    for (const [key, value] of Object.entries(current.value)) {
      if (["results", "candidates", "ledger", "finalists", "shortlist", "result", "research", "structuredContent", "content"].includes(key)) {
        queue.push({ value, depth: current.depth + 1 });
      }
    }
  }
  return { rows: [...rows.values()], brief };
}

async function commandGenerate(flags: Record<string, FlagValue>) {
  const path = flagString(flags, "brief");
  if (!path) throw usageError("Use --brief <naming-brief.json>.");
  const brief = await readBrief(path);
  const requested = Number(flagString(flags, "count", "24"));
  if (!Number.isInteger(requested) || requested < 4 || requested > 120) {
    throw usageError("--count must be an integer from 4 to 120.");
  }
  const count = requested;
  const candidates = generateFallbackCandidates(brief, { count });
  process.stdout.write(`${JSON.stringify({ provider: "deterministic-fallback", candidates }, null, 2)}\n`);
}

async function apiRequest(path: string, init?: RequestInit, flags: Record<string, FlagValue> = {}) {
  const base = flagString(flags, "api", process.env.NAMING_SIGNAL_API_URL?.trim() || process.env.NAME_LEDGER_API_URL?.trim() || DEFAULT_API_URL).replace(/\/$/, "");
  const apiKey = process.env.NAMING_SIGNAL_API_KEY?.trim();
  const headers = new Headers(init?.headers);
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, headers });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const keyHint = apiKey
      ? ""
      : " NAMING_SIGNAL_API_KEY is not set; hosted calls require a key created at https://namingsignal.com/developers.";
    throw withExitCode(new Error(
      `Could not reach ${base}${path} (${detail}). Check NAMING_SIGNAL_API_URL or --api if you meant a different server (for local development set NAMING_SIGNAL_API_URL=http://localhost:3000).${keyHint}`,
    ), 1);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw withExitCode(new Error(
      `${path} returned HTTP ${response.status} ${response.statusText} from ${base} with a non-JSON response (${contentType || "no content type"}).`,
    ), exitCodeForStatus(response.status));
  }
  const body = (await response.json()) as { error?: string; [key: string]: unknown };
  if (!response.ok) {
    const hint = response.status === 401
      ? " Set NAMING_SIGNAL_API_KEY to a key created at /developers."
      : "";
    throw withExitCode(
      new Error(`${body.error || `${response.status} ${response.statusText}`}${hint}`),
      exitCodeForStatus(response.status),
    );
  }
  return body;
}

async function commandResearch(names: string[], flags: Record<string, FlagValue>) {
  if (!names.length || names.length > 3) throw usageError("Research accepts one to three finalists.");
  const briefPath = flagString(flags, "brief");
  const brief = briefPath ? await readBrief(briefPath) : undefined;
  const body = await apiRequest("/api/v1/research", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": `cli_${Date.now()}` },
    body: JSON.stringify({ names, brief }),
  }, flags);
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
}

async function commandCompare(names: string[], flags: Record<string, FlagValue>) {
  if (names.length < 2) throw usageError("Compare at least two names.");
  const briefPath = flagString(flags, "brief");
  const evidencePath = flagString(flags, "evidence");
  const artifact = evidencePath ? await readEvidenceArtifact(evidencePath) : { rows: [] as EvidenceRow[], brief: undefined };
  const brief = briefPath
    ? await readBrief(briefPath)
    : artifact.brief ?? compileBrief(`Compare these product names: ${names.join(", ")}`);
  const evidenceByName = new Map(artifact.rows.map((row) => [row.name.toLowerCase().replace(/[^a-z0-9]/g, ""), row]));
  const finalists: NameAnalysis[] = names.map((name) => {
    const prior = evidenceByName.get(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const domains = prior?.domains ?? [];
    const namespaces = prior?.namespaces ?? [];
    const riskSignals = prior?.riskSignals as RiskSignal[] | undefined;
    return {
      ...(prior ?? {}),
      name,
      domains,
      namespaces,
      score: scoreName({ name, domains, namespaces }, { brief, domainResults: domains, namespaceResults: namespaces, riskSignals }),
      evidence: prior?.evidence ?? [],
    };
  });
  const missingEvidence = finalists.filter((item) => !item.domains?.length && !item.namespaces?.length).map((item) => item.name);
  const record: DecisionRecord = {
    title: "NamingSignal CLI decision record",
    brief,
    finalists,
    rejected: [],
    notes: evidencePath
      ? missingEvidence.length
        ? [`The evidence artifact contained no domain or namespace rows for: ${missingEvidence.join(", ")}.`]
        : [`Prior evidence loaded from ${resolve(evidencePath)}.`]
      : ["No prior evidence artifact was supplied; domain and namespace posture is explicitly unverified."],
    exportedAt: new Date().toISOString(),
    disclaimer: "Preliminary naming research. Not legal clearance or legal advice.",
  };
  const format = flagString(flags, "format", "json");
  process.stdout.write(format === "md" || format === "markdown" ? exportDecisionMarkdown(record) : exportDecisionJson(record));
  process.stdout.write("\n");
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...args] = positional;
  if (!command || command === "help" || flagBoolean(flags, "help")) {
    printHelp();
    return;
  }
  if (command === "version" || flagBoolean(flags, "version")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  switch (command) {
    case "brief": await commandBrief(args, flags); break;
    case "check": await commandCheck(args, flags); break;
    case "generate": await commandGenerate(flags); break;
    case "research": await commandResearch(args.flatMap((item) => item.split(",")).filter(Boolean), flags); break;
    case "compare": await commandCompare(args.flatMap((item) => item.split(",")).filter(Boolean), flags); break;
    case "health": {
      const body = await apiRequest("/api/v1/health", undefined, flags);
      process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
      break;
    }
    default: throw usageError(`Unknown command: ${command}. Run \"namingsignal help\".`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`NamingSignal: ${message}\n`);
  const exitCode = error instanceof Error ? (error as Error & { exitCode?: number }).exitCode : undefined;
  process.exitCode = typeof exitCode === "number" ? exitCode : 1;
});
