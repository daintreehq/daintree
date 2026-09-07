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
 * This is not theoretical: the host CSS already carries a
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
 *     the slash separates a leading rather than an alpha. The size test is shared
 *     with `no-arbitrary-text-size` so the two rules cannot disagree about which
 *     `text-*` values are sizes.
 *   - `text-shadow-*`, whose modifier is a shadow alpha, not the glyph colour.
 *
 * Opt out with:
 *   // eslint-disable-next-line component-contract/no-text-color-slash-alpha -- <reason>
 *
 * See docs/themes/component-contract.md.
 */

import { createClassExpressionVisitor, normalizeToken, splitModifier } from "./classStrings.js";
import { isFontSizeValue } from "./fontSize.js";

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
        if (!base.startsWith("text-") || base.startsWith("text-shadow-")) continue;

        const split = splitModifier(base.slice("text-".length));
        if (!split) continue;
        if (isFontSizeValue(split.value)) continue;

        context.report({ node, messageId: "slashAlpha", data: { token: base } });
      }
    });
  },
};
