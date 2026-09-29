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
 * Flagged: bare `shadow` and `inset-shadow`, every step of Tailwind's stock
 * scale for both, and an arbitrary box shadow that reads no custom property
 * (`shadow-[0_2px_8px_rgba(0,0,0,.3)]`), which hardcodes its colour just as
 * the stock scale does.
 *
 * Not flagged: `shadow-none`, arbitrary shadows that read a token
 * (`shadow-[var(--theme-shadow-floating)]`, `shadow-(--my-shadow)`), the repo's
 * own named shadows, shadow colour utilities (`shadow-tint/10`), and arbitrary
 * `inset-shadow-[...]`, which this repo uses for a white top-edge bevel rather
 * than a shadow.
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
      hardcoded:
        "`{{token}}` hardcodes its shadow colour, so it will not follow the theme. Read a theme token instead: `shadow-[var(--theme-shadow-floating)]` and its siblings. Genuine exceptions opt out with `// eslint-disable-next-line component-contract/no-raw-shadow -- <reason>`.",
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
        } else if (base.startsWith("shadow-[")) {
          const body = base.slice("shadow-[".length, -1);
          if (!body.includes("var(") && !body.startsWith("--")) {
            context.report({ node, messageId: "hardcoded", data: { token: base } });
          }
        }
      }
    });
  },
};
