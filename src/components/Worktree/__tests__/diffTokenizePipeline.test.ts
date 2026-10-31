import { deserialize, serialize } from "node:v8";
import { beforeAll, describe, expect, it } from "vitest";
import {
  computeNewLineNumber,
  computeOldLineNumber,
  isDelete,
  isInsert,
  markEdits,
  parseDiff,
  pickRanges,
  tokenize,
} from "react-diff-view";
import type { HunkData, HunkTokens, TokenizeEnhancer } from "react-diff-view";
import { tokenizeFast } from "../diffTokenizePipeline";
import { ensureLanguage, refractorAdapter } from "../diffRefractor";
import { suppressFullLineEdits } from "../diffEditSuppression";
import { runDiffTokenize } from "../diffTokenizer";

// The fast pipeline exists purely for speed — every line the review workspace
// renders must get exactly the tokens react-diff-view's tokenize gives it. The
// library also fills every other absolute line with an empty entry; the fast
// pipeline leaves those as holes, which is the whole point, so parity is
// graded on the lines a change actually looks up, plus "nothing else".

function hunksOf(diffText: string): HunkData[] {
  return parseDiff(diffText)[0]!.hunks;
}

/** The slots react-diff-view reads: old for normal/delete, new for normal/insert. */
function renderedSlots(hunks: HunkData[]): { old: Set<number>; new: Set<number> } {
  const old = new Set<number>();
  const now = new Set<number>();
  for (const change of hunks.flatMap((hunk) => hunk.changes)) {
    if (!isInsert(change)) old.add(computeOldLineNumber(change) - 1);
    if (!isDelete(change)) now.add(computeNewLineNumber(change) - 1);
  }
  return { old, new: now };
}

function expectRenderedParity(fast: HunkTokens, lib: HunkTokens, hunks: HunkData[]): void {
  const rendered = renderedSlots(hunks);
  for (const side of ["old", "new"] as const) {
    expect(fast[side].length).toBe(lib[side].length);
    for (const at of rendered[side]) {
      expect(fast[side][at], `${side} line ${at + 1}`).toEqual(lib[side][at]);
    }
    const carried = Object.keys(fast[side]).map(Number);
    expect(carried.filter((at) => !rendered[side].has(at))).toEqual([]);
  }
}

function expectParity(
  hunks: HunkData[],
  language: string,
  { highlight = true, enhancers = [] }: { highlight?: boolean; enhancers?: TokenizeEnhancer[] } = {}
): void {
  const fast = tokenizeFast(hunks, { highlight, refractor: refractorAdapter, language, enhancers });
  const lib = tokenize(hunks, { highlight, refractor: refractorAdapter, language, enhancers });
  expectRenderedParity(fast, lib, hunks);
}

function editEnhancers(hunks: HunkData[]): TokenizeEnhancer[] {
  return [markEdits(hunks, { type: "block" }), suppressFullLineEdits()];
}

/**
 * Two context-only hunks: `head` from line `headAt` and `tail` from line
 * `tailAt`, on both sides. The library lexes every line above and between them
 * as an empty line; the fast pipeline collapses those runs.
 */
