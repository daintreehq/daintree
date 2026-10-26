import { describe, expect, it } from "vitest";
import {
  extractProtectedSpans,
  findProtectedRanges,
  validateCorrection,
} from "../voiceCorrectionGuard.js";

describe("extractProtectedSpans", () => {
  it("finds references, backticks, URLs, flags, paths and filenames", () => {
    const text =
      "check @src/App.tsx, run `npm test -- --run` with --watch and -v, read https://example.com/a?b=1 then open C:\\repo\\x and ./scripts/build.sh and package.json.";
    expect(extractProtectedSpans(text)).toEqual([
      "@src/App.tsx",
      "`npm test -- --run`",
      "--watch",
      "-v",
      "https://example.com/a?b=1",
      "C:\\repo\\x",
      "./scripts/build.sh",
      "package.json",
    ]);
  });

  it("keeps a symbol-only backtick span and a fenced block whole", () => {
    expect(extractProtectedSpans("use `=>` here\n```\nconst a = 1;\n```")).toEqual([
      "`=>`",
      "```\nconst a = 1;\n```",
    ]);
  });

  it("does not treat prose hyphens, dashes or abbreviations as spans", () => {
    expect(extractProtectedSpans("a well-known fix - e.g. the re-run step")).toEqual([]);
  });

  it("reports ranges that cover the whole span", () => {
    const text = "open daintree/src/index.ts now";
    const [range] = findProtectedRanges(text);
    expect(text.slice(range.start, range.end)).toBe("daintree/src/index.ts");
  });
});

describe("validateCorrection", () => {
  it.each([
    [
      "an ordinary cleanup",
      "um so we need to like update the racked component",
      "So we need to update the React component.",
    ],
    ["joined mishearings", "type script and post gress", "TypeScript and Postgres."],
    ["a fixed term in a short dictation", "cube netties pods", "Kubernetes pods."],
    ["a contraction change", "do not delete the branch", "Don't delete the branch."],
    ["an apostrophe fix", "dont delete it", "Don't delete it."],
    ["a path moved into backticks", "open src/foo.ts please", "Open `src/foo.ts`, please."],
    ["a span at the end of a sentence", "check @src/App.tsx", "Check @src/App.tsx."],
    ["an introduced term with a dot", "upgrade next jess", "Upgrade Next.js."],
    ["a cleanup in unspaced Chinese", "嗯我们需要更新这个组件", "我们需要更新这个组件。"],
  ])("accepts %s", (_label, raw, corrected) => {
    expect(validateCorrection(raw, corrected)).toEqual({ ok: true });
  });

  it.each([
    ["a recased path", "fix src/utils/foo.ts", "Fix src/Utils/foo.ts.", "protected_span"],
    ["an extended filename", "edit foo.ts", "Edit foo.tsx.", "protected_span"],
    ["a flag given a value", "run with --watch", "Run with --watch=false.", "protected_span"],
    ["a dropped @-reference", "see @a.ts and @b.ts", "See @a.ts.", "protected_span"],
    ["one of two identical spans", "copy `x` to `x`", "Copy `x` to it.", "protected_span"],
    ["an edited symbol-only span", "use `=>` here", "Use `->` here.", "protected_span"],
    ["a changed number", "wait 3000 ms", "Wait 300 ms.", "number"],
    ["a decimal turned into a fraction", "scale by 1.5", "Scale by 1/5.", "number"],
    ["a dropped sign", "offset of -5", "Offset of 5.", "number"],
    ["swapped numbers", "move 10 then 20", "Move 20 then 10.", "number"],
    ["a spoken number turned into digits", "retry three times", "Retry 3 times.", "number"],
    ["a dropped negation", "don't push yet", "Push yet.", "negation"],
    ["an added negation", "merge it now", "Don't merge it now.", "negation"],
    [
      "a negation moved to another verb",
      "do not start it and stop it",
      "Start it and do not stop it.",
      "negation",
    ],
    ["never turned into not", "never rebase main", "Do not rebase main.", "negation"],
    [
      "an answer instead of a cleanup",
      "can you explain how the auth flow works",
      "The auth flow issues a short-lived token at sign-in and refreshes it in the background.",
      "edit_size",
    ],
    [
      "a short command rewritten",
      "fix the login bug",
      "Refactor the authentication module.",
      "edit_size",
    ],
    [
      "dropped clauses in a longer passage",
      "update the parser and the lexer and the printer and the docs and the changelog",
      "Update the parser.",
      "edit_size",
    ],
  ])("rejects %s", (_label, raw, corrected, reason) => {
    expect(validateCorrection(raw, corrected)).toEqual({ ok: false, reason });
  });
});
