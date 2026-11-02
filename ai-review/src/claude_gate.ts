// The ai-review status when Claude Code Review does the reviewing: its 🔴 Important threads gate the merge, the same
// way this engine's own findings do. Claude Code Review's check never fails on its own, so this is what blocks.

import { evaluateGate, isClaudeImportant, type ReviewThread, skippedDescription } from "./gate.ts";

/** GraphQL login of the app that posts Claude Code Review's findings. */
export const CLAUDE_BOT_LOGIN = "claude";
export const CLAUDE_CHECK_NAME = "Claude Code Review";

export type ClaudeCheckRun = { status: string; conclusion: string | null } | null;

export type ClaudeGateInput = {
  threads: ReviewThread[];
  prAuthor: string;
  mode: "advisory" | "blocking";
  /** Claude Code Review's latest check run on the PR's head commit. */
  checkRun: ClaudeCheckRun;
  /** Set when Claude Code Review said it skipped this PR, for example over its spend limit. */
  skippedReason?: string;
  /** The ai-review status already on the commit. */
  current?: { state: string; description: string } | null;
};

export type StatusUpdate = { state: "success" | "failure" | "pending"; description: string };

const SKIPPED_PREFIX = "AI review skipped";

/** Returns the status to set, or null to leave the current one alone. */
export function decideClaudeGate(input: ClaudeGateInput): StatusUpdate | null {
  const gate = evaluateGate({
    threads: input.threads,
    botLogin: CLAUDE_BOT_LOGIN,
    prAuthor: input.prAuthor,
    mode: input.mode,
    isImportant: isClaudeImportant,
  });
  // A review that didn't happen passes, unless findings from an earlier review are still open.
  const skipped = (reason: string): StatusUpdate =>
    gate.open > 0 ? gate : { state: "success", description: skippedDescription(reason) };

  const run = input.checkRun;
  if (!run) {
    if (input.skippedReason) return skipped(input.skippedReason);
    if (input.current?.description.startsWith(SKIPPED_PREFIX)) return null;
    // Without this, a commit could pass before its review starts.
    return {
      state: "pending",
      description: "Waiting for Claude Code Review. Comment @claude review if it doesn't start.",
    };
  }
  if (run.status !== "completed") return { state: "pending", description: "Claude Code Review is running" };
  if (run.conclusion === "neutral" || run.conclusion === "skipped" || run.conclusion === "success") return gate;
  return skipped("Claude Code Review didn't finish");
}

/** Claude Code Review comments on a PR when it skips a review, for example over its spend limit. */
export function claudeSkipReason(commentBody: string): string | undefined {
  if (/spend limit|usage credits|budget/i.test(commentBody)) return "Claude Code Review's spend limit was reached";
  if (/did(?:n't| not) run|skipped/i.test(commentBody)) return "Claude Code Review skipped this PR";
  return undefined;
}
