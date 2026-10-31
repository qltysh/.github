import { describe, expect, test } from "bun:test";
import { marker } from "../src/findings.ts";
import { evaluateGate, type ReviewThread, skippedDescription } from "../src/gate.ts";

const BOT = "github-actions[bot]";
const AUTHOR = "author";

const thread = (overrides: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "T1",
  isResolved: false,
  resolvedBy: null,
  author: BOT,
  body: `finding\n${marker("important", "0123456789ab")}`,
  ...overrides,
});

const gate = (threads: ReviewThread[], mode: "advisory" | "blocking" = "blocking") =>
  evaluateGate({ threads, botLogin: BOT, prAuthor: AUTHOR, mode });

describe("evaluateGate", () => {
  test("passes with no threads", () => {
    expect(gate([])).toMatchObject({ state: "success", open: 0, description: "No open important findings" });
  });

  test("fails on an open important finding", () => {
    expect(gate([thread()])).toMatchObject({ state: "failure", open: 1 });
  });

  test("passes once the bot resolves the thread", () => {
    expect(gate([thread({ isResolved: true, resolvedBy: BOT })])).toMatchObject({ state: "success", open: 0 });
  });

  test("counts a reviewer's resolution as an override", () => {
    const result = gate([thread({ isResolved: true, resolvedBy: "reviewer" })]);
    expect(result).toMatchObject({ state: "success", open: 0, overridden: [{ thread: "T1", by: "reviewer" }] });
    expect(result.description).toBe("No open important findings, 1 overridden");
  });

  test("does not let the author override their own finding", () => {
    expect(gate([thread({ isResolved: true, resolvedBy: AUTHOR })])).toMatchObject({ state: "failure", open: 1 });
  });

  test("ignores nits, other bots, and people's threads", () => {
    const threads = [
      thread({ body: marker("nit", "0123456789ab") }),
      thread({ author: "copilot-pull-request-reviewer[bot]" }),
      thread({ author: "reviewer", body: "please rename" }),
    ];
    expect(gate(threads)).toMatchObject({ state: "success", open: 0 });
  });

  test("passes in advisory mode but reports open findings", () => {
    expect(gate([thread(), thread({ id: "T2" })], "advisory")).toMatchObject({
      state: "success",
      open: 2,
      description: "Advisory: 2 open important findings",
    });
  });
});

describe("skippedDescription", () => {
  test("fits GitHub's 140-character limit", () => {
    expect(skippedDescription("x".repeat(300)).length).toBe(140);
  });
});
