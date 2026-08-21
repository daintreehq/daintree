import { describe, expect, it } from "vitest";
import { refractor } from "refractor/core";
import bash from "refractor/bash";
import css from "refractor/css";
import javascript from "refractor/javascript";
import jsx from "refractor/jsx";
import json from "refractor/json";
import markdown from "refractor/markdown";
import markup from "refractor/markup";
import tsx from "refractor/tsx";
import typescript from "refractor/typescript";

// diffRefractor swaps refractor's `Token.stringify` for a hand-built node
// factory. That object is Prism's own — `refractor.Token` IS `Prism.Token` —
// so the replacement is global to the renderer and has to be output-identical
// for every language, not just the ones the diff viewer highlights.
//
// The stock implementation therefore has to be captured BEFORE diffRefractor's
// module side effect lands. ESM evaluates all static imports ahead of any
// module body, so diffRefractor is the one import pulled in dynamically, from
// inside the test, after the reference outputs are computed.

interface StringifyApi {
  Token: { stringify: unknown };
}

const CASES: ReadonlyArray<{ language: string; code: string }> = [
  {
    // Entity tokens: markup's `wrap` hook writes a `title` attribute, which is
    // the one condition that must hand the token back to refractor.
    language: "markup",
    code: [
      '<a href="/x?a=1&amp;b=2" title="x &lt; y" data-empty="">Tom &amp; Jerry</a>',
      "<!-- a comment with &nbsp; -->",
      "<input disabled/>",
    ].join("\n"),
  },
  {
    language: "jsx",
    code: [
      "const El = () => (",
      '  <section className="a b" aria-label="x &amp; y">',
      "    {items.map((i) => (",
      "      <Row key={i.id} {...i} onClick={() => go(i)}>",
      "        &lt;{i.label}&gt;",
      "      </Row>",
      "    ))}",
      "  </section>",
      ");",
    ].join("\n"),
  },
  {
    // Fenced code block: markdown's `wrap` hook replaces `env.content` wholesale
    // with a highlighted Root, exercising the array/root flattening path.
    language: "markdown",
    code: [
      "# Title",
      "",
      "Some *emphasis*, a [link](https://example.com) and `inline code`.",
      "",
      "```js",
      "const x = { a: 1 };",
      "export default x;",
      "```",
      "",
      "> quoted &amp; escaped",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
    ].join("\n"),
  },
  {
    language: "typescript",
    code: [
      "export interface Shape<T extends object = {}> {",
      "  readonly id: `${string}-${number}`;",
      "  fn?(arg: T | null): Promise<T[]>;",
      "}",
      'const s = "a\\nb" as const; // trailing',
      "enum E { A = 1, B }",
    ].join("\n"),
  },
  {
    language: "tsx",
    code: [
      "function C<T,>({ v }: { v: T }) {",
      "  return <div title={String(v)}>{v as unknown as string}</div>;",
      "}",
    ].join("\n"),
  },
  {
    language: "javascript",
    code: [
      "async function* gen(n = 0) {",
      "  yield* [1, 2, 3].map((x) => x ** n);",
      "}",
      "/* block */ const re = /a[b-c]+/giu;",
    ].join("\n"),
  },
  {
    language: "css",
    code: [
      ":root { --c: oklch(0.7 0.1 200); }",
      "@media (prefers-contrast: more) { .a > .b::after { content: '\\201C'; } }",
    ].join("\n"),
  },
  {
    language: "json",
    code: '{"a": [1, 2.5e3, true, null], "b": {"c": "d\\"e"}}',
  },
  {
    language: "bash",
    code: [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'for f in "$@"; do',
      '  printf \'%s\\n\' "${f//a/b}" | grep -E "^x" || true',
      "done",
    ].join("\n"),
  },
];

describe("fast token stringify", () => {
  it("emits the tree refractor's own stringify would, for every language", async () => {
    for (const lang of [bash, css, javascript, jsx, json, markdown, markup, tsx, typescript]) {
      refractor.register(lang);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Token is a Prism internal refractor does not surface on its own type
    const api = refractor as unknown as StringifyApi;
    const stockStringify = api.Token.stringify;
    const stock = CASES.map((c) => refractor.highlight(c.code, c.language).children);

    await import("../diffRefractor");

    expect(api.Token.stringify).not.toBe(stockStringify);
    const fast = CASES.map((c) => refractor.highlight(c.code, c.language).children);

    for (let i = 0; i < CASES.length; i += 1) {
      expect(fast[i], `${CASES[i]!.language} diverged`).toEqual(stock[i]);
    }
  });
});
