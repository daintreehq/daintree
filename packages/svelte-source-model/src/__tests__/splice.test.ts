import { describe, expect, it } from "vitest";
import { parse } from "svelte/compiler";
import { lineColumnToOffset } from "../splice.js";

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
