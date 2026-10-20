import { describe, expect, it } from "vitest";
import { parseJsonc } from "../parseJsonc.js";

describe("parseJsonc", () => {
  it("parses line and block comments", () => {
    const text = `{
      // leading
      "a": 1, /* between */ "b": /* inline */ 2
      /* trailing
         multi-line */
    }`;
    expect(parseJsonc(text)).toEqual({ a: 1, b: 2 });
  });

  it("accepts trailing commas in objects and arrays, including before a comment", () => {
    expect(parseJsonc('{ "a": [1, 2,], "b": { "c": 3, }, }')).toEqual({
      a: [1, 2],
      b: { c: 3 },
    });
    expect(parseJsonc("[1, // last\n]")).toEqual([1]);
    expect(parseJsonc('{ "a": 1, /* gone */ }')).toEqual({ a: 1 });
  });

  it("leaves comment and comma syntax inside strings alone", () => {
    const value = {
      url: "http://example.com/a//b",
      glob: "src/**/*.ts",
      close: "*/",
      tail: "x,]",
      quoted: 'say "hi" // not a comment',
      slash: "ends with \\",
    };
    expect(parseJsonc(JSON.stringify(value, null, 2))).toEqual(value);
  });

  it("does not join tokens a block comment separated", () => {
    expect(() => parseJsonc("[1/**/2]")).toThrow(SyntaxError);
  });

  it("strips a leading BOM", () => {
    expect(parseJsonc('﻿// c\n{"a":1,}')).toEqual({ a: 1 });
  });

  it("still rejects malformed input", () => {
    for (const text of [
      "",
      "{invalid json",
      '{ "a": 1 /* unterminated }',
      '{ "a": "unterminated }',
      "{,}",
      "[,]",
      "[1,,]",
      "{ a: 1 }",
    ]) {
      expect(() => parseJsonc(text), text).toThrow(SyntaxError);
    }
  });
});
