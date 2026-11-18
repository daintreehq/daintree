import { describe, expect, it } from "vitest";

import { detectDelimiter, parseDelimited, readDelimitedTable } from "../delimited.js";

describe("parseDelimited", () => {
  it("splits records and fields", () => {
    expect(parseDelimited("a,b,c\n1,2,3\n", ",")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps the last record without a trailing line break", () => {
    expect(parseDelimited("a,b\n1,2", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("reads quoted fields with delimiters, line breaks and doubled quotes", () => {
    expect(parseDelimited('name,note\n"Smith, J","said ""hi""\nthen left"\n', ",")).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"\nthen left'],
    ]);
  });

  it("treats CRLF and lone CR as line breaks", () => {
    expect(parseDelimited("a,b\r\n1,2\r3,4", ",")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("keeps empty fields, including a trailing one", () => {
    expect(parseDelimited(",x,\n,", ",")).toEqual([
      ["", "x", ""],
      ["", ""],
    ]);
  });

  it("keeps a blank line in the middle as an empty record", () => {
    expect(parseDelimited("a\n\nb\n", ",")).toEqual([["a"], [""], ["b"]]);
  });

  it("is lenient with stray and unclosed quotes", () => {
    expect(parseDelimited('ab"c,"d"e\n"open,end', ",")).toEqual([['ab"c', "de"], ["open,end"]]);
  });

  it("returns nothing for an empty file", () => {
    expect(parseDelimited("", ",")).toEqual([]);
  });

  it("stops at the record limit", () => {
    expect(parseDelimited("a\nb\nc\n", ",", 2)).toEqual([["a"], ["b"]]);
  });
});

describe("detectDelimiter", () => {
  it("finds semicolons in a .csv", () => {
    expect(detectDelimiter("a;b;c\n1;2,5;3\n4;5;6\n", "csv")).toBe(";");
  });

  it("finds tabs in a .csv", () => {
    expect(detectDelimiter("a\tb\n1\t2\n", "csv")).toBe("\t");
  });

  it("finds commas in a .tsv", () => {
    expect(detectDelimiter("a,b,c\n1,2,3\n", "tsv")).toBe(",");
  });

  it("ignores delimiters inside quoted values", () => {
    expect(detectDelimiter('a;b\n"x,y,z";2\n"p,q,r";3\n', "csv")).toBe(";");
  });

  it("prefers rows of one width over a single much wider record", () => {
    const prose = `${"word, ".repeat(400)}end`;
    const rows = Array.from({ length: 8 }, (_, index) => `${index};x;y`).join("\n");
    expect(detectDelimiter(`id;a;b\n${rows}\n${prose}\n`, "csv")).toBe(";");
  });

  it("reads the extension case-insensitively", () => {
    expect(detectDelimiter("one\ntwo\n", "TSV")).toBe("\t");
  });

  it("falls back to the extension's delimiter for a single column", () => {
    expect(detectDelimiter("one\ntwo\n", "csv")).toBe(",");
    expect(detectDelimiter("one\ntwo\n", "tsv")).toBe("\t");
    expect(detectDelimiter("", null)).toBe(",");
  });
});

describe("readDelimitedTable", () => {
  it("takes the first record as the header, padded to the widest row", () => {
    expect(readDelimitedTable("a,b\n1,2,3\n4\n", "csv")).toEqual({
      delimiter: ",",
      header: ["a", "b", ""],
      rows: [["1", "2", "3"], ["4"]],
      columnCount: 3,
    });
  });

  it("reads an empty file as no columns and no rows", () => {
    expect(readDelimitedTable("", "csv")).toEqual({
      delimiter: ",",
      header: [],
      rows: [],
      columnCount: 0,
    });
  });

  it("reads a header-only file", () => {
    expect(readDelimitedTable("id\tname\n", "tsv")).toMatchObject({
      delimiter: "\t",
      header: ["id", "name"],
      rows: [],
    });
  });

  it("parses a large file quickly", () => {
    const line = '1,alice,alice@example.com,2026-01-01,"Somewhere, Earth"\n';
    const text = "id,name,email,joined,address\n" + line.repeat(40_000);
    const started = performance.now();
    const table = readDelimitedTable(text, "csv");
    expect(table.rows).toHaveLength(40_000);
    expect(table.rows[0]![4]).toBe("Somewhere, Earth");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
