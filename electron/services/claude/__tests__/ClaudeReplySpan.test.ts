import { describe, expect, it } from "vitest";
import { findReplySpan } from "../ClaudeReplySpan.js";

const PARAGRAPH =
  "Clean copy now reads the **transcript** when the pane runs Claude Code, so `npm test` stays intact and paragraphs come back unwrapped.";

// The paragraph as Claude Code draws it in a 48-column pane: markers hidden,
// wrapped with real newlines under a two-column hanging indent.
const PARAGRAPH_DRAWN = [
  "⏺ Clean copy now reads the transcript when the",
  "  pane runs Claude Code, so npm test stays",
  "  intact and paragraphs come back unwrapped.",
].join("\n");

const STEPS = [
  "Steps:",
  "",
  "1. Run the **build**.",
  "2. Then the tests:",
  "",
  "```sh",
  "npm test -- src/foo.test.ts",
  "npm run lint",
  "```",
  "",
  "Done.",
].join("\n");

const STEPS_DRAWN = [
  "⏺ Steps:",
  "",
  "  1. Run the build.",
  "  2. Then the tests:",
  "",
  "  npm test -- src/foo.test.ts",
  "  npm run lint",
  "",
  "  Done.",
].join("\n");

describe("findReplySpan", () => {
  it("hands back a whole wrapped reply as it was written", () => {
    expect(findReplySpan(PARAGRAPH_DRAWN, [PARAGRAPH])).toBe(PARAGRAPH);
  });

  it("hands back the span a selection across a wrap covers, with its markers", () => {
    const selection = "transcript when the\n  pane runs Claude Code";

    expect(findReplySpan(selection, [PARAGRAPH])).toBe(
      "**transcript** when the pane runs Claude Code"
    );
  });

  it("finds the reply among older ones and ignores the line endings the selection used", () => {
    expect(
      findReplySpan(PARAGRAPH_DRAWN.replace(/\n/g, "\r\n"), ["Something newer.", PARAGRAPH])
    ).toBe(PARAGRAPH);
  });

  it("keeps list items, numbering and fences of a reply selected whole", () => {
    expect(findReplySpan(STEPS_DRAWN, [STEPS])).toBe(STEPS);
  });

  it("hands back code selected on its own without the fences around it", () => {
    const selection = "  npm test -- src/foo.test.ts\n  npm run lint";

    expect(findReplySpan(selection, [STEPS])).toBe("npm test -- src/foo.test.ts\nnpm run lint");
  });

  it("closes a fence the span leaves open partway through a code block", () => {
    const selection = "  2. Then the tests:\n\n  npm test -- src/foo.test.ts";

    expect(findReplySpan(selection, [STEPS])).toBe(
      "2. Then the tests:\n\n```sh\nnpm test -- src/foo.test.ts\n```"
    );
  });

  it("opens a fence for a span that starts on a block's first line and runs past it", () => {
    const selection = "  npm test -- src/foo.test.ts\n  npm run lint\n\n  Done.";

    expect(findReplySpan(selection, [STEPS])).toBe(
      "```sh\nnpm test -- src/foo.test.ts\nnpm run lint\n```\n\nDone."
    );
  });

  it("leaves a list marker off when the selection started after it", () => {
    expect(findReplySpan("Run the build.", [STEPS])).toBe("Run the **build**.");
    expect(findReplySpan("1. Run the build.", [STEPS])).toBe("1. Run the **build**.");
  });

  it("restores a heading's hashes and keeps a nested list's indent relative", () => {
    const reply = "## Release notes\n\n- Added a clean copy\n  - next to Copy\n- Fixed paste";
    const drawn = "⏺ Release notes\n\n  - Added a clean copy\n    - next to Copy\n  - Fixed paste";

    expect(findReplySpan(drawn, [reply])).toBe(reply);
    expect(findReplySpan("    - next to Copy\n  - Fixed paste", [reply])).toBe(
      "  - next to Copy\n- Fixed paste"
    );
  });

  it("keeps a visible mark the selection took, and leaves one it didn't", () => {
    const reply = "Most of it is written in C# today.";

    expect(findReplySpan("written in C# today", [reply])).toBe("written in C# today");
    expect(findReplySpan("written in C", [reply])).toBe("written in C");
  });

  it("leaves off a marker that would leave emphasis half open", () => {
    const reply = "She said **hello world** and left.";

    expect(findReplySpan("world", [reply])).toBe("world");
    expect(findReplySpan("hello", [reply])).toBe("hello");
    expect(findReplySpan("hello world", [reply])).toBe("**hello world**");
  });

  it("rejoins a token the TUI broke at the margin", () => {
    const reply = "Open https://example.com/a/very/long/path/to/the/page now.";
    const drawn = "⏺ Open https://example.com/a/very/long/path/to/\n  the/page now.";

    expect(findReplySpan(drawn, [reply])).toBe(reply);
  });

  it("keeps a table's pipes", () => {
    const reply = "| Name | Size |\n| --- | --- |\n| a.ts | 10 |";
    const drawn = "│ Name │ Size │\n├──────┼──────┤\n│ a.ts │ 10   │";

    expect(findReplySpan(drawn, [reply])).toBe(reply);
  });

  describe("falls back", () => {
    it("on tool output, which no reply holds", () => {
      expect(findReplySpan("⎿  Read 42 lines (ctrl+r to expand)", [PARAGRAPH, STEPS])).toBeNull();
    });

    it("on a selection that starts or ends partway through a word", () => {
      expect(findReplySpan("ranscript when the", [PARAGRAPH])).toBeNull();
      expect(findReplySpan("the pane runs Clau", [PARAGRAPH])).toBeNull();
      expect(findReplySpan("cript", ["see `transcript_id` here"])).toBeNull();
    });

    it("where the reply spaces or marks its words differently", () => {
      expect(findReplySpan("now here", ["It is nowhere to be seen."])).toBeNull();
      expect(findReplySpan("userid", ["Pass the user_id along."])).toBeNull();
      expect(findReplySpan("ab", ["| a | b |"])).toBeNull();
    });

    it("on nothing but whitespace and markers", () => {
      expect(findReplySpan("  ⏺  \n  ", [PARAGRAPH])).toBeNull();
    });

    it("when two replies hold the selection written differently", () => {
      expect(
        findReplySpan("run the tests", ["First run the tests.", "Then **run** the tests."])
      ).toBeNull();
    });

    it("but not when every place it could be reads the same", () => {
      expect(findReplySpan("run the tests", ["First run the tests.", "Then run the tests."])).toBe(
        "run the tests"
      );
    });

    it("when a list marker the selection took isn't one in the reply", () => {
      // "a. " opens the selection as a nested item would, but sits mid-sentence in the reply.
      expect(findReplySpan("a. The rest", ["Keep the data. The rest goes."])).toBeNull();
    });

    it("on a span left with emphasis open whichever way it is cut", () => {
      expect(findReplySpan("world and", ["She said **hello world** and left."])).toBeNull();
    });
  });
});
