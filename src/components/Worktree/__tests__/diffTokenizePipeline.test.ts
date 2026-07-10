import { describe, expect, it } from "vitest";
import { markEdits, parseDiff, pickRanges, tokenize } from "react-diff-view";
import type { HunkData, TokenizeEnhancer } from "react-diff-view";
import { tokenizeFast } from "../diffTokenizePipeline";
import { refractorAdapter } from "../diffRefractor";
import { suppressFullLineEdits } from "../diffEditSuppression";
import { runDiffTokenize } from "../diffTokenizer";

// The fast pipeline exists purely for speed — its output must be
// indistinguishable from react-diff-view's tokenize for every shape the
// review workspace produces. Each case runs both implementations on the same
// hunks and requires deep equality.

function hunksOf(diffText: string): HunkData[] {
  return parseDiff(diffText)[0]!.hunks;
}

function expectParity(
  hunks: HunkData[],
  language: string,
  { highlight = true, enhancers = [] }: { highlight?: boolean; enhancers?: TokenizeEnhancer[] } = {}
): void {
  const fast = tokenizeFast(hunks, { highlight, refractor: refractorAdapter, language, enhancers });
  const lib = tokenize(hunks, { highlight, refractor: refractorAdapter, language, enhancers });
  expect(fast).toEqual(lib);
}

const TS_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,7 +1,7 @@
   const keep = setup();
-  const value = legacyCompute(1, { retries: 3 });
-  const label = \`old \${value} text\`;
+  const value = compute(1, { retries: 3, backoff: "expo" });
+  const label = \`new \${value} text\`;
   return aggregate(value);
   // trailing context
   done();
@@ -20,6 +20,7 @@
   before();
-\tconst tabbed = 1;
+\tconst tabbed = 2;
+  const added = onlyInsert();
   after();

   last();
`;

const UNEVEN_DIFF = `diff --git a/src/b.ts b/src/b.ts
index 1111111..2222222 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,6 +1,4 @@
   context();
-  removedOne();
-  removedTwo();
-  removedThree();
+  addedOne();
   tail();
@@ -30,3 +28,4 @@
   deep();
+  pureInsert();
   end();
`;

const MARKDOWN_DIFF = `diff --git a/docs/x.md b/docs/x.md
index 1111111..2222222 100644
--- a/docs/x.md
+++ b/docs/x.md
@@ -1,5 +1,5 @@
 # Title
-Some **bold** old text with \`code\`.
+Some **bold** new text with \`code\`.

 - item one
 - item two
`;

