import type {
  Candidate,
  DecisionRecord,
  DomainResult,
  Evidence,
  ExportOptions,
  NameAnalysis,
  NamespaceResult,
} from "./types";

const LEGAL_NOTICE =
  "This decision record is business research, not legal advice or trademark clearance. Names are primarily a trademark and likelihood-of-confusion issue; a qualified professional should review serious launch candidates.";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function exportEnvelope(record: DecisionRecord, options: ExportOptions): Record<string, unknown> {
  const createdAt = record.createdAt ?? options.now?.().toISOString() ?? new Date().toISOString();
  const envelope: Record<string, unknown> = {
    ...record,
  };
  envelope.schema = "naming-signal.decision/v1";
  envelope.version = record.version ?? "1.0";
  envelope.createdAt = createdAt;
  envelope.legalNotice = LEGAL_NOTICE;
  return envelope;
}

export function exportDecisionJson(record: DecisionRecord, options: ExportOptions = {}): string {
  if (!record || typeof record !== "object") throw new TypeError("A decision record is required.");
  return `${JSON.stringify(stableValue(exportEnvelope(record, options)), null, options.pretty === false ? 0 : 2)}\n`;
}

function text(value: unknown): string {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}

function cell(value: unknown): string {
  return text(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function heading(value: unknown): string {
  return text(value).replace(/[#*_`[\]]/g, "").trim();
}

function safeLink(url: string, label: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return cell(label);
    return `[${cell(label)}](${parsed.toString().replace(/\)/g, "%29")})`;
  } catch {
    return cell(label);
  }
}

function scoreOf(item: Candidate | NameAnalysis): number | undefined {
  return item.score?.overall;
}

function domainsOf(item: Candidate | NameAnalysis): DomainResult[] {
  return item.domains ?? [];
}

function namespacesOf(item: Candidate | NameAnalysis): NamespaceResult[] {
  return "namespaces" in item ? item.namespaces ?? [] : [];
}

function evidenceOf(item: Candidate | NameAnalysis): Evidence[] {
  if ("evidence" in item && item.evidence) return item.evidence;
  return [...domainsOf(item).map((domain) => domain.evidence), ...namespacesOf(item).map((namespace) => namespace.evidence)];
}

function bestDomain(domains: DomainResult[]): string {
  if (!domains.length) return "Not checked";
  const priority = ["likely_available", "premium", "parked", "registered", "active", "unknown", "unsupported"];
  const sorted = [...domains].sort((left, right) => priority.indexOf(left.status) - priority.indexOf(right.status));
  return `${sorted[0].domain} — ${sorted[0].status.replace(/_/g, " ")}`;
}

function domainSignals(domains: DomainResult[]): string {
  if (!domains.length) return "Not checked";
  return domains.map((item) => `${item.domain} — ${item.status.replace(/_/g, " ")}`).join("; ");
}

function namespaceSignals(namespaces: NamespaceResult[]): string {
  if (!namespaces.length) return "Not checked";
  return namespaces.map((item) => `${item.label || item.namespace} — ${item.status.replace(/_/g, " ")}`).join("; ");
}

function table(lines: string[], headers: string[], rows: unknown[][]): void {
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) lines.push(`| ${row.map(cell).join(" | ")} |`);
  lines.push("");
}

function writeEvidence(lines: string[], evidence: Evidence[]): void {
  if (!evidence.length) {
    lines.push("No source-backed evidence was recorded.", "");
    return;
  }
  table(
    lines,
    ["Finding", "State", "Confidence", "Source", "Checked"],
    evidence.map((item) => [
      item.label || item.detail || item.provider,
      item.status,
      item.confidence,
      safeLink(item.sourceUrl, item.provider),
      item.checkedAt,
    ]),
  );
}

/** Produce a portable decision record with evidence and unresolved actions kept visible. */
export function exportDecisionMarkdown(record: DecisionRecord, options: ExportOptions = {}): string {
  if (!record || typeof record !== "object") throw new TypeError("A decision record is required.");
  const generatedAt = record.createdAt ?? options.now?.().toISOString() ?? new Date().toISOString();
  const lines: string[] = [];
  const title = options.title ?? (record.project ? `${record.project} naming decision` : "Naming decision record");
  lines.push(`# ${heading(title)}`, "", `Generated: ${generatedAt}`, "", `> ${LEGAL_NOTICE}`, "");

  if (record.selectedName || record.recommendation) {
    lines.push("## Decision", "");
    if (record.selectedName) lines.push(`**Selected name:** ${text(record.selectedName)}`, "");
    if (record.recommendation) lines.push(text(record.recommendation), "");
  }

  if (record.brief) {
    lines.push("## Naming brief", "");
    table(lines, ["Field", "Current understanding"], [
      ["Product", record.brief.product || "Unknown"],
      ["Primary user", record.brief.primaryUser || "Unknown"],
      ["Pain", record.brief.pain || "Unknown"],
      ["Outcome", record.brief.outcome || "Unknown"],
      ["Mechanism", record.brief.mechanism || "Unknown"],
      ["Platforms", record.brief.platform.join(", ") || "Unknown"],
      ["Acquisition", record.brief.acquisitionChannels.join(", ") || "Unknown"],
      ["Tone", record.brief.brandTone.join(", ") || "Unknown"],
      ["Future scope", record.brief.futureExpansion || "Unknown"],
      ["Domain requirements", record.brief.domainRequirements.join(", ") || "Unknown"],
      ["Avoid", record.brief.avoid.join(", ") || "None supplied"],
    ]);
    if (record.brief.uncertainties.length) {
      lines.push("### Brief uncertainties", "", ...record.brief.uncertainties.map((item) => `- ${text(item)}`), "");
    }
  }

  const shortlist = record.shortlist ?? [];
  if (shortlist.length) {
    lines.push("## Shortlist", "");
    table(
      lines,
      ["Name", "Direction", "Score", "Best domain signal", "Rationale"],
      shortlist.map((item) => [
        item.name,
        "vein" in item ? item.vein : "finalist",
        scoreOf(item) === undefined ? "Unscored" : `${scoreOf(item)}/100`,
        bestDomain(domainsOf(item)),
        "rationale" in item ? item.rationale ?? "" : item.strongestReasonFor ?? item.rationale ?? "",
      ]),
    );
  }

  if (record.candidates?.length) {
    lines.push("## Checked candidate ledger", "");
    table(
      lines,
      ["Name", "Direction", "Score", "All domain checks", "All namespace checks", "Rationale"],
      record.candidates.map((item) => [
        item.name,
        item.vein,
        scoreOf(item) === undefined ? "Unscored" : `${scoreOf(item)}/100`,
        domainSignals(domainsOf(item)),
        namespaceSignals(namespacesOf(item)),
        item.rationale,
      ]),
    );
  }

  if (record.finalists?.length) {
    lines.push("## Finalist diligence", "");
    for (const finalist of record.finalists) {
      lines.push(`### ${heading(finalist.name)}`, "", `**Preliminary score:** ${finalist.score.overall}/100 — ${text(finalist.score.label)}`, "");
      if (finalist.founderResonance !== undefined) {
        lines.push(`**Founder resonance:** ${finalist.founderResonance}/10`, "");
      }
      if (finalist.strongestReasonFor) lines.push(`**Strongest reason for:** ${text(finalist.strongestReasonFor)}`, "");
      if (finalist.strongestReasonAgainst) lines.push(`**Strongest reason against:** ${text(finalist.strongestReasonAgainst)}`, "");
      if (finalist.score.hardBlockers.length) {
        lines.push("**Hard blockers (the score does not override these):**", "", ...finalist.score.hardBlockers.map((item) => `- ${text(item)}`), "");
      }
      if (finalist.score.warnings.length) {
        lines.push("**Warnings and unknowns:**", "", ...finalist.score.warnings.map((item) => `- ${text(item)}`), "");
      }
      table(
        lines,
        ["Dimension", "Score", "Weight", "Basis"],
        finalist.score.dimensions.map((item) => [item.label, `${item.score}/100`, item.weight, item.note]),
      );
      if (finalist.domains?.length) {
        lines.push("#### Domains", "");
        table(
          lines,
          ["Domain", "State", "Evidence state", "Source", "Checked"],
          finalist.domains.map((item) => [
            item.domain,
            item.status,
            item.evidence.status,
            safeLink(item.evidence.sourceUrl, item.provider),
            item.checkedAt,
          ]),
        );
      }
      if (finalist.namespaces?.length) {
        lines.push("#### Namespaces", "");
        table(
          lines,
          ["Namespace", "State", "Evidence state", "Source"],
          finalist.namespaces.map((item) => [
            item.label,
            item.status,
            item.evidence.status,
            safeLink(item.evidence.sourceUrl, item.evidence.provider),
          ]),
        );
      }
      lines.push("#### Evidence ledger", "");
      writeEvidence(lines, evidenceOf(finalist));
      if (finalist.manualLinks?.length) {
        lines.push("#### Manual verification", "", ...finalist.manualLinks.map((item) => `- ${safeLink(item.url, item.label)}${item.reason ? ` — ${text(item.reason)}` : ""}`), "");
      }
    }
  }

  if (record.rejected?.length) {
    lines.push("## Rejected-name ledger", "");
    table(
      lines,
      ["Name", "Reason", "Rejected"],
      record.rejected.map((item) => [item.name, item.reason, item.rejectedAt ?? "Time not recorded"]),
    );
  }

  const actions = record.humanActions ?? [];
  lines.push("## Human actions before commitment", "");
  const requiredActions = [
    ...actions,
    "Recheck the chosen domain at a registrar immediately before purchase.",
    "Run spoken dictation/caption tests when word of mouth, audio, or creator video matters.",
    "Have appropriate counsel perform a comprehensive trademark clearance search for a serious launch.",
  ];
  lines.push(...[...new Set(requiredActions)].map((item) => `- ${text(item)}`), "");

  if (record.notes?.length) lines.push("## Notes", "", ...record.notes.map((item) => `- ${text(item)}`), "");
  if (record.usage) {
    lines.push("## Request usage", "");
    table(lines, ["Metric", "Value"], [
      ["Model calls", record.usage.modelCalls],
      ["Input tokens", record.usage.inputTokens],
      ["Cached input tokens", record.usage.cachedInputTokens],
      ["Reasoning tokens", record.usage.reasoningTokens],
      ["Output tokens", record.usage.outputTokens],
      ["Domain requests", record.usage.domainRequests],
      ["Namespace requests", record.usage.namespaceRequests],
      ["Search queries", record.usage.searchQueries],
      ["Cache hits", record.usage.cacheHits],
      ["Estimated USD", `$${record.usage.estimatedUsd.toFixed(6)}`],
    ]);
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
