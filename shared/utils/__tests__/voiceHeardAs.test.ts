import { describe, expect, it } from "vitest";
import type { VoiceDictionaryEntry } from "../../types/ipc/api.js";
import { MAX_HEARD_AS_RULES, collectHeardAsRules, createHeardAsRewriter } from "../voiceHeardAs.js";

function entry(term: string, heardAs: string[] = []): VoiceDictionaryEntry {
  return { term, heardAs, source: "manual", addedAt: 0 };
}

function rewriterFor(...entries: VoiceDictionaryEntry[]) {
  return createHeardAsRewriter(collectHeardAsRules(entries));
}

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

describe("collectHeardAsRules", () => {
  it("pairs each heard form with its term, oldest entry first", () => {
    expect(
      collectHeardAsRules([entry("Zustand", ["zoo stand"]), entry("pnpm", ["p n p m", "pin pin"])])
    ).toEqual([
      { heard: "zoo stand", term: "Zustand" },
      { heard: "p n p m", term: "pnpm" },
      { heard: "pin pin", term: "pnpm" },
    ]);
  });

  it("gives a heard form claimed twice to the first entry", () => {
    expect(collectHeardAsRules([entry("Vite", ["veet"]), entry("Veet", ["VEET", "veat"])])).toEqual(
      [
        { heard: "veet", term: "Vite" },
        { heard: "veat", term: "Veet" },
      ]
    );
  });

  it("collapses spacing and drops forms with no letters or digits", () => {
    expect(collectHeardAsRules([entry("Zustand", ["  zoo   stand ", "--", "  "])])).toEqual([
      { heard: "zoo stand", term: "Zustand" },
    ]);
  });

  it("leaves out forms too long to add and terms that hold a line break", () => {
    expect(
      collectHeardAsRules([
        entry("Long", ["x".repeat(101), "short"]),
        entry("Two\nlines", ["two lines"]),
      ])
    ).toEqual([{ heard: "short", term: "Long" }]);
  });

  it("keeps the newest entries' rules past the cap", () => {
    const entries = Array.from({ length: MAX_HEARD_AS_RULES + 5 }, (_, i) =>
      entry(`Term${i}`, [`heard ${i}`])
    );
    const rules = collectHeardAsRules(entries);
    expect(rules).toHaveLength(MAX_HEARD_AS_RULES);
    expect(rules[0]).toEqual({ heard: "heard 5", term: "Term5" });
    expect(rules.at(-1)).toEqual({
      heard: `heard ${MAX_HEARD_AS_RULES + 4}`,
      term: `Term${MAX_HEARD_AS_RULES + 4}`,
    });
  });

  it("has no rules for terms without heard-as forms", () => {
    expect(collectHeardAsRules([entry("React"), entry("Go")])).toEqual([]);
  });
});

