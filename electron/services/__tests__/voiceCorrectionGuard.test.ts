import { describe, expect, it } from "vitest";
import {
  extractProtectedSpans,
  findProtectedRanges,
} from "../../../shared/utils/voiceProtectedSpans.js";
import {
  CORRECTION_GUARD_LIMITS,
  validateCorrection,
  validateRewrite,
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

  it("holds removals and additions to their own budgets", () => {
    // 20 words, 7 dropped: over the floor of 4, inside 40%.
    const raw =
      "please check the logs and the traces and the metrics on the staging box then tell me what you see";
    const dropped = "Check the logs on the staging box, then tell me what you see.";
    expect(validateCorrection(raw, dropped)).toEqual({ ok: false, reason: "edit_size" });
    expect(
      validateCorrection(raw, dropped, { ...CORRECTION_GUARD_LIMITS, removedRatio: 0.4 })
    ).toEqual({ ok: true });
    // A looser removal budget doesn't let more words in: five over a budget of three.
    const added = `${raw} and restart the box twice`;
    expect(
      validateCorrection(raw, added, { ...CORRECTION_GUARD_LIMITS, removedRatio: 0.5 })
    ).toEqual({ ok: false, reason: "edit_size" });
  });

  describe("with spoken symbols", () => {
    const symbols = { ...CORRECTION_GUARD_LIMITS, spokenSymbols: true };
    const without = { ...CORRECTION_GUARD_LIMITS, spokenSymbols: false };
    // No budget at all, so any word left unaccounted for is an edit.
    const strict = { ...symbols, minRemoved: 0, removedRatio: 0, minAdded: 0, addedRatio: 0 };

    it("reads a typed symbol as the word it was spoken as", () => {
      const raw =
        "add a project underscore id column then run npm run db colon generate and open electron slash ipc slash handlers";
      const corrected =
        "Add a project_id column, then run npm run db:generate and open electron/ipc/handlers.";
      expect(validateCorrection(raw, corrected, without)).toEqual({
        ok: false,
        reason: "edit_size",
      });
      expect(validateCorrection(raw, corrected, symbols)).toEqual({ ok: true });
      expect(validateCorrection(raw, corrected, strict)).toEqual({ ok: true });
    });

    it("never takes a sentence's own full stop or colon for a spoken one", () => {
      expect(validateCorrection("open the readme dot md", "Open the readme.md.", strict)).toEqual({
        ok: true,
      });
      expect(validateCorrection("open the readme dot", "Open the readme.", strict)).toEqual({
        ok: false,
        reason: "edit_size",
      });
      expect(validateCorrection("two things colon tests", "Two things: tests.", strict)).toEqual({
        ok: false,
        reason: "edit_size",
      });
    });

    it("lets a flag the speaker spelled out appear, and no other", () => {
      const raw = "run npm test dash dash watch and dash v on the voice tests";
      expect(
        validateCorrection(raw, "Run npm test --watch and -v on the voice tests.", without)
      ).toEqual({ ok: false, reason: "protected_span" });
      expect(
        validateCorrection(raw, "Run npm test --watch and -v on the voice tests.", symbols)
      ).toEqual({ ok: true });
      expect(
        validateCorrection(
          "commit with dash dash no dash verify",
          "Commit with --no-verify.",
          symbols
        )
      ).toEqual({ ok: true });
      expect(
        validateCorrection(
          raw,
          "Run npm test --watch --coverage and -v on the voice tests.",
          symbols
        )
      ).toEqual({ ok: false, reason: "protected_span" });
      // A single dash takes a single letter.
      expect(validateCorrection("rerun it dash verbose", "Rerun it -verbose.", symbols)).toEqual({
        ok: false,
        reason: "protected_span",
      });
    });

    it("still holds a flag the raw text typed to its place", () => {
      const raw = "run --watch then dash dash run";
      expect(validateCorrection(raw, "Run --watch then --run.", symbols)).toEqual({ ok: true });
      expect(validateCorrection(raw, "Run --run then --watch.", symbols)).toEqual({
        ok: false,
        reason: "protected_span",
      });
      // The typed flag is the required one; the spelled one stays as words.
      for (const [said, cleaned] of [
        ["say dash dash watch then run --watch", "Say dash dash watch, then run --watch."],
        ["run dash dash watch then run --watch", "Run dash dash watch, then run --watch."],
      ]) {
        expect(validateCorrection(said, cleaned, symbols), said).toEqual({ ok: true });
      }
    });

    it("keeps a spelled flag beside a word it was spoken next to", () => {
      expect(
        validateCorrection(
          "run npm test dash dash force then publish the package",
          "Run npm test, then publish the package --force.",
          symbols
        )
      ).toEqual({ ok: false, reason: "protected_span" });
      // Its own words came along, but it sits by another command, with the
      // word before it or without the words after it.
      for (const [said, cleaned] of [
        ["commit with dash dash no dash verify then push", "Commit, then push with --no-verify."],
        ["commit then push dash dash no dash verify", "Commit --no-verify."],
      ]) {
        expect(validateCorrection(said, cleaned, symbols), said).toEqual({
          ok: false,
          reason: "protected_span",
        });
      }
      expect(
        validateCorrection(
          "commit dash dash no dash verify then push",
          "Commit, then push --no-verify.",
          symbols
        )
      ).toEqual({ ok: false, reason: "protected_span" });
      // Its neighbouring word comes again later: still not where it was said.
      expect(
        validateCorrection(
          "run npm test dash dash force then publish the package then stop",
          "Run npm test, then publish the package --force, then stop.",
          symbols
        )
      ).toEqual({ ok: false, reason: "protected_span" });
      // A symbol's name used as a word stays a word beside the flag.
      expect(validateCorrection("run dot dash V", "Run dot -V.", symbols)).toEqual({ ok: true });
      expect(validateCorrection("run dot dash V", "Run -V.", symbols)).toEqual({
        ok: false,
        reason: "protected_span",
      });
      // Spelled letters joined either side of it.
      expect(
        validateCorrection(
          "run N P M dash dash workspace A P I test",
          "Run npm --workspace api test.",
          symbols
        )
      ).toEqual({ ok: true });
      expect(
        validateCorrection(
          "run npm test dash dash watch dash dash verbose",
          "Run npm test --watch --verbose.",
          symbols
        )
      ).toEqual({ ok: true });
    });

    it("takes no flag from a spelling inside code", () => {
      expect(
        validateCorrection(
          "print `dash f` then publish the package",
          "Print `dash f` -f, then publish the package.",
          symbols
        )
      ).toEqual({ ok: false, reason: "protected_span" });
    });

    it("never frees a spoken symbol for one typed somewhere else", () => {
      for (const [said, cleaned] of [
        ["Don't dash. Deploy the follow up.", "Don't deploy the follow-up."],
        // The word after the hyphen comes earlier too.
        ["Don't dash. Commit the pre commit hook.", "Don't commit the pre-commit hook."],
      ]) {
        expect(validateCorrection(said, cleaned, symbols), said).toEqual({
          ok: false,
          reason: "negation",
        });
      }
      expect(
        validateCorrection(
          "open the readme dot md and the follow up notes",
          "Open the readme md and the follow up.notes.",
          strict
        )
      ).toEqual({ ok: false, reason: "edit_size" });
    });
  });

  it("gives a resolved self-correction its own floor for the rest", () => {
    const raw = "um so use the old api, no wait, the new one, and log the calls";
    const corrected = "Use the new one.";
    expect(validateCorrection(raw, corrected)).toEqual({ ok: false, reason: "edit_size" });
    expect(
      validateCorrection(raw, corrected, { ...CORRECTION_GUARD_LIMITS, minAllowanceRemoved: 4 })
    ).toEqual({ ok: true });
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
      "Check five things. First, the logs. Second, the traces. Third, the metrics. Fourth, the alerts. And finally, the dashboards.",
      "Check five things:\n- The logs.\n- The traces.\n- The metrics.\n- The alerts.\n- The dashboards.",
    ],
    [
      "a retraction with no repeated word, as long as its replacement",
      "Set the theme to dark blue mode, no wait, light mode.",
      "Set the theme to light mode.",
    ],
    [
      "a correction that ends its sentence",
      "Point the client at the old staging server, no wait. At the local one.",
      "Point the client at the local one.",
    ],
    [
      "a list counted in cardinals and ordinals",
      "One, add a test. Second, fix the bug.",
      "1. Add a test.\n2. Fix the bug.",
    ],
    [
      "a retraction after a line break",
      "Add a retry around the fetch call.\nScratch that. Add a timeout.",
      "Add a timeout.",
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
      "Push to the release branch and don't tag it, no wait, push to main.",
      "Push to main.",
      "negation",
    ],
    [
      "a negation left governing the replacement",
      "Do not delete backups, I mean switch to the new parser.",
      "Do not switch to the new parser.",
      "negation",
    ],
    [
      "a negation across a clause break",
      "Do not delete backups; use the old parser, I mean switch to the new parser for imports.",
      "Do not switch to the new parser for imports.",
      "negation",
    ],
    [
      "a no wait that is a real prohibition",
      "Ensure there is no wait, even under load.",
      "Ensure there is a wait, even under load.",
      "negation",
    ],
    [
      "a no wait prohibition dropped with the words before it",
      "Ensure there is no wait, even under load.",
      "Ensure delays, even under load.",
      "negation",
    ],
    [
      "a no wait prohibition dropped whole",
      "Ensure there is no wait, even under load.",
      "Ensure, even under load.",
      "negation",
    ],
    [
      "words added where the retracted ones were",
      "Keep the old cache, no wait, the new one.",
      "Keep and purge the new one.",
      "negation",
    ],
    [
      "the retracted words kept and the replacement dropped",
      "Use the old API, no wait, the new parser.",
      "Use the old API.",
      "negation",
    ],
    [
      "a retracted value whose replacement was dropped too",
      "Rename the theme to dark, no wait, light, and update the docs.",
      "Rename the theme, and update the docs.",
      "negation",
    ],
    [
      "a restart matched in an earlier clause",
      "Delete the logs, rebuild the cache, no wait, delete the temp files.",
      "Delete the temp files.",
      "edit_size",
    ],
    [
      "a fallback reaching past its replacement's length",
      "Keep backups and use the old parser, I mean switch to the new parser for imports.",
      "Switch to the new parser for imports.",
      "edit_size",
    ],
    [
      "a correction phrase with nothing after it",
      "Keep backups. Update the parser and run all tests, I mean.",
      "Keep backups.",
      "edit_size",
    ],
    [
      "a literal scratch that",
      "Keep the existing API and add a scratch that button.",
      "Keep the existing API.",
      "edit_size",
    ],
    [
      "a retraction reaching past twelve words",
      "Move the retry loop out of the request handler and into the shared client wrapper. Scratch that. Keep it.",
      "Keep it.",
      "edit_size",
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
      "First, add a test. Second, fix the bug.",
      "1. Add a test.\n3. Fix the bug.",
      "number",
    ],
    [
      "a decimal read as an item number",
      "Use timeout: 1.5 seconds. 2, retry twice.",
      "1. Use timeout: 5 seconds.\n2. Retry twice.",
      "number",
    ],
    [
      "a decimal's fraction read as an item number",
      "Timeout: 9.1, retries: 2.",
      "1. Timeout: 9.\n2. Retries.",
      "number",
    ],
    [
      "a counting word inside backticks funding another",
      "Use `status: one, ready` and set retries to one. Two, ship it.",
      "1. Use `status: one, ready` and set retries.\n2. Ship it.",
      "number",
    ],
    [
      "a dictated line number dropped as layout",
      "Return the value\n1. Preserve its type.",
      "Return the value. Preserve its type.",
      "number",
    ],
    [
      "ordinals that are adjectives",
      "First failures require logging. Second retries require approval. Third parties need authorization. Fourth attempts require escalation. Next releases require review.",
      "- Failures require logging.\n- Retries require approval.\n- Parties need authorization.\n- Attempts require escalation.\n- Releases require review.",
      "edit_size",
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
      // A target may carry a note on what it answers: `- Target: "…" (answering …)`.
      ...CORE_CORRECTION_PROMPT.matchAll(
        /- Target: "(.*?)"(?: \(.*\))?\n {2}Corrected: "(.*?)"(?: \(|$)/gm
      ),
    ];
    expect(examples.length).toBe(CORE_CORRECTION_PROMPT.match(/^- Target: /gm)?.length);
    for (const [, target, corrected] of examples) {
      expect(validateCorrection(unquote(target), unquote(corrected)), target).toEqual({ ok: true });
    }
  });

  it("resolves a passage of self-corrections up to the alignment limit", () => {
    const raw = "Use the old cache, no wait, the new one, and log it. ".repeat(40);
    const corrected = "Use the new one, and log it. ".repeat(40);
    expect(validateCorrection(raw, corrected)).toEqual({ ok: true });
  });

  // At 8x each input is 12,000 characters, the longest passage cleanup sees.
  it.each([
    [
      "self-corrections",
      (scale: number) => "Use the old cache, no wait, the new one, and log it. ".repeat(28 * scale),
      (scale: number) => "Use the new one, and log it. ".repeat(28 * scale),
      true,
    ],
    [
      "bullet lines",
      (scale: number) => "- a\n".repeat(375 * scale),
      (scale: number) => "- a\n".repeat(375 * scale - 1),
      true,
    ],
    [
      "whitespace runs",
      (scale: number) => `fix it, no${" ".repeat(1_500 * scale)}, sorry, now`,
      () => "Fix it now.",
      false,
    ],
    [
      "typed slashes after a space",
      () => "slash x",
      (scale: number) => `${"/".repeat(1_500 * scale)} x`,
      true,
    ],
    [
      "spoken slashes typed as one run",
      (scale: number) => `${"slash ".repeat(250 * scale)}x`,
      (scale: number) => `${"/".repeat(250 * scale)}x`,
      true,
    ],
    [
      "spoken dashes beside a typed one",
      (scale: number) => `${"dash ".repeat(300 * scale)}x`,
      (scale: number) => `${"dash ".repeat(300 * scale)}x y-z`,
      true,
    ],
    [
      "corrections that each scan back",
      (scale: number) => `${"x ".repeat(375 * scale)}${"I mean ".repeat(100 * scale)}a b c`,
      () => "a b c",
      false,
    ],
  ])("checks a passage of %s in linear time", (_label, raw, corrected, ok) => {
    expect(validateCorrection(raw(1), corrected(1)).ok).toBe(ok);
    const ratio = scalingRatio((scale) => {
      for (let i = 0; i < 10; i++) validateCorrection(raw(scale), corrected(scale));
    });
    expect(ratio).toBeLessThan(24);
  });
});

