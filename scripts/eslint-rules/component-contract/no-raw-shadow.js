/**
 * ESLint rule: no-raw-shadow
 *
 * Keeps box shadows on the theme's shadow tokens. Tailwind's stock scale —
 * `shadow-sm` through `shadow-2xl`, `shadow-inner`, `inset-shadow-xs` — is
 * drawn in fixed black, so on a light theme it lands as a grey smudge instead
 * of the cool-slate shadow the theme defines. The tokens are:
 *
 *   - `shadow-[var(--theme-shadow-ambient)]`  resting lift (a selected card, a switch thumb)
 *   - `shadow-[var(--theme-shadow-floating)]` anything floating over content
 *   - `shadow-[var(--theme-shadow-dialog)]`   dialogs and overlay side sheets
 *   - `shadow-overlay` / `shadow-modal`       the popover and modal stacks
 *   - `shadow-[var(--shadow-inset)]`          a pressed or recessed well
 *
 * `src/components/ui/floatingSurface.ts` holds the floating-card chrome.
 *
 * Flagged: bare `shadow` and `inset-shadow`, and every step of Tailwind's stock
 * scale for both.
 *
 * Not flagged: `shadow-none`, arbitrary values (`shadow-[...]`, `shadow-(...)`),
 * the repo's own named shadows, and shadow colour utilities (`shadow-tint/10`).
 *
 * Opt out with:
 *   // eslint-disable-next-line component-contract/no-raw-shadow -- <reason>
 *
 * See docs/themes/component-contract.md.
 */

import { createClassExpressionVisitor, normalizeToken } from "./classStrings.js";

const STOCK = /^(?:inset-)?shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl|inner))?$/;

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Keep box shadows on the theme's shadow tokens",
      recommended: true,
    },
    schema: [],
    messages: {
      stock:
        "`{{token}}` is Tailwind's stock black shadow, so light themes lose their cool-slate shadow source. Use a theme token: `shadow-[var(--theme-shadow-ambient)]`, `shadow-[var(--theme-shadow-floating)]`, `shadow-[var(--theme-shadow-dialog)]` or `shadow-[var(--shadow-inset)]`. Genuine exceptions opt out with `// eslint-disable-next-line component-contract/no-raw-shadow -- <reason>`.",
    },
  },

  create(context) {
    return createClassExpressionVisitor(context, (entries) => {
      for (const { token, node } of entries) {
        // `shadow-sm/20` is still the stock black shadow, just fainter.
        const base = normalizeToken(token).base.replace(/\/[^/]*$/, "");
        if (STOCK.test(base)) {
          context.report({ node, messageId: "stock", data: { token: base } });
        }
      }
    });
  },
};
