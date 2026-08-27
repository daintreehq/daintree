/**
 * ESLint rule: no-legacy-daintree-utilities
 *
 * Bans the legacy `daintree-*` colour vocabulary. `--color-daintree-*` in
 * `src/index.css` is a thin alias layer over the semantic tokens the theme
 * system actually validates — `--color-daintree-text` is nothing but
 * `var(--theme-text-primary)` under an older name. Two names for one token
 * means neither reads as canonical, and the alias layer covers seven tokens
 * against the semantic layer's ~145, so anything outside those seven has no
 * legacy spelling and the codebase mixes vocabularies inside single class
 * strings.
 *
 * Flagged: any utility whose colour segment is a `daintree-*` alias, in every
 * position — `text-daintree-text`, `border-daintree-border`,
 * `hover:bg-daintree-sidebar`, `outline-daintree-accent/40`.
 *
 * Not flagged: `var(--color-daintree-*)` reads inside an arbitrary value
 * (`bg-[color-mix(in_oklab,var(--color-daintree-text)_90%,…)]`). Those are raw
 * custom-property reads rather than utilities, they are far rarer, and folding
 * them in here would double-count the same migration.
 *
 * Opt out with:
 *   // eslint-disable-next-line component-contract/no-legacy-daintree-utilities -- <reason>
 *
 * See docs/themes/component-contract.md.
 */

import { createClassExpressionVisitor, normalizeToken } from "./classStrings.js";

/** Legacy alias → the semantic token that replaces it, as spelled in a utility. */
const REPLACEMENTS = new Map([
  ["daintree-text", "text-primary"],
  ["daintree-bg", "surface-canvas"],
  ["daintree-sidebar", "surface-sidebar"],
  ["daintree-border", "border-default"],
  ["daintree-accent", "accent-primary"],
  ["daintree-accent-rgb", "accent-rgb"],
  ["daintree-focus", "focus-ring"],
]);

const LEGACY_UTILITY = /^([a-z]+(?:-[a-z]+)*)-(daintree-[a-z0-9-]+?)(\/(?:\d{1,3}|\[[^\]]*\]))?$/;

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow the legacy `daintree-*` colour aliases; use the semantic token",
      recommended: true,
    },
    schema: [],
    messages: {
      mapped:
        "`{{token}}` uses the legacy `daintree-*` vocabulary. Use `{{replacement}}` instead. Genuine exceptions opt out with `// eslint-disable-next-line component-contract/no-legacy-daintree-utilities -- <reason>`.",
      unmapped:
        "`{{token}}` uses the legacy `daintree-*` vocabulary. Use the semantic token it aliases (see docs/themes/component-contract.md). Genuine exceptions opt out with `// eslint-disable-next-line component-contract/no-legacy-daintree-utilities -- <reason>`.",
    },
  },

  create(context) {
    return createClassExpressionVisitor(context, (entries) => {
      for (const { token, node } of entries) {
        const { base } = normalizeToken(token);
        const match = LEGACY_UTILITY.exec(base);
        if (!match) continue;

        const [, prefix, alias, alpha = ""] = match;
        const replacement = REPLACEMENTS.get(alias);
        if (replacement) {
          context.report({
            node,
            messageId: "mapped",
            data: { token: base, replacement: `${prefix}-${replacement}${alpha}` },
          });
        } else {
          context.report({ node, messageId: "unmapped", data: { token: base } });
        }
      }
    });
  },
};
