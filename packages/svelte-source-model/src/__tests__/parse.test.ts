import { describe, expect, it, vi } from "vitest";
import type { SvelteParse } from "../types.js";

interface Compiler {
  fails: boolean;
  calls: Parameters<SvelteParse>[];
}

/** The real parser behind the thin entry, counting its calls, or a load that fails. */
function mockCompiler(compiler: Compiler): void {
  vi.doMock("../compiler-parse.js", async (importOriginal) => {
    if (compiler.fails) throw new Error("compiler unavailable");
    const real = (await importOriginal<typeof import("../compiler-parse.js")>())
      .parse as unknown as SvelteParse;
    const parse: SvelteParse = (source, options) => {
      compiler.calls.push([source, options]);
      return real(source, options);
    };
    return { parse };
  });
}

/** A fresh `parse.ts`, so each test starts with nothing loaded and nothing cached. */
async function freshLoadParse(fails = false) {
  vi.resetModules();
  const compiler: Compiler = { fails, calls: [] };
  mockCompiler(compiler);
  const { loadParse } = await import("../parse.js");
  return { loadParse, compiler };
}

const OPTIONS = { modern: true } as const;

describe("loadParse", () => {
  it("loads the parser once and hands every caller the same function", async () => {
    const { loadParse } = await freshLoadParse();
    const [first, second] = await Promise.all([loadParse(), loadParse()]);
    expect(second).toBe(first);
    expect(await loadParse()).toBe(first);
  });

  it("returns the last tree again for the same source and options", async () => {
    const { loadParse, compiler } = await freshLoadParse();
    const parse = await loadParse();
    const tree = parse("<p>hello</p>", OPTIONS);
    expect(parse("<p>hello</p>", { modern: true })).toBe(tree);
    expect(compiler.calls).toHaveLength(1);
  });

  it("parses again when the source or the options change, keeping only the last", async () => {
    const { loadParse, compiler } = await freshLoadParse();
    const parse = await loadParse();
    const first = parse("<p>a</p>", OPTIONS);
    const changed = parse("<p>b</p>", OPTIONS);
    expect(changed).not.toBe(first);
    const named = { modern: true, filename: "B.svelte" } as const;
    expect(parse("<p>b</p>", named)).not.toBe(changed);
    expect(parse("<p>a</p>", OPTIONS)).not.toBe(first);
    expect(compiler.calls).toEqual([
      ["<p>a</p>", OPTIONS],
      ["<p>b</p>", OPTIONS],
      ["<p>b</p>", named],
      ["<p>a</p>", OPTIONS],
    ]);
  });

  it("keeps offsets aligned with text that still starts with a byte-order mark", async () => {
    const { loadParse } = await freshLoadParse();
    const parse = await loadParse();
    // The file's own BOM is already gone; this one is content.
    const source = "﻿<p>hi</p>";
    const element = parse(source, OPTIONS).fragment.nodes?.find(
      (node) => node.type === "RegularElement"
    );
    expect(element).toBeDefined();
    expect(source.slice(element!.start, element!.end)).toBe("<p>hi</p>");
  });

  it("lets a later call retry after the compiler fails to load", async () => {
    const { loadParse, compiler } = await freshLoadParse(true);
    // Vitest rewraps a throwing mock factory in its own error; that it rejects is the point.
    await expect(loadParse()).rejects.toThrow();

    compiler.fails = false;
    mockCompiler(compiler);
    const parse = await loadParse();
    expect(parse("<p>ok</p>", OPTIONS).fragment.type).toBe("Fragment");
    expect(compiler.calls).toHaveLength(1);
  });
});
