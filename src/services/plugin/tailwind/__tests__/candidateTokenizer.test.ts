/**
 * The tokeniser is the speculative half of candidate discovery, so these tests
 * are about the two directions it is allowed to be wrong in.
 *
 * Over-collecting is free — Tailwind drops non-utilities silently — so nothing
 * here asserts that a junk token is absent unless its presence would indicate a
 * structural bug (splitting inside an arbitrary value, say). Under-collecting is
 * what costs a styled first paint, so the class-shape cases are exact.
 */

import { describe, it, expect } from "vitest";
import {
  tokenizePluginSource,
  MAX_CANDIDATES,
  MAX_SOURCE_BYTES,
  MAX_TOKEN_LENGTH,
} from "@/services/plugin/tailwind/candidateTokenizer";

describe("tokenizePluginSource", () => {
  it("collects classes from every quote form", () => {
    const tokens = tokenizePluginSource(`
      const a = "flex gap-2";
      const b = 'p-4 rounded-md';
      const c = \`text-text-muted\`;
    `);

    expect(tokens).toEqual(
      expect.arrayContaining(["flex", "gap-2", "p-4", "rounded-md", "text-text-muted"])
    );
  });

  it("keeps arbitrary values whole, including their internal separators", () => {
    // The one part of oxide's scanner that cannot be approximated by splitting
    // on whitespace: brackets have to be counted, or `grid-cols-[1fr_auto]`
    // becomes two useless fragments and the class never compiles.
    const tokens = tokenizePluginSource(
      `"w-[327px] grid-cols-[1fr_auto] shadow-[0_1px_2px_rgb(0,0,0,.1)] bg-[url('a b.png')]"`
    );

    expect(tokens).toContain("w-[327px]");
    expect(tokens).toContain("grid-cols-[1fr_auto]");
    expect(tokens).toContain("shadow-[0_1px_2px_rgb(0,0,0,.1)]");
    expect(tokens).toContain("bg-[url('a b.png')]");
  });

  it("keeps variants, important markers and opacity intact", () => {
    const tokens = tokenizePluginSource(
      `"hover:bg-surface-hover focus-visible:ring-1 dark:hidden !p-4 p-4! bg-surface-panel/50 " +
       "text-text-muted/[0.25] @sm:flex [&>*]:mt-0 -mt-1 group-hover:text-text-primary"`
    );

    for (const expected of [
      "hover:bg-surface-hover",
      "focus-visible:ring-1",
      "dark:hidden",
      "!p-4",
      "p-4!",
      "bg-surface-panel/50",
      "text-text-muted/[0.25]",
      "@sm:flex",
      "[&>*]:mt-0",
      "-mt-1",
      "group-hover:text-text-primary",
    ]) {
      expect(tokens, `missing ${expected}`).toContain(expected);
    }
  });

  it("reads the static parts around a template interpolation", () => {
    // The documented authoring rule is that a conditional class must be a
    // complete string. The statics on both sides of `${}` still count, and the
    // expression itself must never be tokenised as class text.
    const tokens = tokenizePluginSource("`p-4 ${isActive ? 'bg-surface-active' : ''} gap-2`");

    expect(tokens).toContain("p-4");
    expect(tokens).toContain("gap-2");
    // Collected from its own nested literal, which is exactly why complete
    // strings work and concatenated fragments do not.
    expect(tokens).toContain("bg-surface-active");
    expect(tokens).not.toContain("isActive");
  });

  it("ignores identifiers outside string literals", () => {
    // Reading only string contents is what keeps the candidate set small enough
    // to hand to the compiler on the mount path.
    const tokens = tokenizePluginSource(`
      import { useState } from "react";
      const className = computeClassName(someValue);
    `);

    expect(tokens).not.toContain("useState");
    expect(tokens).not.toContain("computeClassName");
    expect(tokens).not.toContain("someValue");
  });

  it("de-duplicates while preserving first-seen order", () => {
    expect(tokenizePluginSource(`"p-4 gap-2" "gap-2 p-4 flex"`)).toEqual(["p-4", "gap-2", "flex"]);
  });

  it("does not run past a line break in a single-quoted literal", () => {
    // An apostrophe in prose is far more common than a real unterminated
    // string; swallowing the rest of the file from one would tank the pass.
    const tokens = tokenizePluginSource(`// it's fine\nconst x = "p-4";`);

    expect(tokens).toContain("p-4");
  });

  it("rejects tokens that cannot be a utility", () => {
    const tokens = tokenizePluginSource(`"  12 . / :: 3.5 ,"`);

    expect(tokens).toEqual([]);
  });

  it("drops tokens longer than the ceiling", () => {
    const long = `x-[${"a".repeat(MAX_TOKEN_LENGTH * 2)}]`;
    const tokens = tokenizePluginSource(`"p-4 ${long}"`);

    expect(tokens).toContain("p-4");
    expect(tokens).not.toContain(long);
  });

  it("stops at the candidate ceiling instead of growing without bound", () => {
    const many = Array.from({ length: MAX_CANDIDATES + 500 }, (_, i) => `p-${i}`).join(" ");

    expect(tokenizePluginSource(`"${many}"`)).toHaveLength(MAX_CANDIDATES);
  });

  it("skips a source larger than the ceiling", () => {
    // The DOM observer still covers an oversized bundle; what must not happen is
    // a multi-megabyte scan on the mount path.
    expect(tokenizePluginSource(`"p-4"`.padEnd(MAX_SOURCE_BYTES + 1, " "))).toEqual([]);
  });

  it("returns nothing for empty source", () => {
    expect(tokenizePluginSource("")).toEqual([]);
  });

  it("survives unbalanced quotes and brackets without throwing", () => {
    expect(() => tokenizePluginSource(`"p-4 [unclosed`)).not.toThrow();
    expect(() => tokenizePluginSource("`p-4 ${unclosed")).not.toThrow();
  });
});
