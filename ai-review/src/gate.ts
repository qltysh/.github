// Whether a PR's open findings block the merge, decided from the review threads the bot started.

import { parseMarker } from "./findings.ts";

export type ReviewThread = {
  id: string;
  isResolved: boolean;
  resolvedBy: string | null;
  /** Author and body of the thread's first comment. */
  author: string;
  body: string;
};

export type GateInput = {
  threads: ReviewThread[];
  botLogin: string;
  prAuthor: string;
  mode: "advisory" | "blocking";
};

export type GateResult = {
  state: "success" | "failure";
  open: number;
  overridden: { thread: string; by: string }[];
  description: string;
};

/**
 * An important finding stays open until the bot resolves its thread (fixed or answered) or a person other than the
 * PR author resolves it (an override). An author resolving their own finding doesn't count.
 */
export function evaluateGate({ threads, botLogin, prAuthor, mode }: GateInput): GateResult {
  let open = 0;
  const overridden: GateResult["overridden"] = [];

  for (const thread of threads) {
    if (thread.author !== botLogin) continue;
    if (parseMarker(thread.body)?.severity !== "important") continue;
    if (!thread.isResolved || !thread.resolvedBy || thread.resolvedBy === prAuthor) {
      open++;
    } else if (thread.resolvedBy !== botLogin) {
      overridden.push({ thread: thread.id, by: thread.resolvedBy });
    }
  }

  const findings = `${open} open important finding${open === 1 ? "" : "s"}`;
  const overrides = overridden.length > 0 ? `, ${overridden.length} overridden` : "";
  if (open === 0) return { state: "success", open, overridden, description: `No open important findings${overrides}` };
  if (mode === "advisory")
    return { state: "success", open, overridden, description: `Advisory: ${findings}${overrides}` };
  return { state: "failure", open, overridden, description: `${findings}: fix, answer, or ask a reviewer to override` };
}

/** Statuses GitHub shows for a review that didn't run. They pass, so a missing review never strands a PR. */
export function skippedDescription(reason: string): string {
  return `AI review skipped: ${reason}`.slice(0, 140);
}