describe("createHeardAsRewriter", () => {
  const zustand = rewriterFor(entry("Zustand", ["zoo stand"]));

  it("writes the term in its exact casing, whatever case it was heard in", () => {
    expect(zustand("add zoo stand to the store")).toBe("add Zustand to the store");
    expect(zustand("Zoo Stand is fine")).toBe("Zustand is fine");
    expect(zustand("ZOO STAND")).toBe("Zustand");
  });

  it("matches the phrase across any run of spaces but not a line break", () => {
    expect(zustand("use zoo  \t stand here")).toBe("use Zustand here");
    expect(zustand("a zoo\nstand")).toBe("a zoo\nstand");
  });

  it("rewrites every occurrence and keeps the punctuation around it", () => {
    expect(zustand("zoo stand, then (zoo stand).")).toBe("Zustand, then (Zustand).");
  });

  it("matches whole words only", () => {
    expect(zustand("a zoo standard")).toBe("a zoo standard");
    expect(zustand("the kazoo stand")).toBe("the kazoo stand");
  });

  it("treats hyphens, apostrophes, dots and slashes inside a word as part of it", () => {
    const react = rewriterFor(entry("React", ["racked"]));
    expect(react("racked-dom")).toBe("racked-dom");
    expect(react("un-racked")).toBe("un-racked");
    expect(react("racked'd")).toBe("racked'd");
    expect(react("racked.")).toBe("React.");
    expect(react("'racked'")).toBe("'React'");
  });

  it("keeps a possessive on the term", () => {
    expect(zustand("zoo stand's API and zoo stand’s store")).toBe(
      "Zustand's API and Zustand’s store"
    );
    expect(zustand("zoo stand's-helper")).toBe("zoo stand's-helper");
    expect(zustand("zoo stand'sx")).toBe("zoo stand'sx");
  });

  it("rewrites only within a span, judging its edges by the text around it", () => {
    const text = "zoo stand then zoo standalone and zoo stand.ts";
    expect(zustand(text, { from: 0, to: text.length })).toBe(
      "Zustand then zoo standalone and zoo stand.ts"
    );
    expect(zustand(text, { from: 10, to: 30 })).toBe(text);
    expect(zustand("x zoo stand y zoo stand", { from: 2, to: 11 })).toBe("x Zustand y zoo stand");
    // A phrase running past the span's end belongs to text the caller doesn't own.
    expect(zustand("x zoo stand", { from: 0, to: 8 })).toBe("x zoo stand");
  });

  it("reports each replacement it makes in the coordinates of the text it was given", () => {
    const text = "x zoo stand y zoo  stand z";
    const edits: Array<{ from: number; to: number; insert: string }> = [];
    const out = zustand(text, { from: 0, to: text.length }, edits);
    expect(edits).toEqual([
      { from: 2, to: 11, insert: "Zustand" },
      { from: 14, to: 24, insert: "Zustand" },
    ]);
    let rebuilt = text;
    for (const edit of [...edits].reverse()) {
      rebuilt = rebuilt.slice(0, edit.from) + edit.insert + rebuilt.slice(edit.to);
    }
    expect(rebuilt).toBe(out);

    const none: typeof edits = [];
    expect(zustand("zoo stand.ts", undefined, none)).toBe("zoo stand.ts");
    expect(none).toEqual([]);
  });

  it("prefers the longest phrase starting at the same word", () => {
    const rewrite = rewriterFor(
      entry("Zoo", ["zoo"]),
      entry("Zustand", ["zoo stand"]),
      entry("ZustandStore", ["zoo stand store"])
    );
    expect(rewrite("zoo stand store")).toBe("ZustandStore");
    expect(rewrite("zoo stand here")).toBe("Zustand here");
    expect(rewrite("the zoo")).toBe("the Zoo");
  });

  it("never rewrites what it has already written", () => {
    const rewrite = rewriterFor(entry("bee", ["ay"]), entry("sea", ["bee"]));
    expect(rewrite("ay bee")).toBe("bee sea");
  });

  it("writes the term literally, never as a replacement pattern", () => {
    expect(rewriterFor(entry("$&-$1", ["dollar"]))("pay dollar")).toBe("pay $&-$1");
  });

  it("escapes regex syntax in a heard form", () => {
    const rewrite = rewriterFor(entry("C++", ["c+ +"]), entry("Ok", ["(ok)"]));
    expect(rewrite("write c+ + code")).toBe("write C++ code");
    expect(rewrite("cc + code")).toBe("cc + code");
    expect(rewrite("say (ok) now")).toBe("say Ok now");
  });

  it.each([
    ["an @-reference", "check @zoo stand and zoo stand", "check @zoo stand and Zustand"],
    [
      "a quoted @-reference with spaces",
      'check @"docs/my zoo stand notes.md" and zoo stand',
      'check @"docs/my zoo stand notes.md" and Zustand',
    ],
    [
      "a quoted @-reference with an escaped quote",
      'check @"my \\"zoo stand\\".md" and zoo stand',
      'check @"my \\"zoo stand\\".md" and Zustand',
    ],
    ["backticked text", "run `zoo stand` then zoo stand", "run `zoo stand` then Zustand"],
    ["a path", "open ~/zoo stand and zoo stand", "open ~/zoo stand and Zustand"],
    [
      "a URL",
      "see https://example.com?q=zoo stand and zoo stand",
      "see https://example.com?q=zoo stand and Zustand",
    ],
    ["a flag", "pass --zoo stand and zoo stand", "pass --zoo stand and Zustand"],
  ])("leaves %s alone, even where a phrase only touches it", (_label, input, expected) => {
    expect(zustand(input)).toBe(expected);
  });

  it("still finds a phrase that starts inside one refused for touching a span", () => {
    const rewrite = rewriterFor(entry("X", ["a b"]), entry("Y", ["b c"]));
    expect(rewrite("@a b c")).toBe("@a Y");
    expect(rewrite("--a b c")).toBe("--a Y");
  });

  it("rewrites a heard form inside a protected span nowhere", () => {
    const react = rewriterFor(entry("React", ["react"]));
    expect(react("fix @src/react/hooks.ts and src/react/x.ts with `react` --react")).toBe(
      "fix @src/react/hooks.ts and src/react/x.ts with `react` --react"
    );
  });

  // The old recasing pass rewrote these just because the terms were in the dictionary.
  it.each([
    ["@src/react/hooks.ts", [entry("React"), entry("Go")]],
    ["vite.config.ts", [entry("Vite")]],
    ["let's go", [entry("React"), entry("Go")]],
  ])("leaves %s unchanged when the dictionary only has the term", (text, entries) => {
    expect(rewriterFor(...entries)(text)).toBe(text);
  });

  it("is the identity with no rules", () => {
    const rewrite = createHeardAsRewriter([]);
    expect(rewrite("zoo stand")).toBe("zoo stand");
  });

  it("finds the term when the regex folds a letter toLowerCase leaves alone", () => {
    expect(rewriterFor(entry("Straße", ["strasse"]))("die ſtrasse")).toBe("die Straße");
  });

  it("matches non-Latin words by Unicode letters", () => {
    const rewrite = rewriterFor(entry("Straße", ["strasse"]), entry("Кот", ["кот"]));
    expect(rewrite("die strasse und die strassen")).toBe("die Straße und die strassen");
    expect(rewrite("мой КОТ и котик")).toBe("мой Кот и котик");
  });

  it("scans past protected spans in linear time", () => {
    // 20,000 spans take a few milliseconds, so the 1x run is past timer noise.
    const ratio = scalingRatio((scale) => {
      expect(zustand("`zoo stand` ".repeat(20_000 * scale) + "zoo stand")).toMatch(/ Zustand$/);
    });
    expect(ratio).toBeLessThan(24);
  });

  it("rewrites a long draft in linear time with a full dictionary, many matches and spans", () => {
    const entries = Array.from({ length: MAX_HEARD_AS_RULES }, (_, i) =>
      entry(`Term${i}`, [`heard form ${i}`])
    );
    const rewrite = rewriterFor(...entries);
    const chunk = "heard form 7 and `heard form 8` near heard form ";
    // 50 chunks take several milliseconds, so the 1x run is past timer noise.
    const ratio = scalingRatio((scale) => {
      expect(rewrite(chunk.repeat(50 * scale))).toBe(
        "Term7 and `heard form 8` near heard form ".repeat(50 * scale)
      );
    });
    expect(ratio).toBeLessThan(24);
  });
});
