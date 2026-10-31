import { describe, expect, test } from "bun:test";
import { anchorFinding, parseDiff } from "../src/diff.ts";
import type { Finding } from "../src/findings.ts";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@ function a() {
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
 return x;
@@ -40,2 +41,3 @@ function b() {
 const p = 1;
+const q = 2;
 return p;
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-gone
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+one
+two
`;

const finding = (file: string, line?: number, startLine?: number): Finding => ({
  severity: "important",
  category: "bug",
  file,
  line,
  startLine,
  message: "m",
});

describe("parseDiff", () => {
  test("numbers context and added lines on the new side", () => {
    const diff = parseDiff(DIFF);
    expect([...(diff.get("src/a.ts")?.commentable ?? [])].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 41, 42, 43]);
  });

  test("skips deleted files and keeps new ones", () => {
    const diff = parseDiff(DIFF);
    expect(diff.has("old.ts")).toBe(false);
    expect([...(diff.get("new.ts")?.commentable ?? [])]).toEqual([1, 2]);
  });
});

describe("anchorFinding", () => {
  const diff = parseDiff(DIFF);

  test("keeps a line inside the diff", () => {
    expect(anchorFinding(diff, finding("src/a.ts", 12))).toEqual({ path: "src/a.ts", line: 12 });
  });

  test("moves a line just outside a hunk onto its nearest line", () => {
    expect(anchorFinding(diff, finding("src/a.ts", 16))).toEqual({ path: "src/a.ts", line: 13 });
  });

  test("moves a line far from any hunk onto the nearest changed line, so the gate can track it", () => {
    expect(anchorFinding(diff, finding("src/a.ts", 100))).toEqual({ path: "src/a.ts", line: 43 });
  });

  test("returns null for a file the PR didn't change", () => {
    expect(anchorFinding(diff, finding("src/other.ts", 3))).toBeNull();
  });

  test("anchors a finding without a line on the file's first changed line", () => {
    expect(anchorFinding(diff, finding("new.ts"))).toEqual({ path: "new.ts", line: 1 });
  });

  test("keeps a start line in the same hunk", () => {
    expect(anchorFinding(diff, finding("src/a.ts", 12, 11))).toEqual({ path: "src/a.ts", line: 12, startLine: 11 });
  });

  test("drops a start line from another hunk", () => {
    expect(anchorFinding(diff, finding("src/a.ts", 42, 11))).toEqual({ path: "src/a.ts", line: 42 });
  });
});
