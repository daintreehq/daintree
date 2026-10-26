import { describe, expect, it } from "vitest";
import {
  extractProtectedSpans,
  findProtectedRanges,
  validateCorrection,
} from "../voiceCorrectionGuard.js";
import { CORE_CORRECTION_PROMPT } from "../../../shared/config/voiceCorrection.js";
import { DICTATED_PROMPTS } from "./fixtures/dictatedPrompts.js";

// How much slower a run on 8x the input is than on 1x. Linear work scales by
// about 8 and quadratic by about 64, whatever the runner's speed, so a ratio
// bound holds on a loaded CI machine where a wall-clock bound flakes. Each run
// must take whole milliseconds: a sub-millisecond one is all timer noise, and a
// single GC pause on a busy runner swings the ratio past any sensible bound.
function scalingRatio(run: (scale: number) => void): number {
  const fastest = (scale: number): number => {
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      run(scale);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };
  run(1);
  return fastest(8) / Math.max(fastest(1), 1);
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
    expect(ratio).toBeLessThan(24);
  });

  it("trims a long run of closing brackets in linear time", () => {
    const ratio = scalingRatio((scale) => {
      const url = `https://example.com/a${")".repeat(4_000 * scale)}`;
      let spans: string[] = [];
      // One trim is far under a millisecond; repeat it so the timing is real.
      for (let i = 0; i < 20; i++) spans = extractProtectedSpans(url);
      expect(spans).toEqual(["https://example.com/a"]);
    });
    expect(ratio).toBeLessThan(24);
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

describe("validateCorrection on self-corrections and lists", () => {
  it.each(
    DICTATED_PROMPTS.flatMap(({ name, raw, expected }) =>
      expected.map((corrected) => [name, raw, corrected] as const)
    )
  )("accepts the expected cleanup of the dictated prompt: %s", (_name, raw, corrected) => {
    expect(validateCorrection(raw, corrected)).toEqual({ ok: true });
  });

  it.each([
    [
      "a retraction that restarts a long phrase",
      "Point the client at the old staging server, no wait, at the local one.",
      "Point the client at the local one.",
    ],
    [
      "a retraction of the previous sentence",
      "Add a retry around the fetch call and log every attempt. Scratch that. Add a timeout.",
      "Add a timeout.",
    ],
    [
      "a retracted name with no repeated word",
      "Rename the helper to formatDate, I mean formatDateTime, and update every caller.",
      "Rename the helper to formatDateTime, and update every caller.",
    ],
    [
      "a retraction beside a negation it leaves alone",
      "Don't touch the old migration files, I mean the seed files, just regenerate them.",
      "Don't touch the seed files, just regenerate them.",
    ],
    [
      "a list counted with digits",
      "Two fixes. Step 1, pin the version. Step 2, rerun the install.",
      "Two fixes:\n1. Pin the version.\n2. Rerun the install.",
    ],
    [
      "a list laid out with bullets",
      "Check three things. First, the logs. Then, the traces. And finally, the metrics.",
      "Check three things:\n- The logs.\n- The traces.\n- The metrics.",
    ],
    [
      "list items that keep their own numbers",
      "First, retry 3 times. Second, wait 500 ms between tries.",
      "1. Retry 3 times.\n2. Wait 500 ms between tries.",
    ],
  ])("accepts %s", (_label, raw, corrected) => {
    expect(validateCorrection(raw, corrected)).toEqual({ ok: true });
  });

  it.each([
    [
      "a retraction used to drop earlier instructions",
      "Update the README with the install steps and bump the version and tag the release, I mean the changelog.",
      "The changelog.",
      "edit_size",
    ],
    [
      "a retraction that drops the verb before the retracted words",
      "Please check and then rebuild the useAuth hook, sorry, the useSession hook.",
      "The useSession hook.",
      "edit_size",
    ],
    [
      "a negation inside the retracted words",
      "Don't push to main, no wait, push to the release branch.",
      "Push to the release branch.",
      "negation",
    ],
    [
      "a number inside the retracted words",
      "Retry 3 times, no wait, 5 times.",
      "Retry 5 times.",
      "number",
    ],
    [
      "a literal no wait dropped",
      "Make sure there's no wait between the retries.",
      "Make sure there's between the retries.",
      "negation",
    ],
    [
      "a no that answers a question",
      "Do we need a migration? No, just update the model.",
      "Just update the model.",
      "negation",
    ],
    [
      "words before a marker inside backticks",
      "Delete the archived build logs from last week `no wait`, the fresh ones.",
      "Delete `no wait`, the fresh ones.",
      "edit_size",
    ],
    [
      "words before the restart of a repeated phrase",
      "Put the big blue submit button in the header, no wait, the footer.",
      "Put the footer.",
      "edit_size",
    ],
    [
      "a list that drops an item",
      "First, fix the parser. Second, update the docs and the changelog. Third, bump the version.",
      "1. Fix the parser.\n2. Bump the version.",
      "edit_size",
    ],
    [
      "list numbers that skip",
      "One, add a test. Two, fix the bug.",
      "1. Add a test.\n3. Fix the bug.",
      "number",
    ],
    [
      "a count turned into a list number",
      "Start one worker, then two more.",
      "1. Start one worker.\n2. Then more.",
      "number",
    ],
    [
      "counting words dropped without a list",
      "First, fix the parser. Second, update the docs. Third, bump the version. Fourth, tag it. Fifth, ship it.",
      "Fix the parser. Update the docs. Bump the version. Tag it. Ship it.",
      "edit_size",
    ],
  ])("rejects %s", (_label, raw, corrected, reason) => {
    expect(validateCorrection(raw, corrected)).toEqual({ ok: false, reason });
  });

  it("accepts every worked example the prompt teaches", () => {
    const unquote = (text: string) =>
      text
        .replace(/\\n/g, "\n")
        .replace(/<\/?uncertain>/g, "")
        .replace(/\\`/g, "`");
    const examples = [
      ...CORE_CORRECTION_PROMPT.matchAll(/- Target: "(.*)"\n {2}Corrected: "(.*?)"(?: \(|$)/gm),
    ];
    expect(examples.length).toBeGreaterThan(10);
    for (const [, target, corrected] of examples) {
      expect(validateCorrection(unquote(target), unquote(corrected)), target).toEqual({ ok: true });
    }
  });

  it("checks a long passage full of self-corrections quickly", () => {
    const sentence = "Use the old cache, no wait, the new one, and log it. ";
    const raw = sentence.repeat(220);
    const corrected = "Use the new one, and log it. ".repeat(220);
    const started = performance.now();
    validateCorrection(raw, corrected);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
