import { describe, expect, it } from "vitest";
import {
  findContextReferences,
  formatContextReference,
  isContextItemId,
  isContextProviderPrefix,
  splitContextProviderQuery,
} from "../pluginContextReference.js";
import {
  sanitizeContextProviderContent,
  sanitizeContextProviderItems,
} from "../pluginContextSanitize.js";

describe("context provider prefixes (#13795)", () => {
  it("takes one to sixteen lowercase letters and never the composer's own words", () => {
    expect(isContextProviderPrefix("rec")).toBe(true);
    expect(isContextProviderPrefix("a".repeat(16))).toBe(true);
    expect(isContextProviderPrefix("a".repeat(17))).toBe(false);
    expect(isContextProviderPrefix("Rec")).toBe(false);
    expect(isContextProviderPrefix("rec2")).toBe(false);
    expect(isContextProviderPrefix("")).toBe(false);
    for (const reserved of ["diff", "terminal", "selection"]) {
      expect(isContextProviderPrefix(reserved)).toBe(false);
    }
  });

  it("bounds item ids to one draft token that a sentence can follow", () => {
    expect(isContextItemId("142")).toBe(true);
    expect(isContextItemId("PROJ-12/notes#3")).toBe(true);
    expect(isContextItemId("v1.2")).toBe(true);
    expect(isContextItemId("ends.")).toBe(false);
    expect(isContextItemId("ends:")).toBe(false);
    expect(isContextItemId("has space")).toBe(false);
    expect(isContextItemId("a".repeat(129))).toBe(false);
    expect(isContextItemId(42)).toBe(false);
  });
});

describe("findContextReferences", () => {
  it("finds references at a word start and ends them before sentence punctuation", () => {
    const text = "see @rec:142, then @page:a/b.";
    expect(findContextReferences(text)).toEqual([
      { start: 4, end: 12, prefix: "rec", id: "142" },
      { start: 19, end: 28, prefix: "page", id: "a/b" },
    ]);
    expect(text.slice(4, 12)).toBe(formatContextReference({ prefix: "rec", id: "142" }));
  });

  it("ignores reserved words, mid-word @, and text an id can't continue into", () => {
    expect(findContextReferences("@diff:staged")).toEqual([]);
    expect(findContextReferences("mail@rec:1")).toEqual([]);
    expect(findContextReferences("@rec:1$x")).toEqual([]);
    expect(findContextReferences("@Rec:1")).toEqual([]);
  });
});

describe("splitContextProviderQuery", () => {
  it("hands the provider only what follows its prefix", () => {
    expect(splitContextProviderQuery("rec:login")).toEqual({ prefix: "rec", query: "login" });
    expect(splitContextProviderQuery("rec:a:b")).toEqual({ prefix: "rec", query: "a:b" });
    expect(splitContextProviderQuery("rec:")).toEqual({ prefix: "rec", query: "" });
    expect(splitContextProviderQuery("rec")).toBeNull();
    expect(splitContextProviderQuery("diff:staged")).toBeNull();
    expect(splitContextProviderQuery(":x")).toBeNull();
  });
});

describe("sanitizeContextProviderItems", () => {
  it("keeps valid rows, one line each, and drops malformed or duplicate ones", () => {
    expect(
      sanitizeContextProviderItems([
        { id: "1", label: "Fix\nlogin", description: "  open  " },
        { id: "1", label: "duplicate" },
        { id: "bad id", label: "x" },
        null,
        { id: "2" },
      ])
    ).toEqual([
      { id: "1", label: "Fix login", description: "open" },
      { id: "2", label: "2" },
    ]);
    expect(sanitizeContextProviderItems("nope")).toEqual([]);
  });

  it("shows at most fifty", () => {
    const rows = Array.from({ length: 80 }, (_, i) => ({ id: `r${i}`, label: `Row ${i}` }));
    expect(sanitizeContextProviderItems(rows)).toHaveLength(50);
  });
});

describe("sanitizeContextProviderContent", () => {
  it("normalises text and keeps a one-line title", () => {
    expect(sanitizeContextProviderContent({ text: "a\r\nb\u001b\n\n", title: " T\nx " })).toEqual({
      ok: true,
      content: { text: "a\nb", title: "T x" },
    });
  });

  it("refuses content it can't pass on whole, with a reason", () => {
    expect(sanitizeContextProviderContent(null)).toEqual({ ok: false, reason: "not found" });
    expect(sanitizeContextProviderContent({ text: "   " })).toMatchObject({ ok: false });
    expect(sanitizeContextProviderContent({ title: "no text" })).toMatchObject({ ok: false });
    const tooLong = sanitizeContextProviderContent({ text: "x".repeat(32_769) });
    expect(tooLong).toEqual({ ok: false, reason: "returned more than 32,768 characters" });
  });
});
