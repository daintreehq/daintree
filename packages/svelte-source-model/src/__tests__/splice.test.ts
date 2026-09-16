import { describe, expect, it } from "vitest";
import { parse } from "svelte/compiler";
import { SpliceError, applyReplacements, isNoOp, lineColumnToOffset } from "../splice.js";
import type { Replacement } from "../splice.js";

const shuffle = <T>(items: readonly T[], seed: number): T[] => {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

describe("applyReplacements", () => {
  it("leaves every byte outside the replaced ranges untouched", () => {
    const source = `<div class="a b" title="keep">text</div>`;
    const out = applyReplacements(source, [{ start: 12, end: 15, text: "c d e" }]);
    expect(out.slice(0, 12)).toBe(source.slice(0, 12));
    expect(out.slice(12 + "c d e".length)).toBe(source.slice(15));
  });

  it("interprets every offset against the original, not the running result", () => {
    const source = "AAAABBBBCCCC";
    const out = applyReplacements(source, [
      { start: 0, end: 4, text: "x" },
      { start: 8, end: 12, text: "yyyyyyyy" },
    ]);
    expect(out).toBe("xBBBByyyyyyyy");
  });

  it("is order-independent for non-overlapping replacements", () => {
    const source = "0123456789abcdef";
    const replacements: Replacement[] = [
      { start: 1, end: 3, text: "!" },
      { start: 6, end: 6, text: "+" },
      { start: 10, end: 14, text: "LONGER" },
    ];
    const expected = applyReplacements(source, replacements);
    for (let seed = 1; seed <= 5; seed++) {
      expect(applyReplacements(source, shuffle(replacements, seed))).toBe(expected);
    }
  });

  it("applies insertions at a shared offset in the order given", () => {
    const out = applyReplacements("ab", [
      { start: 1, end: 1, text: "1" },
      { start: 1, end: 1, text: "2" },
    ]);
    expect(out).toBe("a12b");
  });

  it("allows an insertion that touches the boundary of a replacement", () => {
    const out = applyReplacements("abcd", [
      { start: 1, end: 3, text: "X" },
      { start: 3, end: 3, text: "!" },
    ]);
    expect(out).toBe("aX!d");
  });

  it("rejects overlapping replacements rather than letting one win", () => {
    let code: string | undefined;
    try {
      applyReplacements("abcdef", [
        { start: 1, end: 4, text: "x" },
        { start: 3, end: 5, text: "y" },
      ]);
    } catch (error) {
      code = (error as SpliceError).code;
    }
    expect(code).toBe("OVERLAPPING_RANGES");
  });

  it("catches an overlap that a zero-width insertion sits between", () => {
    // The scan tracks the furthest byte claimed so far rather than only the
    // previous entry, so an insertion between two conflicting replacements
    // cannot break the chain and let both through.
    let code: string | undefined;
    try {
      applyReplacements("abcdef", [
        { start: 1, end: 4, text: "X" },
        { start: 2, end: 2, text: "!" },
        { start: 3, end: 5, text: "Y" },
      ]);
    } catch (error) {
      code = (error as SpliceError).code;
    }
    expect(code).toBe("OVERLAPPING_RANGES");
  });

  it("rejects inverted and out-of-bounds ranges", () => {
    expect(() => applyReplacements("abc", [{ start: 2, end: 1, text: "" }])).toThrow(SpliceError);
    expect(() => applyReplacements("abc", [{ start: 0, end: 9, text: "" }])).toThrow(SpliceError);
    expect(() => applyReplacements("abc", [{ start: -1, end: 1, text: "" }])).toThrow(SpliceError);
  });

  it("rejects fractional and non-finite offsets rather than slicing silently", () => {
    expect(() => applyReplacements("abc", [{ start: 0.5, end: 2, text: "" }])).toThrow(SpliceError);
    expect(() => applyReplacements("abc", [{ start: 0, end: NaN, text: "" }])).toThrow(SpliceError);
    expect(() =>
      applyReplacements("abc", [{ start: 0, end: Number.POSITIVE_INFINITY, text: "" }])
    ).toThrow(SpliceError);
  });

  it("counts offsets in UTF-16 units, so an astral character spans two", () => {
    const source = "a😀b";
    expect(applyReplacements(source, [{ start: 1, end: 3, text: "-" }])).toBe("a-b");
  });

  it("returns the source unchanged for an empty replacement set", () => {
    expect(applyReplacements("abc", [])).toBe("abc");
  });
});

describe("isNoOp", () => {
  it("is not a substitute for comparing the spliced result", () => {
    // Two replacements that cancel out: each restates different bytes, so
    // isNoOp says false, yet the file is unchanged. Callers that must not write
    // a no-op have to compare the result, which is what sealPlan does.
    const source = "ab";
    const cancelling: Replacement[] = [
      { start: 0, end: 1, text: "" },
      { start: 1, end: 1, text: "a" },
    ];
    expect(applyReplacements(source, cancelling)).toBe(source);
    expect(isNoOp(source, cancelling)).toBe(false);
  });

  it("is true only when every replacement restates the bytes already there", () => {
    const source = 'class="a b"';
    expect(isNoOp(source, [{ start: 7, end: 10, text: "a b" }])).toBe(true);
    expect(isNoOp(source, [{ start: 7, end: 10, text: "a  b" }])).toBe(false);
  });

  it("agrees with applyReplacements on whether the result differs", () => {
    const source = "hello world";
    const cases: Replacement[][] = [
      [{ start: 0, end: 5, text: "hello" }],
      [{ start: 0, end: 5, text: "howdy" }],
      [
        { start: 0, end: 5, text: "hello" },
        { start: 6, end: 11, text: "there" },
      ],
    ];
    for (const replacements of cases) {
      expect(isNoOp(source, replacements)).toBe(applyReplacements(source, replacements) === source);
    }
  });
});

describe("lineColumnToOffset", () => {
  it("round-trips against the line and column the source actually has", () => {
    const source = "one\ntwo\nthree";
    const offset = lineColumnToOffset(source, 3, 2);
    expect(offset).not.toBeNull();
    expect(source.slice(offset!)).toBe("ree");
  });

  it("accepts the position at the line break but not past it", () => {
    const source = "ab\ncd";
    expect(lineColumnToOffset(source, 1, 2)).toBe(2);
    expect(lineColumnToOffset(source, 1, 3)).toBeNull();
  });

  it("gives the same offsets on a CRLF file as the parser itself does", () => {
    // The real oracle: the compiler's own start offset for an element, reached
    // from the line and column its dev runtime would report for that element.
    const crlf = '<div class="a">x</div>\r\n<p>second</p>\r\n<span>third</span>\r\n';
    const ast = parse(crlf, { modern: true }) as unknown as {
      fragment: { nodes: { type: string; name?: string; start: number }[] };
    };
    const span = ast.fragment.nodes.find((n) => n.name === "span");
    expect(span).toBeDefined();
    expect(lineColumnToOffset(crlf, 3, 0)).toBe(span!.start);
  });

  it("returns null for a position the file does not have", () => {
    expect(lineColumnToOffset("one\ntwo", 9, 0)).toBeNull();
    expect(lineColumnToOffset("one", 0, 0)).toBeNull();
    expect(lineColumnToOffset("one", 1, -1)).toBeNull();
    expect(lineColumnToOffset("one", 1.5, 0)).toBeNull();
  });
});
