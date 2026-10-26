import { describe, expect, it } from "vitest";
import type { VoiceDictionaryEntry } from "../../types/ipc/api.js";
import { collectHeardAsRules, createHeardAsRewriter } from "../voiceHeardAs.js";

function entry(term: string, heardAs: string[] = []): VoiceDictionaryEntry {
  return { term, heardAs, source: "manual", addedAt: 0 };
}

function rewriterFor(...entries: VoiceDictionaryEntry[]) {
  return createHeardAsRewriter(collectHeardAsRules(entries));
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

  it("matches non-Latin words by Unicode letters", () => {
    const rewrite = rewriterFor(entry("Straße", ["strasse"]), entry("Кот", ["кот"]));
    expect(rewrite("die strasse und die strassen")).toBe("die Straße und die strassen");
    expect(rewrite("мой КОТ и котик")).toBe("мой Кот и котик");
  });

  it("stays fast on a long passage with many rules", () => {
    const entries = Array.from({ length: 400 }, (_, i) =>
      entry(`Term${i}`, [`heard form number ${i}`])
    );
    const rewrite = rewriterFor(...entries);
    const text = "heard form number ".repeat(700) + "heard form number 7";
    const started = performance.now();
    expect(rewrite(text)).toBe("heard form number ".repeat(700) + "Term7");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
