import { describe, expect, it } from "vitest";
import {
  blockSimilarity,
  buildMarkdownDiff,
  diffMarkdownBlocks,
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

/** A deletion the way git emits one — the metadata is what marks it a deletion. */
function deletionPatch(hunks: string[], path = "doc.md"): string {
  return [
    `diff --git a/${path} b/${path}`,
    "deleted file mode 100644",
    `--- a/${path}`,
    "+++ /dev/null",
    ...hunks,
  ].join("\n");
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
    expect(result.documents.old).toBe("# Title\n\nSecond line original.\n\nTail.\n");
    expect(result.documents.new).toBe("# Title\n\nSecond line rewritten.\n\nTail.\n");
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
    expect(result.documents.old).toBe("intro\nold line\n");
    expect(result.documents.new).toBe("intro\nnew line\n");
  });

  it("treats an addition as all-inserts over an empty old side", () => {
    // Built exactly the way WorkspaceService's added/untracked path builds it —
    // `content.split("\n").map(l => "+" + l)` — so a newline-terminated file
    // contributes a final `+` with nothing after it. Reconstructing against a
    // line array that had dropped that element failed every added file.
    const newSource = "# New\n\nBody.\n";
    const lines = newSource.split("\n");
    const diff = patch([`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)]);

    const result = reconstructMarkdownDocuments({ diff, newSource, status: "added" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documents.old).toBe("");
    expect(result.documents.new).toBe(newSource);
  });

  it("reconstructs an added file whose checkout is CRLF", () => {
    const newSource = "# New\r\n\r\nBody.\r\n";
    const lines = newSource.split("\n");
    const diff = patch([`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)]);

    const result = reconstructMarkdownDocuments({ diff, newSource, status: "added" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documents.new).toBe("# New\n\nBody.\n");
  });

  it("refuses a partial deletion presented as a deleted file", () => {
    // Contiguous from line 1, but it keeps a context line — accepting it would
    // show "# Kept" as deleted prose when the patch says it survives.
    const diff = deletionPatch(["@@ -1,2 +1,1 @@", " # Kept", "-Removed"]);

    expect(reconstructMarkdownDocuments({ diff, newSource: undefined, status: "deleted" })).toEqual(
      { ok: false, reason: "unsupported-patch" }
    );
  });

  it("refuses a zero-context head deletion the patch doesn't call a deletion", () => {
    // Same hunk shape as a whole-file removal, but the metadata says the file
    // survives — a panel holding a stale "deleted" status must not be enough.
    const diff = patch(["@@ -1,2 +0,0 @@", "-a", "-b"]);

    expect(reconstructMarkdownDocuments({ diff, newSource: undefined, status: "deleted" })).toEqual(
      { ok: false, reason: "unsupported-patch" }
    );
  });

  it("rebuilds a deleted file from the patch alone, with no disk read", () => {
    const diff = deletionPatch(["@@ -1,3 +0,0 @@", "-# Gone", "-", "-Body."]);

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
    expect(result.documents.old).toBe("# Same\n");
    expect(result.documents.new).toBe("# Same\n");
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

  it("refuses a hunk whose real header counts disagree with its body", () => {
    // Claims three old lines and lists one. Accepting it would let the next
    // hunk land at an offset nothing checked.
    const diff = patch(["@@ -1,3 +1,1 @@", "-a", "+b"]);

    expect(reconstructMarkdownDocuments({ diff, newSource: "b\n", status: "modified" })).toEqual({
      ok: false,
      reason: "source-mismatch",
    });
  });

  it("refuses declared new-side ranges that overlap", () => {
    // Each body is internally consistent, but the two hunks claim overlapping
    // new-side spans — the second starts inside the first.
    const diff = patch(["@@ -1,3 +1,3 @@", "-a", "+b", "@@ -2,1 +2,1 @@", "-c", "+d"]);

    expect(reconstructMarkdownDocuments({ diff, newSource: "b\nd\n", status: "modified" })).toEqual(
      { ok: false, reason: "source-mismatch" }
    );
  });

  it("places a zero-length new side after the line its header names", () => {
    // Under `diff.context=0` a pure deletion reads `@@ -2,1 +1,0 @@`: the new
    // side names the line BEFORE the removal, not the first line of it.
    const diff = patch(["@@ -2,1 +1,0 @@", "-old"]);

    const result = reconstructMarkdownDocuments({ diff, newSource: "keep\n", status: "modified" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documents.old).toBe("keep\nold\n");
    expect(result.documents.new).toBe("keep\n");
  });

  it("reconstructs a modified file emptied to nothing", () => {
    const diff = patch(["@@ -1,2 +0,0 @@", "-one", "-two"]);

    const result = reconstructMarkdownDocuments({ diff, newSource: "", status: "modified" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documents.old).toBe("one\ntwo\n");
    expect(result.documents.new).toBe("");
  });

  it("reconstructs an added file that is empty", () => {
    // `"".split("\n")` is `[""]`, so the producer emits one empty insert.
    const diff = patch(["@@ -0,0 +1,1 @@", "+"]);

    const result = reconstructMarkdownDocuments({ diff, newSource: "", status: "added" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documents.old).toBe("");
    expect(result.documents.new).toBe("");
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

  it("collects footnote definitions with the link definitions, not as blocks", () => {
    // A footnote definition rendered as its own block produces nothing visible,
    // and the paragraph citing it would render a literal `[^1]`.
    const { blocks, definitions } = parseMarkdownBlocks("Text[^1].\n\n[^1]: The note.\n");

    expect(blocks.map((block) => block.type)).toEqual(["paragraph"]);
    expect(definitions).toBe("[^1]: The note.");
  });

  it("records which definition each block resolves through", () => {
    // remark only produces a linkReference when the definition resolves;
    // without it the brackets are literal text.
    const { blocks, definitionsById } = parseMarkdownBlocks(
      "Plain text.\n\nSee [docs][d].\n\n[d]: https://example.com\n"
    );

    expect(blocks.map((block) => block.referenceIds)).toEqual([[], ["d"]]);
    expect(definitionsById.get("d")).toBe("[d]: https://example.com");
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

  it("reports a definition-only change as a change to the block that resolves it", () => {
    // The paragraph's source is byte-identical on both sides, but the image it
    // renders is a different file — reporting "no rendered content changes"
    // here would be actively wrong.
    const newSource = "![diagram][d]\n\n[d]: https://example.com/new.png\n";
    const diff = patch([
      "@@ -1,3 +1,3 @@",
      " ![diagram][d]",
      " ",
      "-[d]: https://example.com/old.png",
      "+[d]: https://example.com/new.png",
    ]);

    const result = buildMarkdownDiff({ diff, newSource, status: "modified" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.identical).toBe(false);
    expect(kinds(result.model.changes)).toEqual(["modified"]);
  });

  it("leaves blocks alone when the definition that moved is unreferenced", () => {
    const newSource = "Plain paragraph.\n\n[unused]: https://example.com/new\n";
    const diff = patch([
      "@@ -1,3 +1,3 @@",
      " Plain paragraph.",
      " ",
      "-[unused]: https://example.com/old",
      "+[unused]: https://example.com/new",
    ]);

    const result = buildMarkdownDiff({ diff, newSource, status: "modified" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.identical).toBe(true);
  });

  it("only touches the blocks citing the definition that moved", () => {
    // A wholesale comparison of the document's definitions would mark the
    // `[keep]` paragraph as edited too, purely because a sibling moved.
    const newSource =
      "Uses [keep][keep].\n\nUses [moved][moved].\n\n[keep]: /same\n[moved]: /new\n";
    const diff = patch([
      "@@ -1,6 +1,6 @@",
      " Uses [keep][keep].",
      " ",
      " Uses [moved][moved].",
      " ",
      " [keep]: /same",
      "-[moved]: /old",
      "+[moved]: /new",
    ]);

    const result = buildMarkdownDiff({ diff, newSource, status: "modified" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(kinds(result.model.changes)).toEqual(["unchanged", "modified"]);
  });

  it("catches a definition being removed outright", () => {
    // The new side parses `[docs][d]` as literal text with no reference at all,
    // so testing only the new block would miss the case that changed most.
    const newSource = "See [docs][d].\n";
    const diff = patch(["@@ -1,3 +1,1 @@", " See [docs][d].", "-", "-[d]: https://example.com"]);

    const result = buildMarkdownDiff({ diff, newSource, status: "modified" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.identical).toBe(false);
  });

  it("passes the engine's refusal through rather than rendering a guess", () => {
    const diff = patch(["@@ -1,2 +1,2 @@", " intro", "-old", "+new"]);

    expect(buildMarkdownDiff({ diff, newSource: "intro\ndrifted\n", status: "modified" })).toEqual({
      ok: false,
      reason: "source-mismatch",
    });
  });
});