function twoHunkDiff(head: string[], tail: string[], headAt: number, tailAt: number): string {
  const hunk = (at: number, lines: string[]) => [
    `@@ -${at},${lines.length} +${at},${lines.length} @@`,
    ...lines.map((line) => ` ${line}`),
  ];
  return [
    "diff --git a/f b/f",
    "--- a/f",
    "+++ b/f",
    ...hunk(headAt, head),
    ...hunk(tailAt, tail),
    "",
  ].join("\n");
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

/** A one-pair hunk at `at`: three context lines, one delete, one insert, one context. */
function deepDiff(at: number): string {
  return [
    "diff --git a/src/deep.ts b/src/deep.ts",
    "--- a/src/deep.ts",
    "+++ b/src/deep.ts",
    `@@ -${at},5 +${at},5 @@`,
    "   const ctx_0 = resolve(0);",
    "   const ctx_1 = resolve(1);",
    "   const ctx_2 = resolve(2);",
    "-  const value = legacyCompute(1, { retries: 3 });",
    '+  const value = compute(1, { retries: 3, backoff: "expo" });',
    "   return aggregate(value);",
    "",
  ].join("\n");
}

// Constructs that carry lexer state from one hunk into the next, so the run of
// blank lines between them is inside a token. Each must lex the second hunk the
// same whether the gap is one line or hundreds.
const GAP_CASES: ReadonlyArray<{
  name: string;
  language: string;
  head: string[];
  tail: string[];
}> = [
  {
    name: "a block comment",
    language: "typescript",
    head: ["const a = 1;", "/* opened here"],
    tail: ["closed here */", "const b = 2;"],
  },
  {
    name: "a template literal",
    language: "typescript",
    head: ["const t = `start ${a}"],
    tail: ["end ${b}`;", "return t;"],
  },
  {
    name: "a JSX element",
    language: "tsx",
    head: ["return (", "  <div className=\"x\">"],
    tail: ["  </div>", ");"],
  },
  {
    name: "a fenced code block",
    language: "markdown",
    head: ["# Title", "", "```ts"],
    tail: ["const x = 1;", "```", "after **bold** text"],
  },
  {
    name: "an indented code block after blank lines",
    language: "markdown",
    head: ["Paragraph text", "- item"],
    tail: ["    indented code", "", "> quote"],
  },
  {
    name: "a docstring",
    language: "python",
    head: ["def f():", '    """Doc opened'],
    tail: ['    still doc"""', "    return 1"],
  },
  {
    name: "a block scalar",
    language: "yaml",
    head: ["key: |", "  text line"],
    tail: ["  more text", "other: 1"],
  },
  {
    name: "a heredoc",
    language: "bash",
    head: ["cat <<EOF", "body $HOME"],
    tail: ["EOF", "echo done"],
  },
  {
    name: "a markup comment",
    language: "markup",
    head: ["<div>", "<!-- opened"],
    tail: ["closed -->", "</div>"],
  },
  {
    name: "a css comment",
    language: "css",
    head: [".a { color: red; }", "/* opened"],
    tail: ["closed */", ".b { margin: 0; }"],
  },
];

describe("tokenizeFast across gaps between hunks", () => {
  beforeAll(async () => {
    await Promise.all(GAP_CASES.map((c) => ensureLanguage(c.language)));
  });

  for (const c of GAP_CASES) {
    it(`lexes ${c.name} (${c.language}) the same however far apart the hunks are`, () => {
      // Gaps at, just over, and far over the collapse bound, after a hunk at
      // the top of the file and after one that has a leading gap of its own.
      for (const headAt of [1, 2, 8, 9, 10, 300]) {
        for (const gap of [0, 1, 2, 7, 8, 9, 10, 400]) {
          const hunks = hunksOf(twoHunkDiff(c.head, c.tail, headAt, headAt + c.head.length + gap));
          expectParity(hunks, c.language);
        }
      }
    });
  }

  it("keeps edit marks and picked ranges on the right lines past a gap", () => {
    const head = hunksOf(TS_DIFF);
    const hunks = [...head, ...hunksOf(deepDiff(900))];
    expectParity(hunks, "typescript", {
      enhancers: [
        ...editEnhancers(hunks),
        pickRanges(
          [{ type: "searchMark", lineNumber: 903, start: 8, length: 5 }],
          [{ type: "searchMark", lineNumber: 904, start: 2, length: 9 }]
        ),
      ],
    });
  });
});

describe("tokenizeFast malformed hunks", () => {
  it("drops lines past an unordered last hunk, as the library does", () => {
    const hunks = [...hunksOf(deepDiff(50)), ...hunksOf(deepDiff(10))];
    expectParity(hunks, "typescript", { enhancers: editEnhancers(hunks) });
    const fast = tokenizeFast(hunks, {
      highlight: true,
      refractor: refractorAdapter,
      language: "typescript",
      enhancers: editEnhancers(hunks),
    });
    expect(fast.new.length).toBe(14);
    expect(fast.new[50]).toBeUndefined();
  });

  it("lets a later hunk win a line two hunks both claim, as the library does", () => {
    const hunks = [...hunksOf(deepDiff(10)), ...hunksOf(deepDiff(12))];
    expectParity(hunks, "typescript", { enhancers: editEnhancers(hunks) });
  });

  it("still turns a last line number that is not a valid length into a null pass", async () => {
    for (const bad of [Number.NaN, -1, 2.5, 2 ** 32]) {
      const hunks = hunksOf(deepDiff(10));
      const last = hunks[0]!.changes[hunks[0]!.changes.length - 1]! as { newLineNumber: number };
      last.newLineNumber = bad;
      const options = { highlight: true, refractor: refractorAdapter, language: "typescript" };
      expect(() => tokenizeFast(hunks, options), String(bad)).toThrow(RangeError);
      const result = await runDiffTokenize({
        hunks,
        language: "typescript",
        highlight: true,
        extraRanges: null,
      });
      expect(result.tokens, String(bad)).toBeNull();
    }
  });

  it("treats a missing last line number as a side with no lines in range", () => {
    const hunks = hunksOf(deepDiff(10));
    const last = hunks[0]!.changes[hunks[0]!.changes.length - 1]! as { newLineNumber?: number };
    delete last.newLineNumber;
    const tokens = tokenizeFast(hunks, {
      highlight: true,
      refractor: refractorAdapter,
      language: "typescript",
    });
    expect(tokens.new.length).toBe(1);
    expect(Object.keys(tokens.new)).toEqual([]);
    expect(Object.keys(tokens.old).length).toBe(5);
  });
});

describe("tokenizeFast result size", () => {
  const tokensAt = (at: number): HunkTokens => {
    const hunks = hunksOf(deepDiff(at));
    return tokenizeFast(hunks, {
      highlight: true,
      refractor: refractorAdapter,
      language: "typescript",
      enhancers: editEnhancers(hunks),
    });
  };

  it("holds only the lines the hunk renders, wherever it sits", () => {
    for (const at of [1, 100, 20_000]) {
      const hunks = hunksOf(deepDiff(at));
      const tokens = tokensAt(at);
      const rendered = renderedSlots(hunks);
      for (const side of ["old", "new"] as const) {
        expect(tokens[side].length).toBe(at + 4);
        expect(Object.keys(tokens[side]).map(Number)).toEqual(
          [...rendered[side]].sort((a, b) => a - b)
        );
      }
    }
  });

  it("clones to the same size at line 100,000 as at line 100, holes intact", () => {
    const near = serialize(tokensAt(100));
    const deepTokens = tokensAt(100_000);
    const deep = serialize(deepTokens);
    // Only the varint widths of the larger indices differ.
    expect(deep.byteLength).toBeLessThan(near.byteLength * 1.1);

    const received = deserialize(deep) as HunkTokens;
    const rendered = renderedSlots(hunksOf(deepDiff(100_000)));
    for (const side of ["old", "new"] as const) {
      expect(received[side].length).toBe(deepTokens[side].length);
      expect(Object.keys(received[side])).toEqual(Object.keys(deepTokens[side]));
      for (const at of rendered[side]) expect(received[side][at]).toEqual(deepTokens[side][at]);
    }
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
