/**
 * ESLint rule: no-arbitrary-text-size
 *
 * Bans arbitrary font sizes (`text-[11px]`). The type scale is Tailwind's stock
 * `--text-*` steps; this repo overrides none of them. An arbitrary pixel value
 * is invisible to that scale, does not move when the scale does, and — because
 * the values cluster one or two pixels apart — produces sizes nobody chose:
 * 9px, 10px, 11px, 12px and 13px are all in use where the scale offers two steps.
 *
 * When a design genuinely needs a step the scale lacks (the 10-11px label sizes
 * are the real case here), add a named step to the `@theme` block in
 * `src/index.css` — `--text-2xs` — and use it. That keeps one list of legal
 * sizes instead of an open set of brackets.
 *
 * Flagged: `text-[<length>]` and the explicit `text-[length:…]` hint, in any
 * variant position, including the size half of a size/leading shorthand.
 *
 * Not flagged: arbitrary *colours*, which share the `text-[…]` spelling —
 * `text-[#0b1220]`, `text-[red]`, `text-[CanvasText]`, `text-[var(--x)]`,
 * `text-[color:var(--x)]`, `text-[color-mix(…)]`. Only a bare length reads as
 * a font size.
 *
 * Opt out with:
 *   // eslint-disable-next-line component-contract/no-arbitrary-text-size -- <reason>
 *
 * See docs/themes/component-contract.md.
 */

import { createClassExpressionVisitor, normalizeToken } from "./classStrings.js";

const LENGTH = /^-?(?:\d*\.)?\d+(?:px|rem|em|pt|ch|ex|vw|vh|vmin|vmax|%)$/;

/** The `text-[…]` bracket, ignoring any `/leading` suffix that follows it. */
const ARBITRARY_TEXT = /^text-\[([^\]]*)\](?:\/[^/]*)?$/;

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow arbitrary font sizes; use a named step on the type scale",
      recommended: true,
    },
    schema: [],
    messages: {
      arbitrarySize:
        "`{{token}}` sets a font size off the type scale. Use a named step (`text-xs`, `text-sm`, …), or add one to the `@theme` block in `src/index.css` if the scale genuinely lacks it. Genuine exceptions opt out with `// eslint-disable-next-line component-contract/no-arbitrary-text-size -- <reason>`.",
    },
  },

  create(context) {
    return createClassExpressionVisitor(context, (entries) => {
      for (const { token, node } of entries) {
        const { base } = normalizeToken(token);
        const match = ARBITRARY_TEXT.exec(base);
        if (!match) continue;

        const value = match[1];
        const isLength = value.startsWith("length:") || LENGTH.test(value);
        if (!isLength) continue;

        context.report({ node, messageId: "arbitrarySize", data: { token: base } });
      }
    });
  },
};
