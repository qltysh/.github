import { describe, expect, test } from "bun:test";
import { CLAUDE_BOT_LOGIN, claudeSkipReason, decideClaudeGate } from "../src/claude_gate.ts";
import type { ReviewThread } from "../src/gate.ts";

const thread = (overrides: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "T1",
  isResolved: false,
  resolvedBy: null,
  author: CLAUDE_BOT_LOGIN,
  body: "🔴 The lockfile check misses Pipfile.lock.",
  ...overrides,
});

const done = { status: "completed", conclusion: "neutral" };
const decide = (overrides: Partial<Parameters<typeof decideClaudeGate>[0]> = {}) =>
  decideClaudeGate({ threads: [], prAuthor: "author", mode: "blocking", checkRun: done, ...overrides });

describe("decideClaudeGate", () => {
  test("passes a finished review with no open important findings", () => {
    expect(decide()).toMatchObject({ state: "success", description: "No open important findings" });
  });

  test("fails on an open 🔴 finding, and ignores nits and pre-existing bugs", () => {
    const threads = [thread(), thread({ body: "🟡 (optional) rename" }), thread({ body: "🟣 pre-existing: ..." })];
    expect(decide({ threads })).toMatchObject({ state: "failure", open: 1 });
  });

  test("counts Claude or a reviewer resolving the thread, but not the author", () => {
    expect(decide({ threads: [thread({ isResolved: true, resolvedBy: CLAUDE_BOT_LOGIN })] })).toMatchObject({
      state: "success",
    });
    expect(decide({ threads: [thread({ isResolved: true, resolvedBy: "reviewer" })] })).toMatchObject({
      state: "success",
      overridden: [{ by: "reviewer" }],
    });
    expect(decide({ threads: [thread({ isResolved: true, resolvedBy: "author" })] })).toMatchObject({
      state: "failure",
    });
  });

  test("waits while the review hasn't started or is running", () => {
    expect(decide({ checkRun: null })).toMatchObject({ state: "pending" });
    expect(decide({ checkRun: { status: "in_progress", conclusion: null } })).toMatchObject({ state: "pending" });
  });

  test("passes when Claude Code Review skipped the PR, unless earlier findings are open", () => {
    expect(decide({ checkRun: null, skippedReason: "spend limit" })).toEqual({
      state: "success",
      description: "AI review skipped: spend limit",
    });
    expect(decide({ checkRun: null, skippedReason: "spend limit", threads: [thread()] })).toMatchObject({
      state: "failure",
    });
  });

  test("keeps an earlier skipped status instead of going back to waiting", () => {
    expect(decide({ checkRun: null, current: { state: "success", description: "AI review skipped: x" } })).toBeNull();
  });

  test("passes when the review failed or timed out, unless earlier findings are open", () => {
    const failed = { status: "completed", conclusion: "timed_out" };
    expect(decide({ checkRun: failed })).toMatchObject({ state: "success" });
    expect(decide({ checkRun: failed, threads: [thread()] })).toMatchObject({ state: "failure" });
  });

  test("never blocks in advisory mode", () => {
    expect(decide({ mode: "advisory", threads: [thread()] })).toMatchObject({ state: "success", open: 1 });
  });
});

describe("claudeSkipReason", () => {
  test("recognizes a spend-limit comment and ignores ordinary ones", () => {
    expect(claudeSkipReason("Code Review didn't run: your organization reached its spend limit.")).toBe(
      "Claude Code Review's spend limit was reached",
    );
    expect(claudeSkipReason("Looks good to me")).toBeUndefined();
  });
});
