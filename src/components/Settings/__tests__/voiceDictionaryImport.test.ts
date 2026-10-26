import { describe, expect, it } from "vitest";
import { parseDictionaryInput, parseHeardAsField } from "../voiceDictionaryImport";

describe("parseDictionaryInput", () => {
  it("reads lines and comma-separated terms", () => {
    expect(parseDictionaryInput("Zustand, Vite\n\n  Daintree  ").terms).toEqual([
      { term: "Zustand", heardAs: [] },
      { term: "Vite", heardAs: [] },
      { term: "Daintree", heardAs: [] },
    ]);
  });

  it("reads heard -> Term pairs and folds repeats of a term", () => {
    const { terms } = parseDictionaryInput(
      "zoo stand -> Zustand\nzu stand → zustand\nZustand\nzoo stand => Zustand"
    );
    expect(terms).toEqual([{ term: "Zustand", heardAs: ["zoo stand", "zu stand"] }]);
  });

  it("skips what a keyterm can't hold and reports it", () => {
    const result = parseDictionaryInput(`${"a".repeat(101)}, ok`);
    expect(result.terms).toEqual([{ term: "ok", heardAs: [] }]);
    expect(result.skipped).toBe(1);
  });

  it("ignores empty input and a pair with no term", () => {
    expect(parseDictionaryInput("  \n, ,\nheard -> ").terms).toEqual([]);
  });
});

describe("parseHeardAsField", () => {
  it("splits on commas and new lines", () => {
    expect(parseHeardAsField("zoo stand, zu stand\n  ,")).toEqual(["zoo stand", "zu stand"]);
  });
});
