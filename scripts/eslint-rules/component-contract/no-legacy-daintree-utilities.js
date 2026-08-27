/**
 * ESLint rule: no-legacy-daintree-utilities
 *
 * Bans the legacy `daintree-*` colour vocabulary. `--color-daintree-*` in
 * `src/index.css` is a thin alias layer over the semantic tokens the theme
 * system actually validates — `--color-daintree-text` is nothing but
 * `var(--theme-text-primary)` under an older name. Two names for one token
 * means neither reads as canonical, and the alias layer covers five tokens
 * against the semantic layer's 155, so anything outside those five has no
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

import { createClassExpressionVisitor, normalizeToken, splitModifier } from "./classStrings.js";

/**
 * Legacy alias → the semantic token that replaces it, as spelled in a utility.
 *
 * Seven entries against five live aliases: `daintree-accent-rgb` and
 * `daintree-focus` were deleted from `src/index.css` once their last call sites
 * went, so a utility naming either now generates no CSS at all. They stay mapped
 * on purpose — that failure is worse than vocabulary mixing, and it deserves the
 * named replacement rather than the generic `unmapped` message.
 */
const REPLACEMENTS = new Map([
  ["daintree-text", "text-primary"],
  ["daintree-bg", "surface-canvas"],
  ["daintree-sidebar", "surface-sidebar"],
  ["daintree-border", "border-default"],
  ["daintree-accent", "accent-primary"],
  ["daintree-accent-rgb", "accent-rgb"],
  ["daintree-focus", "focus-ring"],
]);

const LEGACY_UTILITY = /^([a-z]+(?:-[a-z]+)*)-(daintree-[a-z0-9-]+)$/;

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
        // Split the alpha modifier off first: it can itself hold a slash
        // (`/[calc(1/2)]`), which a single regex cannot bound safely.
        const split = splitModifier(base);
        const utility = split?.value ?? base;
        const alpha = split ? `/${split.modifier}` : "";

        const match = LEGACY_UTILITY.exec(utility);
        if (!match) continue;

        const [, prefix, alias] = match;
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
