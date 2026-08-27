/**
 * ESLint rule: no-text-color-slash-alpha
 *
 * Bans slash-alpha on text-colour utilities (`text-text-secondary/70`). Tailwind
 * v4 compiles the alpha into `color-mix(in oklab, <token> N%, transparent)` on
 * the `color` property itself, so the text is composited against whatever sits
 * behind it and the contrast loss is baked in — `opacity: 1` further down the
 * tree cannot recover it. De-emphasise with a solid token one step down the text
 * hierarchy (`text-text-secondary`, `text-text-muted`) instead.
 *
 * This is not theoretical: `src/index.css` already carries a
 * `[class*="text-daintree-text/"] { color: … !important }` override inside the
 * `prefers-contrast: more` block, added to claw back the legibility this pattern
 * costs under macOS Increase Contrast. The rule stops the override's surface
 * area from growing.
 *
 * Flagged in every position, variant-prefixed forms included — `hover:` alpha
 * fades the label exactly as hard as base alpha does, and the production
 * override above matches on a substring precisely because it has to catch both.
 *
 * Not flagged:
 *   - `bg-…/N`, `border-…/N`, `ring-…/N` — surface and edge tinting composite
 *     against a known background; that ladder is the `overlay-*` design, not debt.
 *   - the font-size/line-height shorthand (`text-sm/6`, `text-[11px]/4`), where
 *     the slash separates a leading rather than an alpha.
 *
 * Opt out with:
 *   // eslint-disable-next-line component-contract/no-text-color-slash-alpha -- <reason>
 *
 * See docs/themes/component-contract.md.
 */

import { createClassExpressionVisitor, normalizeToken } from "./classStrings.js";

/** Tailwind's stock type scale — the left side of a size/leading shorthand. */
const TYPE_SCALE = /^(?:xs|sm|base|lg|xl|[2-9]xl)$/;

/** A bracket holding a bare length, i.e. an arbitrary font size rather than a colour. */
const ARBITRARY_LENGTH =
  /^\[(?:length:)?-?(?:\d*\.)?\d+(?:px|rem|em|pt|ch|ex|vw|vh|vmin|vmax|%)\]$/;

/** Split on the last `/` outside brackets, so `text-[url(a/b)]/50` splits once, correctly. */
function splitAlpha(base) {
  let depth = 0;
  let lastSlash = -1;
  for (let i = 0; i < base.length; i++) {
    const ch = base[i];
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === "/" && depth === 0) lastSlash = i;
  }
  if (lastSlash === -1) return null;
  return { value: base.slice(0, lastSlash), alpha: base.slice(lastSlash + 1) };
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow slash-alpha on text-colour utilities; use a solid text token",
      recommended: true,
    },
    schema: [],
    messages: {
      slashAlpha:
        "`{{token}}` fades text with slash-alpha. Tailwind v4 bakes the alpha into `color-mix()` on the `color` property, so the lost contrast cannot be recovered downstream. Use a solid token one step down the text hierarchy (`text-text-secondary`, `text-text-muted`). Genuine exceptions opt out with `// eslint-disable-next-line component-contract/no-text-color-slash-alpha -- <reason>`.",
    },
  },

  create(context) {
    return createClassExpressionVisitor(context, (entries) => {
      for (const { token, node } of entries) {
        const { base } = normalizeToken(token);
        if (!base.startsWith("text-")) continue;

        const split = splitAlpha(base.slice("text-".length));
        if (!split) continue;
        if (TYPE_SCALE.test(split.value) || ARBITRARY_LENGTH.test(split.value)) continue;

        context.report({ node, messageId: "slashAlpha", data: { token: base } });
      }
    });
  },
};
