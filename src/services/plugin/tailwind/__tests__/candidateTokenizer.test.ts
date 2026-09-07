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
      `"w-[327px] grid-cols-[1fr_auto] shadow-[0_1px_2px_rgb(0,0,0,.1)] bg-[url('a_b.png')]"`
    );

    expect(tokens).toContain("w-[327px]");
    expect(tokens).toContain("grid-cols-[1fr_auto]");
    expect(tokens).toContain("shadow-[0_1px_2px_rgb(0,0,0,.1)]");
    // Quotes and parens are not candidate characters, so this one only survives
    // by bracket depth. Tailwind spells the space as `_` because `class` is split
    // on whitespace — a literal space here could never have matched an element.
    expect(tokens).toContain("bg-[url('a_b.png')]");
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

  it("never emits a token carrying whitespace, however the brackets are abused", () => {
    // A `[...]` run swallows every character while it is open, so one spanning a
    // line break used to yield a token with a RAW NEWLINE inside it. The compiler
    // serialises that verbatim, the newline ends the CSS declaration as a
    // bad-string, and the rest of the token then closes the `@scope` and `@layer`
    // that contain it — putting a plugin's rule on host chrome. A class attribute
    // is split on ASCII whitespace, so such a token can never match anything
    // anyway; the only thing it can do is break out.
    const sources = [
      "const x = `[content:'\n}}}html{display:none}/*']`;",
      "\"[content:'\t}}}html{display:none}/*']\"",
      "`p-[1px\r] gap-2`",
    ];

    for (const source of sources) {
      for (const token of tokenizePluginSource(source)) {
        expect(/\s/.test(token), `token carries whitespace: ${JSON.stringify(token)}`).toBe(false);
      }
    }

    // …and only the malformed token is lost; its neighbours still compile.
    expect(tokenizePluginSource("`p-[1px\r] gap-2`")).toContain("gap-2");
  });
});

describe("tokenizePluginSource — staying in sync with JavaScript's lexical structure", () => {
  it("does not let a quote inside a regex literal swallow the next real string", () => {
    // The failure this guards is not a miss but an INVERSION: the quote in the
    // regex reads as an opener, so the next string's opening quote reads as its
    // closer and every literal after it is inside-out. On a minified single-line
    // bundle that is most of the file.
    expect(tokenizePluginSource(`const re = /"/; const cls = "p-4 gap-2";`)).toEqual(
      expect.arrayContaining(["p-4", "gap-2"])
    );
    expect(tokenizePluginSource(`s.replace(/'/g, ""); const c = "rounded-md";`)).toContain(
      "rounded-md"
    );
  });

  it("reads division after an increment as division", () => {
    // `++` ends an expression, so the `/` after it divides. Judging on the single
    // previous character (`+`) reads it as opening a regex, which then runs to
    // end of file and takes every class after it.
    expect(tokenizePluginSource(`const n = i++ / divisor; const cls = "gap-2";`)).toContain(
      "gap-2"
    );
    expect(tokenizePluginSource(`const n = i-- / d; const cls = "p-4";`)).toContain("p-4");
    // …while a genuine regex after `+` is still a regex.
    expect(tokenizePluginSource(`const n = 1 + /"/.source; const cls = "m-2";`)).toContain("m-2");
  });

  it("still reads division as division", () => {
    // The regex heuristic must not swing the other way and treat `/` in an
    // expression as opening a literal that runs to the next slash.
    expect(tokenizePluginSource(`const w = total / count; const c = "p-4";`)).toContain("p-4");
    expect(tokenizePluginSource(`const w = (a) / (b); const c = "gap-2";`)).toContain("gap-2");
  });

  it("ignores strings and apostrophes inside comments", () => {
    expect(tokenizePluginSource(`// it's a "comment" with p-99\nconst c = "p-4";`)).not.toContain(
      "p-99"
    );
    expect(tokenizePluginSource(`/* "block" it's fine */\nconst c = "gap-2";`)).toContain("gap-2");
    // …and the code after a comment is still read.
    expect(tokenizePluginSource(`// it's fine\nconst c = "p-4";`)).toContain("p-4");
  });

  it("balances interpolation braces around a string containing a brace", () => {
    // `}` inside a string used to close the interpolation early, after which the
    // nested template's opener was mistaken for the outer template's closer.
    const tokens = tokenizePluginSource('`before ${obj["}"] ? `p-4` : `m-2`} gap-2`');

    expect(tokens).toContain("p-4");
    expect(tokens).toContain("m-2");
    expect(tokens).toContain("gap-2");
  });

  it("survives deeply nested templates without exhausting the stack", () => {
    // Recursion here overflowed at a few thousand levels and rescanned each
    // parent expression — a synchronous stall on the mount path for a pass that
    // is only ever an optimisation.
    const source = "`${".repeat(5000) + '"p-4"' + "}`".repeat(5000);

    expect(() => tokenizePluginSource(source)).not.toThrow();
    expect(tokenizePluginSource(source)).toContain("p-4");
  });

  it("reads classes that follow an unterminated construct", () => {
    // Truncated or unusual source must cost the classes after it, not the file.
    expect(tokenizePluginSource(`const a = /unterminated\nconst c = "p-4";`)).toContain("p-4");
  });
});
