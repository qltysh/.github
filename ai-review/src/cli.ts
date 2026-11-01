#!/usr/bin/env bun
// Entry point. `review` and `gate` run in GitHub Actions; `local` runs the same review on a branch before it's pushed.
//
//   bun ai-review/src/cli.ts review | gate | gate-sha | local [--base <ref>]"   review the PR in AI_REVIEW_PR, post findings, set the ai-review status
//   bun ai-review/src/cli.ts gate      recompute the ai-review status from the PR's threads
//   bun ai-review/src/cli.ts gate-sha  the same, for the open PR whose head is AI_REVIEW_SHA (fork PRs)
//   bun ai-review/src/cli.ts local [--base <ref>]   review the current branch and print findings

import { BudgetError, runClaude } from "./claude.ts";
import { type AnchoredFinding, formatComment, formatSummary, parseMarker, summaryIds } from "./findings.ts";
import { evaluateGate, skippedDescription } from "./gate.ts";
import { GitHub, type ReviewComment, type ThreadDetail } from "./github.ts";
import { type PriorFinding, type PriorUpdate, readFromBase, review } from "./review.ts";

type Mode = "advisory" | "blocking";

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
};

const config = () => ({
  mode: (process.env.AI_REVIEW_MODE === "blocking" ? "blocking" : "advisory") as Mode,
  publicRepo: process.env.AI_REVIEW_PUBLIC === "true",
  contextFile: env("AI_REVIEW_CONTEXT_FILE", ".github/ai-review.md"),
  repoDir: env("AI_REVIEW_REPO_DIR", process.cwd()),
  extraDirs: (process.env.AI_REVIEW_EXTRA_DIRS ?? "").split(":").filter(Boolean),
  model: env("AI_REVIEW_MODEL", "claude-opus-5-5"),
  budgetUsd: Number(env("AI_REVIEW_BUDGET_USD", "3")),
  botLogin: env("AI_REVIEW_BOT_LOGIN", "github-actions"),
});

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Open findings the bot posted earlier, for the model to re-check. Only the author's and maintainers' replies are
 * passed on: on a public repo anyone can reply to a thread, and a reply is text the model reads.
 */
export function priorFromThreads(threads: ThreadDetail[], botLogin: string, prAuthor: string): PriorFinding[] {
  return threads.flatMap((t) => {
    const marker = parseMarker(t.body);
    if (t.author !== botLogin || !marker) return [];
    const resolvedByAuthor = t.isResolved && t.resolvedBy === prAuthor;
    if (t.isResolved && !resolvedByAuthor) return [];
    const first = t.comments[0];
    if (!first) return [];
    return [
      {
        id: marker.id,
        threadId: t.id,
        commentId: first.databaseId,
        file: t.path,
        line: t.line,
        message: t.body.replace(/<!--[\s\S]*?-->/g, "").trim(),
        replies: t.comments
          .slice(1)
          .filter((c) => c.author === prAuthor || TRUSTED_ASSOCIATIONS.has(c.association))
          .map((c) => ({ author: c.author, body: c.body })),
        resolvedByAuthor,
      },
    ];
  });
}

export function inlineComments(findings: AnchoredFinding[]): ReviewComment[] {
  return findings
    .filter((f) => f.severity === "important" && f.anchor)
    .map((f) => {
      const anchor = f.anchor as NonNullable<AnchoredFinding["anchor"]>;
      const comment: ReviewComment = { path: anchor.path, line: anchor.line, side: "RIGHT", body: formatComment(f) };
      if (anchor.startLine !== undefined) {
        comment.start_line = anchor.startLine;
        comment.start_side = "RIGHT";
      }
      return comment;
    });
}

async function alert(text: string): Promise<void> {
  const url = process.env.AI_REVIEW_SLACK_WEBHOOK_URL;
  if (!url) return;
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
}

function runUrl(): string | undefined {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : undefined;
}

