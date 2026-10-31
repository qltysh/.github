import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClaudeRequest, claudeArgs } from "../src/claude.ts";
import { findingId } from "../src/findings.ts";
import { applyVerification, cleanFindings, cleanPrior, type PriorFinding, review } from "../src/review.ts";

async function git(dir: string, ...args: string[]) {
  const proc = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  return out.trim();
}

let repo = "";
let base = "";
let head = "";

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "ai-review-test-"));
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "CLAUDE.md"), "Use `test` not `it`.\n");
  await writeFile(join(repo, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "base");
  base = await git(repo, "rev-parse", "HEAD");
  await writeFile(join(repo, "CLAUDE.md"), "Anything goes.\n");
  // A PR can try to hide its changes by marking every file binary.
  await writeFile(join(repo, ".gitattributes"), "* -diff\n");
  await writeFile(join(repo, "a.ts"), "export const a = 1;\nexport const b = 3;\nexport const c = 4;\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "head");
  head = await git(repo, "rev-parse", "HEAD");
});

const prior: PriorFinding = {
  id: findingId({ file: "a.ts", category: "bug", message: "old finding" }),
  threadId: "T1",
  commentId: 1,
  file: "a.ts",
  line: 2,
  message: "old finding",
  replies: [{ author: "author", body: "This is intentional." }],
  resolvedByAuthor: false,
};

describe("review", () => {
  test("finds, verifies, caps nits, anchors, and reads rules from the base branch", async () => {
    const calls: ClaudeRequest[] = [];
    const seen = { rules: "", diff: "" };
    const nit = (n: number) => ({ severity: "nit", category: "clarity", file: "a.ts", line: 3, message: `nit ${n}` });
    const result = await review({
      repoDir: repo,
      baseSha: base,
      headSha: head,
      title: "Change b",
      body: "Body",
      context: "Repo context here.",
      publicRepo: true,
      prior: [prior],
      skipIds: [],
      extraDirs: [],
      model: "test-model",
      budgetUsd: 1,
      claude: async (request) => {
        calls.push(request);
        if (calls.length === 1) {
          const input = request.addDirs[0] as string;
          seen.rules = await readFile(join(input, "rules", "CLAUDE.md"), "utf8");
          seen.diff = await readFile(join(input, "pr.diff"), "utf8");
          return {
            costUsd: 0.3,
            output: {
              findings: [
                { severity: "important", category: "bug", file: "a.ts", line: 2, message: "b changed meaning" },
                { severity: "important", category: "bug", file: "a.ts", line: 2, message: "old finding" },
                { severity: "important", category: "design", file: "a.ts", line: 3, message: "c is unused" },
                nit(1),
                nit(2),
                nit(3),
                nit(4),
                { severity: "important", category: "not-a-category", file: "a.ts", message: "dropped" },
              ],
              prior: [{ id: prior.id, status: "answered" }],
            },
          };
        }
        return {
          costUsd: 0.1,
          output: {
            decisions: [
              { index: 0, keep: true, reason: "real" },
              { index: 1, keep: true, severity: "nit", reason: "minor" },
              { index: 2, keep: true, reason: "ok" },
              { index: 3, keep: true, reason: "ok" },
              { index: 4, keep: true, reason: "ok" },
              { index: 5, keep: false, reason: "taste" },
            ],
          },
        };
      },
    });

    expect(calls).toHaveLength(2);
    expect(seen.rules).toBe("Use `test` not `it`.\n");
    expect(seen.diff).toContain("+export const c = 4;");
    expect(calls[0]?.prompt).toContain("Repo context here.");
    expect(calls[0]?.prompt).toContain("This is a public repository");

    expect(result.findings.map((f) => [f.severity, f.message])).toEqual([
      ["important", "b changed meaning"],
      ["nit", "c is unused"],
      ["nit", "nit 1"],
      ["nit", "nit 2"],
    ]);
    expect(result.findings[0]?.anchor).toEqual({ path: "a.ts", line: 2 });
    expect(result.prior).toEqual([{ id: prior.id, status: "answered" }]);
    expect(result.costUsd).toBeCloseTo(0.4);
  });

  test("skips verification when there are no candidates", async () => {
    let calls = 0;
    const result = await review({
      repoDir: repo,
      baseSha: base,
      headSha: head,
      title: "t",
      body: "",
      context: "",
      publicRepo: false,
      prior: [],
      skipIds: [],
      extraDirs: [],
      model: "m",
      budgetUsd: 1,
      claude: async () => {
        calls++;
        return { costUsd: 0.2, output: { findings: [], prior: [] } };
      },
    });
    expect(calls).toBe(1);
    expect(result.findings).toEqual([]);
  });
});

describe("cleaning model output", () => {
  test("cleanFindings drops malformed items and keeps optional fields", () => {
    expect(
      cleanFindings({
        findings: [
          { severity: "important", category: "rule", file: "x", line: 4, startLine: 2, rule: "R", message: "m" },
          { severity: "blocker", category: "bug", file: "x", message: "m" },
          { severity: "nit", category: "bug", file: "x", line: -1, message: "m" },
        ],
      }),
    ).toEqual([
      { severity: "important", category: "rule", file: "x", line: 4, startLine: 2, rule: "R", message: "m" },
      { severity: "nit", category: "bug", file: "x", message: "m" },
    ]);
  });

  test("cleanPrior ignores unknown ids", () => {
    expect(cleanPrior({ prior: [{ id: "nope", status: "fixed" }] }, [prior])).toEqual([]);
  });

  test("applyVerification never raises severity and drops undecided candidates", () => {
    const candidates = [
      { severity: "nit" as const, category: "bug" as const, file: "x", message: "a" },
      { severity: "important" as const, category: "bug" as const, file: "x", message: "b" },
    ];
    expect(applyVerification(candidates, { decisions: [{ index: 0, keep: true, severity: "important" }] })).toEqual([
      { severity: "nit", category: "bug", file: "x", message: "a" },
    ]);
  });
});

describe("claudeArgs", () => {
  test("allows only read tools and ignores project settings", () => {
    const args = claudeArgs({
      cwd: "/repo",
      prompt: "p",
      schema: "{}",
      addDirs: ["/in"],
      model: "m",
      budgetUsd: 2,
      timeoutMs: 1,
    });
    expect(args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--allowedTools") + 4)).toEqual([
      "Read",
      "Grep",
      "Glob",
    ]);
    expect(args).toContain("Bash");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
    expect(args.slice(-2)).toEqual(["--add-dir", "/in"]);
  });
});

describe("claudeEnv", () => {
  test("passes credentials and basics, not the GitHub token or webhook", async () => {
    const { claudeEnv } = await import("../src/claude.ts");
    expect(
      claudeEnv({
        PATH: "/bin",
        HOME: "/h",
        ANTHROPIC_API_KEY: "k",
        GITHUB_TOKEN: "t",
        AI_REVIEW_SLACK_WEBHOOK_URL: "w",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k" });
  });
});
