// Which lines of a unified diff GitHub accepts an inline comment on, and how a finding's line maps onto them.

import type { Anchor, Finding } from "./findings.ts";

type Hunk = { start: number; end: number; lines: number[] };
export type FileDiff = { hunks: Hunk[]; commentable: Set<number> };
export type ParsedDiff = Map<string, FileDiff>;

/** Reads `git diff` output. Lines are numbered on the new side, which is the side comments go on. */
export function parseDiff(text: string): ParsedDiff {
  const files: ParsedDiff = new Map();
  let current: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let line = 0;

  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      current = null;
      hunk = null;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4);
      if (path === "/dev/null") {
        current = null;
        continue;
      }
      current = { hunks: [], commentable: new Set() };
      files.set(path.replace(/^b\//, ""), current);
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    const header = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      if (!current) continue;
      line = Number(header[1]);
      hunk = { start: line, end: line, lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (!current || !hunk) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) {
      current.commentable.add(line);
      hunk.lines.push(line);
      hunk.end = line;
      line++;
    }
  }
  return files;
}

function nearest(lines: number[], target: number): number | null {
  let best: number | null = null;
  for (const l of lines) if (best === null || Math.abs(l - target) < Math.abs(best - target)) best = l;
  return best;
}

/**
 * Where a finding goes inline. A line inside the diff stays put. Any other line in a changed file moves to the
 * nearest changed line, so the finding still gets a thread the gate can track. Only a finding about a file the PR
 * didn't change returns null and goes in the summary.
 */
export function anchorFinding(diff: ParsedDiff, finding: Finding): Anchor | null {
  const file = diff.get(finding.file);
  if (!file || file.hunks.length === 0) return null;

  if (finding.line === undefined) {
    const first = file.hunks[0]?.lines[0];
    return first === undefined ? null : { path: finding.file, line: first };
  }

  let line: number | null = file.commentable.has(finding.line) ? finding.line : null;
  let hunk = file.hunks.find((h) => finding.line !== undefined && finding.line >= h.start && finding.line <= h.end);
  if (line === null) {
    const target = finding.line;
    const best = file.hunks
      .map((h) => ({ h, at: nearest(h.lines, target) }))
      .filter((c): c is { h: Hunk; at: number } => c.at !== null)
      .sort((a, b) => Math.abs(a.at - target) - Math.abs(b.at - target))[0];
    if (!best) return null;
    line = best.at;
    hunk = best.h;
  }

  const anchor: Anchor = { path: finding.file, line };
  const start = finding.startLine;
  if (start !== undefined && start < line && hunk && hunk.lines.includes(start)) anchor.startLine = start;
  return anchor;
}