/** Secret-shaped strings never reach a comment, even if a prompt injection gets the model to quote them. */
export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    // Git stores a checkout token base64-encoded, alone or as x-access-token:<token>.
    const forms = [btoa(`x-access-token:${secret}`), btoa(secret), secret]
      .flatMap((f) => [f, f.replace(/=+$/, "")])
      .sort((a, b) => b.length - a.length); // Longest first, so a prefix form isn't half-replaced.
    for (const form of forms) out = out.split(form).join("[redacted]");
  }
  return out.replace(/\b(sk-ant-[\w-]{10,}|gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[redacted]");
}

const knownSecrets = () =>
  ["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AI_REVIEW_SLACK_WEBHOOK_URL"].flatMap(
    (k) => process.env[k] ?? [],
  );

/** Replies to and resolves the bot's earlier findings. The bot resolving a thread is what tells the gate it's done. */
export async function applyPriorUpdates(
  gh: Pick<GitHub, "reply" | "setResolved">,
  pr: number,
  prior: PriorFinding[],
  updates: PriorUpdate[],
  head: string,
) {
  for (const update of updates) {
    const finding = prior.find((p) => p.id === update.id);
    if (!finding) continue;
    if (update.status === "open") {
      // An author can't resolve their own finding away, so the thread is reopened to show it still counts.
      if (finding.resolvedByAuthor) await gh.setResolved(finding.threadId, false);
      if (update.reply) await gh.reply(pr, finding.commentId, redact(update.reply, knownSecrets()));
      continue;
    }
    const note = update.status === "fixed" ? `Fixed as of ${head.slice(0, 7)}.` : "Answered.";
    await gh.reply(pr, finding.commentId, redact(update.reply ? `${note} ${update.reply}` : note, knownSecrets()));
    if (finding.resolvedByAuthor) await gh.setResolved(finding.threadId, false);
    await gh.setResolved(finding.threadId, true);
  }
}

/** Sets the status on `sha`: the commit a run reviewed, so a push during the review can't inherit its result. */
export async function setGate(
  gh: Pick<GitHub, "getPull" | "listThreads" | "setStatus">,
  pr: number,
  sha: string,
  mode: Mode,
  botLogin: string,
  skipped?: string,
) {
  const pull = await gh.getPull(pr);
  const result = evaluateGate({ threads: await gh.listThreads(pr), botLogin, prAuthor: pull.user.login, mode });
  // A skipped review passes, unless findings from an earlier review are still open.
  const description = skipped && result.open === 0 ? skippedDescription(skipped) : result.description;
  await gh.setStatus(sha, result.state, description, runUrl());
  console.log(`ai-review status on ${sha.slice(0, 7)}: ${result.state} (${description})`);
}

async function skip(gh: GitHub, pr: number, sha: string, cfg: ReturnType<typeof config>, reason: string) {
  try {
    await setGate(gh, pr, sha, cfg.mode, cfg.botLogin, reason);
  } catch {
    await gh.setStatus(sha, "success", skippedDescription(reason), runUrl());
  }
  await gh.comment(pr, `**AI review skipped:** ${reason}. Review this PR as usual. ([run](${runUrl() ?? ""}))`);
  await alert(`AI review skipped on ${gh.repo}#${pr}: ${reason}. ${runUrl() ?? ""}`);
}

async function overBudget(gh: GitHub, pr: number, sha: string) {
  const description = "AI review ran out of its per-review budget. Split the PR, or ask an admin to bypass.";
  await gh.setStatus(sha, "failure", description, runUrl());
  await gh.comment(pr, `**AI review didn't finish:** ${description} ([run](${runUrl() ?? ""}))`);
  await alert(`AI review ran out of budget on ${gh.repo}#${pr}. ${runUrl() ?? ""}`);
}

async function ciReview() {
  const cfg = config();
  const gh = new GitHub(env("GITHUB_TOKEN"), env("GITHUB_REPOSITORY"), process.env.GITHUB_API_URL);
  const number = Number(env("AI_REVIEW_PR"));
  const pull = await gh.getPull(number);
  if (pull.state !== "open") return console.log("PR is closed; nothing to review.");
  if (pull.draft && process.env.AI_REVIEW_TRIGGER !== "manual") return console.log("Draft PR; no automatic review.");

  const sha = pull.head.sha;
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return await skip(gh, number, sha, cfg, "no Claude API credentials were available");
  }
  await gh.setStatus(sha, "pending", "AI review in progress", runUrl());
  // From here on, every path sets a final status, so the check never stays pending.
  try {
    const threads = await gh.listThreads(number);
    const prior = priorFromThreads(threads, cfg.botLogin, pull.user.login);
    const earlier = await gh.reviewBodiesFrom(number, cfg.botLogin);
    const firstReview = earlier.length === 0;

    let result: Awaited<ReturnType<typeof review>> | null = null;
    let failure: unknown = null;
    // One retry, on half the budget, so a failed run costs at most 1.5 times the budget.
    for (const budgetUsd of [cfg.budgetUsd, cfg.budgetUsd / 2]) {
      try {
        result = await review({
          repoDir: cfg.repoDir,
          baseSha: pull.base.sha,
          headSha: sha,
          title: pull.title,
          body: pull.body ?? "",
          context: await readFromBase(cfg.repoDir, pull.base.sha, cfg.contextFile),
          publicRepo: cfg.publicRepo,
          prior,
          skipIds: earlier.flatMap(summaryIds),
          extraDirs: cfg.extraDirs,
          model: cfg.model,
          budgetUsd,
          claude: runClaude,
        });
        break;
      } catch (error) {
        failure = error;
        console.error(`Review attempt failed: ${error instanceof Error ? error.message : error}`);
        if (error instanceof BudgetError) break; // Retrying a spent budget only spends more.
      }
    }

    if (!result) {
      const message = failure instanceof Error ? failure.message : String(failure);
      console.log(`::warning::AI review didn't finish: ${message}`);
      // A PR can run up its own review's budget on purpose, so in blocking mode that fails rather than passes.
      if (failure instanceof BudgetError && cfg.mode === "blocking") return await overBudget(gh, number, sha);
      const reason = /credit|billing|usage limit|spend limit/i.test(message)
        ? "spend limit reached"
        : failure instanceof BudgetError
          ? "the review hit its budget"
          : "the review could not run";
      return await skip(gh, number, sha, cfg, reason);
    }

    await applyPriorUpdates(gh, number, prior, result.prior, sha);
    if (firstReview || result.findings.length > 0) {
      const secrets = knownSecrets();
      const body = redact(
        formatSummary({ findings: result.findings, mode: cfg.mode, costUsd: result.costUsd }),
        secrets,
      );
      const comments = inlineComments(result.findings).map((c) => ({ ...c, body: redact(c.body, secrets) }));
      await gh.createReview(number, sha, body, comments);
    }
    console.log(`Posted ${result.findings.length} findings; cost $${result.costUsd.toFixed(2)}.`);
    await setGate(gh, number, sha, cfg.mode, cfg.botLogin);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    await skip(gh, number, sha, cfg, "posting the review failed");
    process.exitCode = 1;
  }
}

