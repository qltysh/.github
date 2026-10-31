import { describe, expect, test } from "bun:test";
import {
  type AnchoredFinding,
  capNits,
  findingId,
  formatComment,
  formatSummary,
  marker,
  parseMarker,
  summaryIds,
} from "../src/findings.ts";

const anchored = (overrides: Partial<AnchoredFinding> = {}): AnchoredFinding => ({
  severity: "important",
  category: "bug",
  file: "src/a.ts",
  line: 12,
  message: "The cache key ignores the lockfile.",
  id: "0123456789ab",
  anchor: { path: "src/a.ts", line: 12 },
  ...overrides,
});

describe("markers", () => {
  test("round-trip", () => {
    expect(parseMarker(`text\n${marker("important", "0123456789ab")}`)).toEqual({
      severity: "important",
      id: "0123456789ab",
    });
  });

  test("ignore bodies without a marker", () => {
    expect(parseMarker("<!-- other-bot severity=important id=0123456789ab -->")).toBeNull();
  });

  test("ids are stable and depend on file, category and message", () => {
    const a = findingId({ file: "a.ts", category: "bug", message: "x" });
    expect(findingId({ file: "a.ts", category: "bug", message: "x " })).toBe(a);
    expect(findingId({ file: "b.ts", category: "bug", message: "x" })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("formatComment", () => {
  test("labels severity, quotes the rule, adds a suggestion and the marker", () => {
    const body = formatComment(anchored({ rule: "Use `test` not `it`", suggestion: "test(...)" }));
    expect(body).toStartWith("**🔴 Important** · bug");
    expect(body).toContain("> Use `test` not `it`");
    expect(body).toContain("```suggestion\ntest(...)\n```");
    expect(parseMarker(body)?.id).toBe("0123456789ab");
  });

  test("omits the suggestion when the finding isn't inline", () => {
    expect(formatComment(anchored({ suggestion: "x", anchor: null }))).not.toContain("```suggestion");
  });
});

describe("formatSummary", () => {
  test("says when nothing is important", () => {
    expect(formatSummary({ findings: [], mode: "blocking", costUsd: 0.4 })).toStartWith(
      "**AI review: no important findings in this change.**",
    );
  });

  test("counts inline findings, lists ones about unchanged files as not blocking, and collapses nits", () => {
    const summary = formatSummary({
      findings: [
        anchored(),
        anchored({
          id: "aaaaaaaaaaaa",
          anchor: null,
          file: "src/caller.ts",
          line: 5,
          message: "Caller passes old shape.",
        }),
        anchored({ id: "bbbbbbbbbbbb", severity: "nit", category: "clarity", message: "Rename `x`." }),
      ],
      mode: "blocking",
      costUsd: 0.5,
    });
    expect(summary).toContain("**AI review: 1 important finding** must be fixed, answered or overridden before merge.");
    expect(summary).toContain("About files this PR doesn't change. Worth a look; these don't block:");
    expect(summary).toContain("- 🔴 `src/caller.ts:5` · bug: Caller passes old shape.");
    expect(summary).toContain("<details><summary>Nits (optional)</summary>");
    expect(summary).toContain("Cost $0.50");
    expect(summaryIds(summary)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
  });
});

describe("capNits", () => {
  test("keeps every important finding and the first three nits", () => {
    const nit = (n: number) => anchored({ severity: "nit", message: `n${n}` });
    const kept = capNits([nit(1), anchored(), nit(2), nit(3), nit(4), anchored()]);
    expect(kept.map((f) => f.message)).toEqual([
      "n1",
      "The cache key ignores the lockfile.",
      "n2",
      "n3",
      "The cache key ignores the lockfile.",
    ]);
  });
});

describe("suggestions", () => {
  test("are left out when the anchor moved or lost its start line", () => {
    expect(formatComment(anchored({ suggestion: "x", anchor: { path: "src/a.ts", line: 13 } }))).not.toContain(
      "```suggestion",
    );
    expect(formatComment(anchored({ suggestion: "x", startLine: 10 }))).not.toContain("```suggestion");
  });
});
