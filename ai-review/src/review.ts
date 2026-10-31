// One review of a PR: gather the inputs, ask the model for findings, ask it again to drop the weak ones, and anchor
// what's left on diff lines.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ClaudeRunner } from "./claude.ts";
import { anchorFinding, parseDiff } from "./diff.ts";
import { type AnchoredFinding, CATEGORIES, capNits, type Finding, findingId } from "./findings.ts";

const PROMPTS = join(import.meta.dir, "..", "prompts");

/** A finding from an earlier review that is still open, with what people replied. */
export type PriorFinding = {
  id: string;
  threadId: string;
  commentId: number;
  file: string;
  line: number | null;
  message: string;
  replies: { author: string; body: string }[];
  resolvedByAuthor: boolean;
};

export type PriorUpdate = { id: string; status: "fixed" | "answered" | "open"; reply?: string };

export type ReviewOptions = {
  repoDir: string;
  baseSha: string;
  headSha: string;
  title: string;
  body: string;
  /** Repo-specific instructions, read from the base branch. */
  context: string;
  publicRepo: boolean;
  prior: PriorFinding[];
  /** Ids of findings an earlier review already listed in its summary. */
  skipIds: string[];
  extraDirs: string[];
  model: string;
  budgetUsd: number;
  claude: ClaudeRunner;
};

export type ReviewResult = { findings: AnchoredFinding[]; prior: PriorUpdate[]; costUsd: number };

const PUBLIC_RULES = `
This is a public repository, so your findings are public. Report only problems in what this PR changes, not existing
problems elsewhere in the code, and don't refer to anything outside this repository.
`;

async function git(repoDir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repoDir, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  return out;
}

/** The rules files as they are on the base branch, so a PR can't loosen the rules it's reviewed against. */
export async function baseRules(repoDir: string, baseSha: string): Promise<Map<string, string>> {
  const listed = await git(repoDir, ["ls-tree", "-r", "--name-only", baseSha]);
  const paths = listed
    .split("\n")
    .filter((p) => /^(CLAUDE\.md|AGENTS\.md|\.claude\/rules\/.+\.md|\.agents\/.+\.md|.+\/CLAUDE\.md)$/.test(p));
  const files = new Map<string, string>();
  for (const path of paths) files.set(path, await git(repoDir, ["show", `${baseSha}:${path}`]));
  return files;
}

export async function readFromBase(repoDir: string, baseSha: string, path: string): Promise<string> {
  try {
    return await git(repoDir, ["show", `${baseSha}:${path}`]);
  } catch {
    return "";
  }
}

function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");
}

const isCategory = (value: unknown): value is Finding["category"] =>
  typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);

/** Keeps only findings with the fields a comment needs. The schema should ensure this; the model may still stray. */
export function cleanFindings(raw: unknown): Finding[] {
  const list = (raw as { findings?: unknown[] })?.findings ?? [];
  return list.flatMap((item) => {
    const f = item as Record<string, unknown>;
    if (f.severity !== "important" && f.severity !== "nit") return [];
    if (!isCategory(f.category) || typeof f.file !== "string" || typeof f.message !== "string") return [];
    const finding: Finding = { severity: f.severity, category: f.category, file: f.file, message: f.message };
    if (Number.isInteger(f.line) && (f.line as number) > 0) finding.line = f.line as number;
    if (Number.isInteger(f.startLine) && (f.startLine as number) > 0) finding.startLine = f.startLine as number;
    if (typeof f.rule === "string" && f.rule.trim()) finding.rule = f.rule;
    if (typeof f.suggestion === "string") finding.suggestion = f.suggestion;
    return [finding];
  });
}

export function cleanPrior(raw: unknown, prior: PriorFinding[]): PriorUpdate[] {
  const known = new Set(prior.map((p) => p.id));
  const list = (raw as { prior?: unknown[] })?.prior ?? [];
  return list.flatMap((item) => {
    const u = item as Record<string, unknown>;
    if (typeof u.id !== "string" || !known.has(u.id)) return [];
    if (u.status !== "fixed" && u.status !== "answered" && u.status !== "open") return [];
    const update: PriorUpdate = { id: u.id, status: u.status };
    if (typeof u.reply === "string" && u.reply.trim()) update.reply = u.reply.trim();
    return [update];
  });
}