describe("validateRewrite", () => {
  const selection =
    "um so basically can you fix @src/App.tsx so `npm test` passes with --watch, there are 3 failing tests";

  it("accepts a rewrite that rewords freely but keeps every protected span in order", () => {
    expect(
      validateRewrite(
        selection,
        "1. Fix @src/App.tsx.\n2. Make `npm test` pass with --watch (three tests fail)."
      )
    ).toEqual({ ok: true });
  });

  it("accepts the shortening, numbering and negation changes cleanup would refuse", () => {
    const shorter = "Fix @src/App.tsx so `npm test` passes with --watch. Don't skip tests.";
    expect(validateCorrection(selection, shorter).ok).toBe(false);
    expect(validateRewrite(selection, shorter)).toEqual({ ok: true });
  });

  it("rejects a rewrite that drops, changes, reorders or invents a strict span", () => {
    const rejected = { ok: false, reason: "protected_span" };
    expect(validateRewrite(selection, "Fix the app so `npm test` passes with --watch.")).toEqual(
      rejected
    );
    expect(
      validateRewrite(selection, "Fix @src/app.tsx so `npm test` passes with --watch.")
    ).toEqual(rejected);
    expect(
      validateRewrite(selection, "With --watch, make `npm test` pass in @src/App.tsx.")
    ).toEqual(rejected);
    expect(
      validateRewrite(selection, "Fix @src/App.tsx so `npm test` passes with --watch --force.")
    ).toEqual(rejected);
  });

  it("rejects a rewrite that loses a path, but lets a new filename appear", () => {
    const withPath = "update docs/setup.md and mention the config";
    expect(validateRewrite(withPath, "Mention the config.")).toEqual({
      ok: false,
      reason: "protected_span",
    });
    expect(validateRewrite(withPath, "Update docs/setup.md to mention vite.config.ts.")).toEqual({
      ok: true,
    });
  });
});
