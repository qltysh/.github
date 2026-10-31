// What a review finds, and how a finding is written into a GitHub comment so a later run can recognize it.

import { createHash } from "node:crypto";

export type Severity = "important" | "nit";

export const CATEGORIES = [
  "bug",
  "security",
  "operational",
  "design",
  "missing-test",
  "rule",
  "clarity",
  "copy",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** One problem the model reported. Lines are on the new (right) side of the diff. */
export type Finding = {
  severity: Severity;
  category: Category;
  file: string;
  line?: number;
  startLine?: number;
  message: string;
  /** The written rule the finding cites, quoted, when it cites one. */
  rule?: string;
  /** Replacement text for the lines startLine..line, when the fix is small and exact. */
  suggestion?: string;
};

/** Where a finding can be posted inline. Null means it goes in the review summary. */
export type Anchor = { path: string; line: number; startLine?: number };

export type AnchoredFinding = Finding & { id: string; anchor: Anchor | null };

/** Important findings are posted inline and can block a merge. At most this many nits reach the summary. */
export const MAX_NITS = 3;

const MARKER = /<!-- qlty-ai-review severity=(important|nit) id=([0-9a-f]{12}) -->/;

/** A stable id, so a re-review can tell an old finding from a new one. */
export function findingId(finding: Pick<Finding, "file" | "category" | "message">): string {
  const key = `${finding.file}\n${finding.category}\n${finding.message.trim().slice(0, 200)}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export function marker(severity: Severity, id: string): string {
  return `<!-- qlty-ai-review severity=${severity} id=${id} -->`;
}

export function parseMarker(body: string): { severity: Severity; id: string } | null {
  const match = body.match(MARKER);
  if (!match) return null;
  return { severity: match[1] as Severity, id: match[2] as string };
}

const LABEL: Record<Severity, string> = { important: "🔴 Important", nit: "🟡 Nit" };

/** The body of an inline comment. Only important findings are posted inline. */
export function formatComment(finding: AnchoredFinding): string {
  const parts = [`**${LABEL[finding.severity]}** · ${finding.category}`, "", finding.message.trim()];
  if (finding.rule) parts.push("", `> ${finding.rule.trim().replace(/\n/g, "\n> ")}`);
  // A suggestion replaces exactly the anchored lines, so it's only safe when the anchor wasn't moved or trimmed.
  const exact =
    finding.anchor && finding.anchor.line === finding.line && finding.anchor.startLine === finding.startLine;
  if (finding.suggestion !== undefined && exact) parts.push("", "```suggestion", finding.suggestion, "```");
  parts.push("", marker(finding.severity, finding.id));
  return parts.join("\n");
}

function location(finding: Finding): string {
  return finding.line ? `\`${finding.file}:${finding.line}\`` : `\`${finding.file}\``;
}

export type SummaryInput = {
  findings: AnchoredFinding[];
  mode: "advisory" | "blocking";
  costUsd: number;
};

const SUMMARY_IDS = /<!-- qlty-ai-review summary ids=([0-9a-f,]*) -->/;

/** Ids of findings an earlier review listed in its summary, so a re-review doesn't list them again. */
export function summaryIds(body: string): string[] {
  return body.match(SUMMARY_IDS)?.[1]?.split(",").filter(Boolean) ?? [];
}

/**
 * The review body. Important findings live in inline threads, which is what the gate counts. The summary adds the
 * ones about files the PR didn't change, which can't take a thread and so don't block, and the nits.
 */
export function formatSummary({ findings, mode, costUsd }: SummaryInput): string {
  const inline = findings.filter((f) => f.severity === "important" && f.anchor);
  const elsewhere = findings.filter((f) => f.severity === "important" && !f.anchor);
  const nits = findings.filter((f) => f.severity === "nit");
  const lines: string[] = [];

  if (inline.length === 0) {
    lines.push("**AI review: no important findings in this change.**");
  } else {
    const verb =
      mode === "blocking" ? "must be fixed, answered or overridden before merge" : "are worth fixing before merge";
    lines.push(`**AI review: ${inline.length} important finding${inline.length === 1 ? "" : "s"}** ${verb}.`);
  }

  if (elsewhere.length > 0) {
    lines.push("", "About files this PR doesn't change. Worth a look; these don't block:", "");
    for (const f of elsewhere) lines.push(`- 🔴 ${location(f)} · ${f.category}: ${f.message.trim()}`);
  }

  if (nits.length > 0) {
    lines.push("", "<details><summary>Nits (optional)</summary>", "");
    for (const f of nits) lines.push(`- 🟡 ${location(f)} · ${f.category}: ${f.message.trim()}`);
    lines.push("", "</details>");
  }

  lines.push(
    "",
    `<sub>Disagree? Reply to the finding and push or comment \`/ai-review\`. A reviewer other than the author can override by resolving the thread with a reason. Cost $${costUsd.toFixed(2)}.</sub>`,
    `<!-- qlty-ai-review summary ids=${[...elsewhere, ...nits].map((f) => f.id).join(",")} -->`,
  );
  return lines.join("\n");
}

/** Keeps every important finding and the first MAX_NITS nits, in the order the model ranked them. */
export function capNits<T extends Finding>(findings: T[]): T[] {
  let nits = 0;
  return findings.filter((f) => f.severity === "important" || ++nits <= MAX_NITS);
}