describe("tokenizeFast parity with react-diff-view tokenize", () => {
  it("matches on a typescript diff with markEdits + suppression", () => {
    const hunks = hunksOf(TS_DIFF);
    expectParity(hunks, "typescript", {
      enhancers: [markEdits(hunks, { type: "block" }), suppressFullLineEdits()],
    });
  });

  it("matches on uneven delete/insert blocks and insert-only hunks", () => {
    const hunks = hunksOf(UNEVEN_DIFF);
    expectParity(hunks, "typescript", {
      enhancers: [markEdits(hunks, { type: "block" }), suppressFullLineEdits()],
    });
  });

  it("matches with no enhancers (oversized-diff fallback path)", () => {
    expectParity(hunksOf(TS_DIFF), "typescript");
  });

  it("matches on a nested grammar (markdown)", () => {
    const hunks = hunksOf(MARKDOWN_DIFF);
    expectParity(hunks, "markdown", {
      enhancers: [markEdits(hunks, { type: "block" }), suppressFullLineEdits()],
    });
  });

  it("matches with highlighting disabled", () => {
    const hunks = hunksOf(TS_DIFF);
    expectParity(hunks, "typescript", {
      highlight: false,
      enhancers: [markEdits(hunks, { type: "block" }), suppressFullLineEdits()],
    });
  });

  it("matches with extra picked ranges", () => {
    const hunks = hunksOf(TS_DIFF);
    const ranges = [
      { type: "searchMark", lineNumber: 2, start: 8, length: 5 },
      { type: "searchMark", lineNumber: 5, start: 2, length: 9 },
    ];
    expectParity(hunks, "typescript", {
      enhancers: [
        markEdits(hunks, { type: "block" }),
        suppressFullLineEdits(),
        pickRanges(ranges, []),
      ],
    });
  });

  it("matches on empty hunks", () => {
    expectParity([], "typescript", { enhancers: [] });
  });

  it("matches on a hunk starting deep in the file", () => {
    const deepDiff = `diff --git a/src/deep.ts b/src/deep.ts
index 1111111..2222222 100644
--- a/src/deep.ts
+++ b/src/deep.ts
@@ -500,5 +500,6 @@
   deepContext();
-  const removed = legacy(1);
+  const added = fresh(1);
+  const extra = fresh(2);
   deepTail();
`;
    const hunks = hunksOf(deepDiff);
    expectParity(hunks, "typescript", {
      enhancers: [markEdits(hunks, { type: "block" }), suppressFullLineEdits()],
    });
  });

  it("matches on unicode content and CR-bearing lines", () => {
    const unicodeDiff = `diff --git a/src/u.ts b/src/u.ts
index 1111111..2222222 100644
--- a/src/u.ts
+++ b/src/u.ts
@@ -1,4 +1,4 @@
   const label = "héllo wörld";
-  const emoji = "🚀 déjà vu";\r
+  const emoji = "🎯 naïve café";\r
   const cjk = "漢字テスト";
`;
    const hunks = hunksOf(unicodeDiff);
    expectParity(hunks, "typescript", {
      enhancers: [markEdits(hunks, { type: "block" }), suppressFullLineEdits()],
    });
  });

  it("matches when the file has no trailing newline", () => {
    const noNewlineDiff = `diff --git a/src/n.ts b/src/n.ts
index 1111111..2222222 100644
--- a/src/n.ts
+++ b/src/n.ts
@@ -1,3 +1,3 @@
   before();
-  old();
+  fresh();
\\ No newline at end of file
`;
    const hunks = hunksOf(noNewlineDiff);
    expectParity(hunks, "typescript", {
      enhancers: [markEdits(hunks, { type: "block" }), suppressFullLineEdits()],
    });
  });
});

describe("runDiffTokenize intra-line edit strategy", () => {
  it("keeps block-edit output for large balanced, strongly paired changes", async () => {
    const lines = [
      "diff --git a/src/generated.ts b/src/generated.ts",
      "--- a/src/generated.ts",
      "+++ b/src/generated.ts",
      "@@ -1,14 +1,14 @@",
      "   before();",
      "   setup();",
      "   begin();",
    ];
    for (let i = 0; i < 8; i += 1) {
      lines.push(`-  const value_${i} = legacyCompute(${i}, { retries: 3 });`);
    }
    for (let i = 0; i < 8; i += 1) {
      lines.push(`+  const value_${i} = compute(${i}, { retries: 3, backoff: "expo" });`);
    }
    lines.push("   finish();", "   cleanup();", "   after();", "");
    const hunks = hunksOf(lines.join("\n"));

    const actual = await runDiffTokenize({
      hunks,
      language: "typescript",
      highlight: true,
      extraRanges: null,
    });
    const expected = tokenize(hunks, {
      highlight: true,
      refractor: refractorAdapter,
      language: "typescript",
      enhancers: [markEdits(hunks, { type: "block" }), suppressFullLineEdits()],
    });

    expect(actual.tokens).toEqual(expected);
  });

  it("falls back to block edits when balanced lines are not similar", async () => {
    const lines = [
      "diff --git a/src/unrelated.ts b/src/unrelated.ts",
      "--- a/src/unrelated.ts",
      "+++ b/src/unrelated.ts",
      "@@ -1,10 +1,10 @@",
      "   before();",
    ];
    for (let i = 0; i < 8; i += 1) lines.push(`-old_${i}_alpha_beta_gamma();`);
    for (let i = 0; i < 8; i += 1) lines.push(`+replacement_${i}_one_two_three();`);
    lines.push("   after();", "");
    const hunks = hunksOf(lines.join("\n"));

    const actual = await runDiffTokenize({
      hunks,
      language: "typescript",
      highlight: true,
      extraRanges: null,
    });
    const expected = tokenize(hunks, {
      highlight: true,
      refractor: refractorAdapter,
      language: "typescript",
      enhancers: [markEdits(hunks, { type: "block" }), suppressFullLineEdits()],
    });

    expect(actual.tokens).toEqual(expected);
  });
});
