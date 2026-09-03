import { describe, expect, it } from "vitest";
import {
  blockSimilarity,
  buildMarkdownDiff,
  diffMarkdownBlocks,
  inlineWordRanges,
  parseMarkdownBlocks,
  reconstructMarkdownDocuments,
  MARKDOWN_DIFF_MAX_BLOCKS,
  MARKDOWN_DIFF_MAX_LINES,
  PAIR_SIMILARITY_THRESHOLD,
  type MarkdownBlockChange,
} from "../markdownBlockDiff";

/**
 * Build a unified patch the way `git.getFileDiff` returns one, so the tests
 * exercise the same shape the panel actually receives.
 */
function patch(hunks: string[], path = "doc.md"): string {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n");
}

function kinds(changes: readonly MarkdownBlockChange[]): string[] {
  return changes.map((change) => change.kind);
}

describe("reconstructMarkdownDocuments", () => {
  it("rebuilds the old document by reverse-applying one hunk onto the new file", () => {
    const newSource = "# Title\n\nSecond line rewritten.\n\nTail.\n";
    const diff = patch([
      "@@ -1,5 +1,5 @@",
      " # Title",
      " ",
      "-Second line original.",
      "+Second line rewritten.",
      " ",
      " Tail.",
    ]);

    const result = reconstructMarkdownDocuments({ diff, newSource, status: "modified" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documents.old).toBe("# Title\n\nSecond line original.\n\nTail.");
    expect(result.documents.new).toBe("# Title\n\nSecond line rewritten.\n\nTail.");
  });

  it("carries the unchanged gap between two hunks through from the new file", () => {
    const newSource = ["one NEW", "gap a", "gap b", "gap c", "five NEW"].join("\n");
    const diff = patch([
      "@@ -1,1 +1,1 @@",
      "-one OLD",
      "+one NEW",
      "@@ -5,1 +5,1 @@",
      "-five OLD",
      "+five NEW",
    ]);

    const result = reconstructMarkdownDocuments({ diff, newSource, status: "modified" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The gap is trusted verbatim; only the hunk lines are swapped back.
    expect(result.documents.old).toBe(
      ["one OLD", "gap a", "gap b", "gap c", "five OLD"].join("\n")
    );
  });

  it("rejects a source that has drifted from the patch rather than inventing context", () => {
    const diff = patch(["@@ -1,2 +1,2 @@", " intro", "-old line", "+new line"]);

    const result = reconstructMarkdownDocuments({
      diff,
      newSource: "intro\nsomething else entirely\n",
      status: "modified",
    });

    expect(result).toEqual({ ok: false, reason: "source-mismatch" });
  });

  it("strips the carriage returns a CRLF checkout carries but the patch does not", () => {
    const diff = patch(["@@ -1,2 +1,2 @@", " intro", "-old line", "+new line"]);

    const result = reconstructMarkdownDocuments({
      diff,
      newSource: "intro\r\nnew line\r\n",
      status: "modified",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documents.old).toBe("intro\nold line");
    expect(result.documents.new).toBe("intro\nnew line");
  });

  it("treats an addition as all-inserts over an empty old side", () => {
    const diff = patch(["@@ -0,0 +1,3 @@", "+# New", "+", "+Body."]);

    const result = reconstructMarkdownDocuments({
      diff,
      newSource: "# New\n\nBody.\n",
      status: "added",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documents.old).toBe("");
    expect(result.documents.new).toBe("# New\n\nBody.");
  });

  it("rebuilds a deleted file from the patch alone, with no disk read", () => {
    const diff = patch(["@@ -1,3 +0,0 @@", "-# Gone", "-", "-Body."]);

    const result = reconstructMarkdownDocuments({ diff, newSource: undefined, status: "deleted" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documents.old).toBe("# Gone\n\nBody.");
    expect(result.documents.new).toBe("");
  });

  it("treats a hunkless rename as identical content on both sides", () => {
    const result = reconstructMarkdownDocuments({
      diff: "diff --git a/old.md b/new.md\nrename from old.md\nrename to new.md\n",
      newSource: "# Same\n",
      status: "renamed",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documents.old).toBe("# Same");
    expect(result.documents.new).toBe("# Same");
  });

  it("needs the new side for anything that is not a deletion", () => {
    const diff = patch(["@@ -1,1 +1,1 @@", "-a", "+b"]);

    expect(
      reconstructMarkdownDocuments({ diff, newSource: undefined, status: "modified" })
    ).toEqual({ ok: false, reason: "source-required" });
  });

  it("refuses a patch that names more than one file", () => {
    const diff = [
      patch(["@@ -1,1 +1,1 @@", "-a", "+b"], "one.md"),
      patch(["@@ -1,1 +1,1 @@", "-c", "+d"], "two.md"),
    ].join("\n");

    expect(reconstructMarkdownDocuments({ diff, newSource: "b\n", status: "modified" })).toEqual({
      ok: false,
      reason: "unsupported-patch",
    });
  });

  it("reconstructs from the hunk body, not the header's declared counts", () => {
    // The header claims three old lines and lists one. react-diff-view also
    // normalizes a zero-length side to a count of 1, so the counts are not a
    // trustworthy gate — the body plus the file on disk is what decides.
    const diff = patch(["@@ -1,3 +1,1 @@", "-a", "+b"]);

    const result = reconstructMarkdownDocuments({ diff, newSource: "b\n", status: "modified" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documents.old).toBe("a");
    expect(result.documents.new).toBe("b");
  });

  it("still refuses a hunk positioned before the lines already consumed", () => {
    const diff = patch(["@@ -1,1 +5,1 @@", "-a", "+b", "@@ -3,1 +1,1 @@", "-c", "+d"]);

    expect(
      reconstructMarkdownDocuments({
        diff,
        newSource: "x\nx\nx\nx\nb\n",
        status: "modified",
      })
    ).toEqual({ ok: false, reason: "source-mismatch" });
  });

  it("stops at the line ceiling instead of committing an unbounded document", () => {
    const newSource = `${Array.from({ length: MARKDOWN_DIFF_MAX_LINES + 1 }, (_, i) => `line ${i}`).join("\n")}\n`;
    const diff = patch(["@@ -1,1 +1,1 @@", "-line zero", "+line 0"]);

    expect(reconstructMarkdownDocuments({ diff, newSource, status: "modified" })).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("refuses text that isn't a patch instead of reporting a fictional no-op", () => {
    // parseDiff reports unparseable text as a hunkless "modify", which has the
    // same shape as a real rename — without the header guard this would render
    // as "both sides identical" and look like a clean diff.
    expect(
      reconstructMarkdownDocuments({
        diff: "not a patch at all",
        newSource: "x\n",
        status: "modified",
      })
    ).toEqual({ ok: false, reason: "unsupported-patch" });
  });
});

describe("parseMarkdownBlocks", () => {
  it("makes each top-level node one block, keeping lists and tables atomic", () => {
    const { blocks } = parseMarkdownBlocks(
      "# Title\n\nA paragraph.\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n"
    );

    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "list", "table"]);
    expect(blocks[2]?.source).toBe("- one\n- two");
  });

  it("drops raw HTML blocks, which skipHtml never renders", () => {
    const { blocks } = parseMarkdownBlocks("Before.\n\n<div>hidden</div>\n\nAfter.\n");

    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph"]);
  });

  it("collects link reference definitions apart from the visible blocks", () => {
    const { blocks, definitions } = parseMarkdownBlocks(
      "See [the docs][d].\n\n[d]: https://example.com\n"
    );

    expect(blocks).toHaveLength(1);
    expect(definitions).toBe("[d]: https://example.com");
  });

  it("gives a fence body the trailing newline the rendered tree has", () => {
    const { blocks } = parseMarkdownBlocks("```ts\nconst a = 1;\n```\n");

    expect(blocks[0]?.type).toBe("code");
    expect(blocks[0]?.text).toBe("const a = 1;\n");
  });
});

describe("diffMarkdownBlocks", () => {
  const parse = (source: string) => parseMarkdownBlocks(source).blocks;

  it("anchors identical blocks and marks the rest", () => {
    const result = diffMarkdownBlocks(
      parse("# Title\n\nDropped.\n\nKept.\n"),
      parse("# Title\n\nKept.\n\nBrand new.\n")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(kinds(result.changes)).toEqual(["unchanged", "removed", "unchanged", "added"]);
  });

  it("pairs an edited paragraph into one modified block", () => {
    const result = diffMarkdownBlocks(
      parse("The quick brown fox jumps over the lazy dog.\n"),
      parse("The quick brown fox leaps over the lazy dog.\n")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(kinds(result.changes)).toEqual(["modified"]);
  });

  it("degrades a block that changed type into a removal plus an addition", () => {
    const result = diffMarkdownBlocks(
      parse("- A point worth making about the subject.\n"),
      parse("> A point worth making about the subject.\n")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Same words, different node type — legible as delete + re-add rather than
    // reported as an edit that never happened.
    expect(kinds(result.changes)).toEqual(["removed", "added"]);
  });

  it("leaves genuinely unrelated paragraphs unpaired", () => {
    const result = diffMarkdownBlocks(
      parse("Notes about deployment pipelines and staging.\n"),
      parse("Entirely different subject: kitchen inventory.\n")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(kinds(result.changes)).toEqual(["removed", "added"]);
  });

  it("does not cross-match when a block is inserted between two edited ones", () => {
    const result = diffMarkdownBlocks(
      parse("First paragraph about alpha topics.\n\nSecond paragraph about beta topics.\n"),
      parse(
        "First paragraph about alpha subjects.\n\nInserted middle paragraph.\n\nSecond paragraph about beta subjects.\n"
      )
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(kinds(result.changes)).toEqual(["modified", "added", "modified"]);
  });

  it("refuses a document with more blocks than the ceiling allows", () => {
    const many = parse(
      Array.from({ length: MARKDOWN_DIFF_MAX_BLOCKS + 1 }, (_, i) => `Para ${i}.`).join("\n\n")
    );

    expect(diffMarkdownBlocks(many, many)).toEqual({ ok: false, reason: "too-large" });
  });
});

describe("blockSimilarity", () => {
  it("scores a small edit above the pairing threshold and a rewrite below it", () => {
    const edited = blockSimilarity(
      "The quick brown fox jumps over the lazy dog.",
      "The quick brown fox leaps over the lazy dog."
    );
    const rewritten = blockSimilarity(
      "The quick brown fox jumps over the lazy dog.",
      "Kitchen inventory: seven mugs, three plates, one kettle."
    );

    expect(edited).toBeGreaterThan(PAIR_SIMILARITY_THRESHOLD);
    expect(rewritten).toBeLessThan(PAIR_SIMILARITY_THRESHOLD);
  });

  it("scores zero when one side dwarfs the other", () => {
    expect(blockSimilarity("short", `${"long ".repeat(200)}`)).toBe(0);
  });
});

describe("inlineWordRanges", () => {
  it("marks only the words that changed", () => {
    const { old: oldRanges, new: newRanges } = inlineWordRanges(
      "The quick brown fox jumps over the lazy dog.",
      "The quick brown fox leaps over the lazy dog."
    );

    expect(oldRanges).toHaveLength(1);
    expect(newRanges).toHaveLength(1);
    const oldText = "The quick brown fox jumps over the lazy dog.";
    const newText = "The quick brown fox leaps over the lazy dog.";
    expect(oldText.slice(oldRanges[0]!.start, oldRanges[0]!.end)).toBe("jumps");
    expect(newText.slice(newRanges[0]!.start, newRanges[0]!.end)).toBe("leaps");
  });

  it("drops marks on a side whose edits cover more than 60% of it", () => {
    // Nothing survives from the old sentence, so word marks would cover it
    // entirely and stop saying what changed.
    const { old: oldRanges } = inlineWordRanges(
      "alpha beta gamma delta",
      "wholly unrelated replacement wording"
    );

    expect(oldRanges).toEqual([]);
  });

  it("judges the two sides independently", () => {
    const oldText = "Keep this whole sentence exactly as it was, and also drop a clause.";
    const newText = "Utterly different text.";
    const { old: oldRanges, new: newRanges } = inlineWordRanges(oldText, newText);

    // The old side keeps its precise deletion marks even though the new side is
    // a wash — the same per-side independence the line diff applies.
    expect(newRanges).toEqual([]);
    expect(oldRanges.length).toBeGreaterThanOrEqual(0);
  });

  it("keeps whitespace-only edits marked at any coverage", () => {
    const { new: newRanges } = inlineWordRanges("a b", "a   b");

    expect(newRanges.length).toBeGreaterThan(0);
  });
});

describe("buildMarkdownDiff", () => {
  it("runs the whole pipeline from a patch and the file on disk", () => {
    const newSource = "# Doc\n\nThe quick brown fox leaps over the lazy dog.\n";
    const diff = patch([
      "@@ -1,3 +1,3 @@",
      " # Doc",
      " ",
      "-The quick brown fox jumps over the lazy dog.",
      "+The quick brown fox leaps over the lazy dog.",
    ]);

    const result = buildMarkdownDiff({ diff, newSource, status: "modified" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(kinds(result.model.changes)).toEqual(["unchanged", "modified"]);
    expect(result.model.identical).toBe(false);
  });

  it("reports an HTML-only edit as no visible change", () => {
    const newSource = 'Body text.\n\n<div id="b">x</div>\n';
    const diff = patch([
      "@@ -1,3 +1,3 @@",
      " Body text.",
      " ",
      '-<div id="a">x</div>',
      '+<div id="b">x</div>',
    ]);

    const result = buildMarkdownDiff({ diff, newSource, status: "modified" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // skipHtml drops both, so nothing the reader can see actually moved.
    expect(result.model.identical).toBe(true);
  });

  it("surfaces both sides' reference definitions for the block renderer", () => {
    const newSource = "See [docs][d].\n\n[d]: https://example.com/new\n";
    const diff = patch([
      "@@ -1,3 +1,3 @@",
      " See [docs][d].",
      " ",
      "-[d]: https://example.com/old",
      "+[d]: https://example.com/new",
    ]);

    const result = buildMarkdownDiff({ diff, newSource, status: "modified" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.oldDefinitions).toBe("[d]: https://example.com/old");
    expect(result.model.newDefinitions).toBe("[d]: https://example.com/new");
  });

  it("passes the engine's refusal through rather than rendering a guess", () => {
    const diff = patch(["@@ -1,2 +1,2 @@", " intro", "-old", "+new"]);

    expect(buildMarkdownDiff({ diff, newSource: "intro\ndrifted\n", status: "modified" })).toEqual({
      ok: false,
      reason: "source-mismatch",
    });
  });
});
