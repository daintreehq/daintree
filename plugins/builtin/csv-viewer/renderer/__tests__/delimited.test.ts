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

  it("never picks a delimiter that only splits quoted values", () => {
    const text = 'id,"a;b;c"\n1,"x;y;z"\n';
    expect(detectDelimiter(text, "csv")).toBe(",");
    expect(readDelimitedTable(text, "csv").rows(0, 1)).toEqual([["1", "x;y;z"]]);
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
  it("takes the first record as the header and counts the widest row", () => {
    const table = readDelimitedTable("a,b\n1,2,3\n4\n", "csv");
    expect(table).toMatchObject({
      delimiter: ",",
      header: ["a", "b"],
      rowCount: 2,
      columnCount: 3,
    });
    expect(table.rows(0, 2)).toEqual([["1", "2", "3"], ["4"]]);
  });

  it("parses just the rows asked for, quoted line breaks and all", () => {
    const table = readDelimitedTable('h\n"one\nline"\ntwo\nthree\n', "csv");
    expect(table.rowCount).toBe(3);
    expect(table.rows(1, 3)).toEqual([["two"], ["three"]]);
    expect(table.rows(0, 1)).toEqual([["one\nline"]]);
    expect(table.rows(2, 99)).toEqual([["three"]]);
  });

  it("reads an empty file as no columns and no rows", () => {
    const table = readDelimitedTable("", "csv");
    expect(table).toMatchObject({ delimiter: ",", header: [], rowCount: 0, columnCount: 0 });
    expect(table.rows(0, 10)).toEqual([]);
  });

  it("reads a header-only file", () => {
    expect(readDelimitedTable("id\tname\n", "tsv")).toMatchObject({
      delimiter: "\t",
      header: ["id", "name"],
      rowCount: 0,
    });
  });

  it("indexes a file of millions of short records without building them", () => {
    const text = "id\n" + "\n".repeat(2_000_000);
    const started = performance.now();
    const table = readDelimitedTable(text, "csv");
    expect(table.rowCount).toBe(2_000_000);
    expect(table.rows(1_999_999, 2_000_000)).toEqual([[""]]);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("parses a large file quickly", () => {
    const line = '1,alice,alice@example.com,2026-01-01,"Somewhere, Earth"\n';
    const text = "id,name,email,joined,address\n" + line.repeat(40_000);
    const started = performance.now();
    const table = readDelimitedTable(text, "csv");
    expect(table.rowCount).toBe(40_000);
    expect(table.rows(39_999, 40_000)[0]![4]).toBe("Somewhere, Earth");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