async function ciGate() {
  const cfg = config();
  const gh = new GitHub(env("GITHUB_TOKEN"), env("GITHUB_REPOSITORY"), process.env.GITHUB_API_URL);
  const number = Number(env("AI_REVIEW_PR"));
  const sha = (await gh.getPull(number)).head.sha;
  // Until a review run has set a status on this commit, or while one is running, the run's own result is the one
  // that counts. Recomputing here would let an unreviewed commit pass.
  const current = await gh.getStatus(sha);
  if (current === null || current === "pending") return console.log(`No finished review on ${sha.slice(0, 7)} yet.`);
  await setGate(gh, number, sha, cfg.mode, cfg.botLogin);
}

/**
 * Sets the status for a PR identified only by its head commit. Workflows on fork PRs get a read-only token, so a
 * follow-up workflow_run job calls this to give those PRs a status: the gate's, or a note that no review ran.
 */
async function ciGateForSha() {
  const cfg = config();
  const gh = new GitHub(env("GITHUB_TOKEN"), env("GITHUB_REPOSITORY"), process.env.GITHUB_API_URL);
  const sha = env("AI_REVIEW_SHA");
  const pulls = (await gh.listOpenPulls()).filter((p) => p.head.sha === sha);
  if (pulls.length === 0) return console.log(`No open PR has head ${sha.slice(0, 7)}.`);
  // A status belongs to the commit, so a fork PR pushing the same commit as a same-repo PR must not overwrite it.
  if (pulls.some((p) => p.head.repo?.full_name === gh.repo)) return console.log("A same-repo PR owns this commit.");
  if ((await gh.getStatus(sha)) === "pending") return console.log("A review is running; it sets the status.");

  const results = [];
  for (const pull of pulls) {
    const threads = await gh.listThreads(pull.number);
    if (threads.some((t) => t.author === cfg.botLogin && parseMarker(t.body))) {
      results.push(evaluateGate({ threads, botLogin: cfg.botLogin, prAuthor: pull.user.login, mode: cfg.mode }));
    }
  }
  if (results.length === 0) {
    const note = "AI review not run for an outside contributor. A maintainer can comment /ai-review.";
    return void (await gh.setStatus(sha, "success", note, runUrl()));
  }
  const worst = results.find((r) => r.state === "failure") ?? results[0];
  if (worst) await gh.setStatus(sha, worst.state, worst.description, runUrl());
}

async function sh(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`${args.join(" ")} failed`);
  return out.trim();
}

async function local(argv: string[]) {
  const cfg = config();
  const baseIndex = argv.indexOf("--base");
  const baseRef = baseIndex >= 0 ? (argv[baseIndex + 1] ?? "origin/main") : "origin/main";
  const repoDir = await sh(["git", "rev-parse", "--show-toplevel"], process.cwd());
  const head = await sh(["git", "rev-parse", "HEAD"], repoDir);
  const base = await sh(["git", "rev-parse", baseRef], repoDir);
  const subject = await sh(["git", "log", "-1", "--format=%s"], repoDir);
  const body = await sh(["git", "log", "-1", "--format=%b"], repoDir);
  if ((await sh(["git", "status", "--porcelain"], repoDir)) !== "") {
    console.error("Note: uncommitted changes aren't reviewed. Commit them first to include them.");
  }

  const result = await review({
    ...cfg,
    repoDir,
    baseSha: base,
    headSha: head,
    title: subject,
    body,
    context: await readFromBase(repoDir, base, cfg.contextFile),
    prior: [],
    skipIds: [],
    claude: runClaude,
  });

  const important = result.findings.filter((f) => f.severity === "important");
  for (const f of result.findings) {
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    console.log(`${f.severity === "important" ? "🔴 Important" : "🟡 Nit"} ${where} (${f.category})\n${f.message}\n`);
  }
  console.log(
    `${important.length} important, ${result.findings.length - important.length} nits. Cost $${result.costUsd.toFixed(2)}.`,
  );
  process.exitCode = important.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const run =
    command === "review"
      ? ciReview
      : command === "gate"
        ? ciGate
        : command === "gate-sha"
          ? ciGateForSha
          : command === "local"
            ? () => local(rest)
            : null;
  if (!run) {
    console.error("Usage: cli.ts review | gate | local [--base <ref>]");
    process.exit(2);
  }
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
