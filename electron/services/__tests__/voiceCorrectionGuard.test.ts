import { describe, expect, it } from "vitest";
import {
  extractProtectedSpans,
  findProtectedRanges,
  validateCorrection,
} from "../voiceCorrectionGuard.js";

// How much slower a run on 4x the input is than on 1x. Linear work scales by
// about 4 and quadratic by about 16, whatever the runner's speed, so a ratio
// bound holds on a loaded CI machine where a wall-clock bound flakes.
function scalingRatio(run: (scale: number) => void): number {
  const fastest = (scale: number): number => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      run(scale);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };
  return fastest(4) / Math.max(fastest(1), 0.5);
}

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

  it("scans long unspaced text in linear time", () => {
    // A quadratic path scan took ~300ms here, on Electron's main thread.
    const ratio = scalingRatio((scale) => {
      const cjk = "我们需要更新这个组件并且不要删除分支然后运行测试。".repeat(120 * scale);
      expect(validateCorrection(cjk, `${cjk}。`)).toEqual({ ok: true });
    });
    expect(ratio).toBeLessThan(10);
  });

  it("trims a long run of closing brackets in linear time", () => {
    const ratio = scalingRatio((scale) => {
      const url = `https://example.com/a${")".repeat(3_000 * scale)}`;
      expect(extractProtectedSpans(url)).toEqual(["https://example.com/a"]);
    });
    expect(ratio).toBeLessThan(10);
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
    [
      "merged mishearings next to a negation",
      "there is no o auth support",
      "There is no OAuth support.",
    ],
    ["filler right after a negation", "do not like delete the branch", "Do not delete the branch."],
    ["phrase fillers", "um like you know fix it", "Fix it."],
    ["only hesitation sounds dropped", "um uh erm fix it", "Fix it."],
    [
      "two multi-word fixes in a short sentence",
      "cube netties and post gress",
      "Kubernetes and Postgres.",
    ],
    ["a three-word merge", "e s lint", "ESLint."],
    [
      "repeated merges beside a kept word",
      "type script type script type",
      "TypeScript TypeScript type.",
    ],
    ["a fully respelled term", "jay double you tee", "JWT."],
    ["a backticked span against Chinese text", "运行`npm test`", "运行`npm test`。"],
    [
      "a comma fixed after a path",
      "open src/foo.ts,then fix teh typo",
      "Open src/foo.ts, then fix the typo.",
    ],
    ["abbreviations and times", "run e.g. the tests at 9 a.m.", "Run, e.g., the tests at 9 a.m."],
    [
      "casing only, beside a word that could merge",
      "do not log in to the login page",
      "Do not log in to the login page.",
    ],
    [
      "spoken paragraph commands",
      "fix the parser new paragraph update the lexer new paragraph run the unit tests new paragraph check the build",
      "Fix the parser.\n\nUpdate the lexer.\n\nRun the unit tests.\n\nCheck the build.",
    ],
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
    [
      "a path moved into backticks",
      "open src/foo.ts please",
      "Open `src/foo.ts`, please.",
      "protected_span",
    ],
    ["a prefixed filename", "edit foo.ts", "Edit old.foo.ts.", "protected_span"],
    ["a suffixed path", "open src/foo.ts", "Open src/foo.ts?raw.", "protected_span"],
    ["a joined flag", "run --watch", "Run --watch+foo.", "protected_span"],
    ["an invented flag", "run npm test", "Run npm test --force.", "protected_span"],
    ["swapped paths", "copy src/a.ts to src/b.ts", "Copy src/b.ts to src/a.ts.", "protected_span"],
    ["a one-letter filename", "open a.ts please", "Open b.ts please.", "protected_span"],
    ["a recased dotfile", "open .env please", "Open .ENV please.", "protected_span"],
    ["a non-ASCII folder", "open 项目/foo.ts", "Open 其他/foo.ts.", "protected_span"],
    [
      "a URL's closing bracket",
      "see https://example.com/a_(b)",
      "See https://example.com/a_(b.",
      "protected_span",
    ],
    ["a flag's closing quote", "run --flag='ok'", "Run --flag='ok.", "protected_span"],
    ["a changed number", "wait 3000 ms", "Wait 300 ms.", "number"],
    ["a number inside an identifier", "use v5", "Use v6.", "number"],
    ["swapped identifiers", "use v10 and v20", "Use v20 and v10.", "number"],
    ["a changed spoken number", "retry three times", "Retry four times.", "number"],
    ["a changed Chinese numeral", "等三秒再运行", "等五秒再运行。", "number"],
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
      "a negation moved to another copy of the verb",
      "do not delete main and delete feature",
      "Delete main and do not delete feature.",
      "negation",
    ],
    [
      "a negation joined into another word",
      "make this change not able to delete files",
      "Make this change notable.",
      "negation",
    ],
    [
      "words added to a short command",
      "fix it",
      "Fix it and also rewrite authentication caching logging and deployment.",
      "edit_size",
    ],
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
