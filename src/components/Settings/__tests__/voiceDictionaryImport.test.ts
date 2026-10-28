import { describe, expect, it } from "vitest";
import {
  MAX_DICTIONARY_IMPORT_TERMS,
  parseDictionaryInput,
  parseHeardAsField,
} from "../voiceDictionaryImport";
import { MAX_DICTIONARY_HEARD_AS } from "@shared/utils/voiceDictionary";

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

  it("reads comma-separated pairs one by one", () => {
    expect(parseDictionaryInput("zoo stand -> Zustand, veet -> Vite").terms).toEqual([
      { term: "Zustand", heardAs: ["zoo stand"] },
      { term: "Vite", heardAs: ["veet"] },
    ]);
  });

  it("reads an arrow with no space beside it as part of the term", () => {
    expect(parseDictionaryInput("ptr->next\nmap=>fn\nzoo stand ->Zustand").terms).toEqual([
      { term: "ptr->next", heardAs: [] },
      { term: "map=>fn", heardAs: [] },
      { term: "zoo stand ->Zustand", heardAs: [] },
    ]);
    expect(parseDictionaryInput("  zoo stand  ->  Zustand ").terms).toEqual([
      { term: "Zustand", heardAs: ["zoo stand"] },
    ]);
  });

  it("skips what a keyterm can't hold and reports it", () => {
    const result = parseDictionaryInput(`${"a".repeat(101)}, ok`);
    expect(result.terms).toEqual([{ term: "ok", heardAs: [] }]);
    expect(result.skipped).toBe(1);
  });

  it("takes at most the import cap of terms and counts each one left out once", () => {
    const lines = Array.from({ length: MAX_DICTIONARY_IMPORT_TERMS + 2 }, (_, i) => `term${i}`);
    lines.push(`TERM${MAX_DICTIONARY_IMPORT_TERMS}`, "veet -> term0");
    const result = parseDictionaryInput(lines.join("\n"));

    expect(result.terms).toHaveLength(MAX_DICTIONARY_IMPORT_TERMS);
    expect(result.overflowTerms).toBe(2);
    // A repeat of a term already taken still folds in past the cap.
    expect(result.terms[0]).toEqual({ term: "term0", heardAs: ["veet"] });
  });

  it("keeps at most the main-process cap of heard-as phrases on a term", () => {
    const lines = Array.from(
      { length: MAX_DICTIONARY_HEARD_AS + 3 },
      (_, i) => `heard ${i} -> Zustand`
    );
    lines.push("heard 0 -> Zustand", "veet -> Vite");
    const result = parseDictionaryInput(lines.join("\n"));

    expect(result.terms[0]!.heardAs).toHaveLength(MAX_DICTIONARY_HEARD_AS);
    expect(result.overflowHeardAs).toBe(3);
    expect(result.terms[1]).toEqual({ term: "Vite", heardAs: ["veet"] });
    expect(result.overflowTerms).toBe(0);
  });

  it("ignores empty input and a pair with no term", () => {
    expect(parseDictionaryInput("  \n, ,\nheard -> ").terms).toEqual([]);
  });
});

describe("parseHeardAsField", () => {
  it("splits on new lines and keeps commas inside a phrase", () => {
    expect(parseHeardAsField("zoo stand\n  one, two \n")).toEqual(["zoo stand", "one, two"]);
  });
});