/** Applies the verification pass: drops what it rejected and lowers what it downgraded. Never raises severity. */
export function applyVerification(candidates: Finding[], raw: unknown): Finding[] {
  const decisions = new Map<number, { keep: boolean; severity?: string }>();
  for (const item of (raw as { decisions?: unknown[] })?.decisions ?? []) {
    const d = item as { index?: unknown; keep?: unknown; severity?: unknown };
    if (Number.isInteger(d.index) && typeof d.keep === "boolean") {
      decisions.set(d.index as number, {
        keep: d.keep,
        severity: typeof d.severity === "string" ? d.severity : undefined,
      });
    }
  }
  return candidates.flatMap((finding, index) => {
    const decision = decisions.get(index);
    if (!decision?.keep) return [];
    const severity = decision.severity === "nit" ? "nit" : finding.severity;
    return [{ ...finding, severity }];
  });
}

export async function review(options: ReviewOptions): Promise<ReviewResult> {
  const input = await mkdtemp(join(tmpdir(), "ai-review-"));
  try {
    return await reviewWithInputs(input, options);
  } finally {
    await rm(input, { recursive: true, force: true });
  }
}

async function reviewWithInputs(input: string, options: ReviewOptions): Promise<ReviewResult> {
  const mergeBase = (await git(options.repoDir, ["merge-base", options.baseSha, options.headSha])).trim();
  // The PR controls .gitattributes, which could mark every file binary and leave nothing to comment on.
  const diffText = await git(options.repoDir, [
    "diff",
    "--no-color",
    "--text",
    "--no-ext-diff",
    "--no-textconv",
    mergeBase,
    options.headSha,
  ]);

  await writeFile(join(input, "PR.md"), `# ${options.title}\n\n${options.body}\n`);
  await writeFile(join(input, "pr.diff"), diffText);
  for (const [path, content] of await baseRules(options.repoDir, mergeBase)) {
    await mkdir(dirname(join(input, "rules", path)), { recursive: true });
    await writeFile(join(input, "rules", path), content);
  }
  await writeFile(
    join(input, "prior.json"),
    JSON.stringify(
      options.prior.map(({ id, file, line, message, replies, resolvedByAuthor }) => ({
        id,
        file,
        line,
        message,
        replies,
        resolvedByAuthor,
      })),
      null,
      1,
    ),
  );

  const values = {
    INPUT_DIR: input,
    CONTEXT: options.context.trim(),
    PUBLIC: options.publicRepo ? PUBLIC_RULES : "",
    EXTRA: options.extraDirs.length
      ? `- Other repositories, for context only: ${options.extraDirs.map((d) => `\`${d}\``).join(", ")}. Don't review them.`
      : "",
  };
  const base = {
    cwd: options.repoDir,
    addDirs: [input, ...options.extraDirs],
    model: options.model,
    // The budget covers the whole review, which makes up to two calls.
    budgetUsd: options.budgetUsd / 2,
    timeoutMs: 10 * 60_000,
  };

  const first = await options.claude({
    ...base,
    prompt: render(await Bun.file(join(PROMPTS, "review.md")).text(), values),
    schema: await Bun.file(join(PROMPTS, "review.schema.json")).text(),
  });
  let costUsd = first.costUsd;
  const priorIds = new Set([...options.prior.map((p) => p.id), ...options.skipIds]);
  const candidates = cleanFindings(first.output).filter((f) => !priorIds.has(findingId(f)));

  let verified: Finding[] = [];
  if (candidates.length > 0) {
    await writeFile(
      join(input, "candidates.json"),
      JSON.stringify(
        candidates.map((f, index) => ({ index, ...f })),
        null,
        1,
      ),
    );
    const second = await options.claude({
      ...base,
      prompt: render(await Bun.file(join(PROMPTS, "verify.md")).text(), values),
      schema: await Bun.file(join(PROMPTS, "verify.schema.json")).text(),
    });
    costUsd += second.costUsd;
    verified = applyVerification(candidates, second.output);
  }

  const diff = parseDiff(diffText);
  const findings = capNits(verified).map((f) => ({ ...f, id: findingId(f), anchor: anchorFinding(diff, f) }));
  return { findings, prior: cleanPrior(first.output, options.prior), costUsd };
}
