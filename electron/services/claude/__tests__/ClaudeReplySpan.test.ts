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

  it("takes back the marks the selection carries at either end", () => {
    expect(findReplySpan("#tag rest", ["see #tag rest"])).toBe("#tag rest");
    expect(findReplySpan("use C#", ["I use C# daily"])).toBe("use C#");
  });

  it("never widens over a mark the TUI draws but the selection left out", () => {
    expect(findReplySpan("C", ["C#"])).toBe("C");
    expect(findReplySpan("tag", ["#tag"])).toBe("tag");
  });

  it("leaves off a marker that would leave emphasis half open", () => {
    const reply = "She said **hello world** and left.";

    expect(findReplySpan("world", [reply])).toBe("world");
    expect(findReplySpan("hello", [reply])).toBe("hello");
    expect(findReplySpan("hello world", [reply])).toBe("**hello world**");
  });

  it("pairs delimiters by run, so nested and mismatched emphasis come back right", () => {
    expect(findReplySpan("⏺ Use bold and italic now.", ["Use **bold *and italic*** now."])).toBe(
      "Use **bold *and italic*** now."
    );
    // `**` and `*` don't pair, so the TUI draws both and the selection took neither.
    expect(findReplySpan("hello", ["**hello*"])).toBe("hello");
    expect(findReplySpan("b c", ["*a **b** c*"])).toBe("**b** c");
  });

  it("keeps a star the TUI drew beside a pair it hid", () => {
    expect(findReplySpan("hello*", ["**hello***"])).toBe("**hello***");
    expect(findReplySpan("Use hello* now.", ["Use **hello*** now."])).toBe("Use **hello*** now.");
  });

  it("reads emphasis after a code span that crossed a line", () => {
    expect(findReplySpan("⏺ Use a\n  b then c done.", ["Use `a\nb` then **c** done."])).toBe(
      "Use `a\nb` then **c** done."
    );
  });

  it("matches a tab in code however many spaces the TUI drew it as", () => {
    expect(findReplySpan("  a     *\n  b", ["```text\na\t*\nb\n```"])).toBe("a\t*\nb");
  });

  it("follows a code span or a hard break across lines", () => {
    expect(findReplySpan("b", ["Use `a\n*b*\nc` now."])).toBe("b");
    expect(findReplySpan("⏺ Run\n  now.", ["Run\\\nnow."])).toBe("Run\\\nnow.");
  });

  it("does the same for single-character emphasis", () => {
    const reply = "She said *hello world* and left.";

    expect(findReplySpan("world", [reply])).toBe("world");
    expect(findReplySpan("hello world", [reply])).toBe("*hello world*");
  });

  it("matches what the TUI draws inside a code span and of an escape", () => {
    expect(findReplySpan("Use a*b now.", ["Use `a*b` now."])).toBe("Use `a*b` now.");
    expect(findReplySpan("Use *x* now.", ["Use \\*x\\* now."])).toBe("Use \\*x\\* now.");
  });

  it("keeps a quote's marks only when the selection took them", () => {
    expect(findReplySpan("> Quoted line", ["> Quoted line here."])).toBe("> Quoted line");
    expect(findReplySpan("tag", ["> tag"])).toBe("tag");
  });

  it("hands back code whose lines the TUI drew a fence-like line among", () => {
    expect(
      findReplySpan("  before\n  ```literal\n  after", [
        "````text\nbefore\n```literal\nafter\n````",
      ])
    ).toBe("before\n```literal\nafter");
  });

  it("removes only the indent every selected line shares", () => {
    expect(findReplySpan("    - a\n    - b", ["- top\n  - a\n  - b"])).toBe("- a\n- b");
  });

  it("keeps code's indentation when the span starts partway through a line", () => {
    expect(findReplySpan("ready:\n      run()", ["```py\nif ready:\n    run()\n```"])).toBe(
      "ready:\n    run()"
    );
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
      expect(findReplySpan("transcript", ["see `transcript_id` here"])).toBeNull();
      expect(findReplySpan("id", ["see `transcript_id` here"])).toBeNull();
      // A decomposed é: the combining accent belongs to the word.
      expect(findReplySpan("clair", ["e\u0301clair"])).toBeNull();
    });

    it("on a selection that leaves out a line, prefix or mark the code has", () => {
      // A blank line where the reply has a line of marks, so only the marks can tell them apart.
      expect(findReplySpan("before\n\n  after", ["```text\nbefore\n---\nafter\n```"])).toBeNull();
      expect(findReplySpan("before\n\n  after", ["```text\nbefore\n-\nafter\n```"])).toBeNull();
      expect(
        findReplySpan("before\n  literal\n  after", ["````text\nbefore\n```literal\nafter\n````"])
      ).toBeNull();
      expect(findReplySpan("before\n  after", ["```text\nbefore\n+ after\n```"])).toBeNull();
      expect(findReplySpan("before\n  after", ["```text\nbefore\n│ after\n```"])).toBeNull();
      expect(
        findReplySpan("before\n  ---\n  after", ["```text\nbefore\n- - -\nafter\n```"])
      ).toBeNull();
      expect(findReplySpan("a b", ["```text\na  b\n```"])).toBeNull();
      expect(findReplySpan("a b", ["```text\na\nb\n```"])).toBeNull();
      expect(findReplySpan("a *b", ["```text\na* b\n```"])).toBeNull();
      expect(findReplySpan("a│b", ["```text\nab\n```"])).toBeNull();
    });

    it("on code indented differently from the reply", () => {
      const reply = "```py\nif ready:\n    run()\n```";

      expect(findReplySpan("  if ready:\n  run()", [reply])).toBeNull();
      expect(findReplySpan("  if ready:\n        run()", [reply])).toBeNull();
    });

    it("on a code line entered from prose with a different prefix", () => {
      expect(findReplySpan("Intro\n  - after", ["Intro\n```text\n+ after\n```"])).toBeNull();
    });

    it("on emphasis that only pairs across a change of quote", () => {
      expect(findReplySpan("Start a\n> b end", ["Start *a\n> b* end"])).toBeNull();
    });

    it("on a code line whose prefix the selection took but whose head differs", () => {
      expect(findReplySpan("> tag", ["```text\n> #tag\n```"])).toBeNull();
      expect(findReplySpan("- tag", ["```text\n- #tag\n```"])).toBeNull();
    });

    it("on a code line skipped going into or out of a block", () => {
      expect(findReplySpan("Intro\n  after", ["Intro\n```text\n-\nafter\n```"])).toBeNull();
      expect(findReplySpan("  before\n  Outro", ["```text\nbefore\n-\n```\nOutro"])).toBeNull();
    });

    it("on code wrapped at the margin with its whitespace moved", () => {
      expect(findReplySpan("  a *\n  b", ["```text\na* b\n```"])).toBeNull();
    });

    it("on tab-indented code, whose shift can't be pinned down", () => {
      expect(
        findReplySpan("  if ready:\n  run()", ["```py\n\tif ready:\n\t\trun()\n```"])
      ).toBeNull();
    });

    it("on whole lines selected beyond what matched", () => {
      expect(findReplySpan("  before\n  │", ["```text\nbefore\n│\n```"])).toBeNull();
      expect(findReplySpan("---\n  after", ["```text\nafter\n```"])).toBeNull();
      expect(findReplySpan("after\n---", ["```text\nafter\n```"])).toBeNull();
    });

    it("on a selection that leaves out what the TUI draws in prose", () => {
      expect(
        findReplySpan("written in C today", ["Most of it is written in C# today."])
      ).toBeNull();
      expect(findReplySpan("Use ab now.", ["Use `a*b` now."])).toBeNull();
      expect(findReplySpan("Use x now.", ["Use \\*x\\* now."])).toBeNull();
    });

    it("on a list item the reply doesn't have", () => {
      expect(findReplySpan("Keep\n  - delete", ["Keep delete"])).toBeNull();
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

    it("when the reply holds it twice, written differently", () => {
      expect(
        findReplySpan("run the tests", ["First run the tests, then **run** the tests."])
      ).toBeNull();
    });

    it("when a list marker or quote the selection took isn't one in the reply", () => {
      // "a. " opens the selection as a nested item would, but sits mid-sentence in the reply.
      expect(findReplySpan("a. The rest", ["1. Keep the data. The rest goes."])).toBeNull();
      expect(findReplySpan("- The rest", ["The rest goes."])).toBeNull();
      expect(findReplySpan("> Quoted line", ["Quoted line here."])).toBeNull();
      expect(findReplySpan("> tag", ["> #tag"])).toBeNull();
    });

    it("on a span left with emphasis open whichever way it is cut", () => {
      expect(findReplySpan("world and", ["She said **hello world** and left."])).toBeNull();
      expect(findReplySpan("world and", ["She said *hello world* and left."])).toBeNull();
    });
  });
});
