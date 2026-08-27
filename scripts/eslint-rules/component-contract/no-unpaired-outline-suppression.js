/**
 * ESLint rule: no-unpaired-outline-suppression
 *
 * An element that suppresses its focus outline must paint a replacement. Without
 * one it simply vanishes from keyboard navigation, and nothing about the class
 * string says so.
 *
 * This mirrors `src/config/__tests__/focusRingFallback.contract.test.ts`, which
 * remains the authoritative gate: it scans `plugins/**` as well as `src/**`,
 * carries a reviewed allowlist of the elements that legitimately delegate focus
 * to a wrapper, and covers a second trap this rule does not — `--tw-outline-style`
 * does not inherit, so `outline-hidden` and `focus-visible:outline-2` on the same
 * element resolve to nothing painted at all. What the lint rule adds is latency:
 * the squiggle lands as you type rather than on the next full test run, and the
 * opt-out sits on the line it excuses instead of in a central array.
 *
 * Flagged:
 *   - `outline-hidden` where the class expression carries no element-owned focus
 *     treatment. The whole expression counts — a fallback in a sibling `cn()`
 *     argument or the other arm of a ternary satisfies it, because that is how
 *     the codebase actually writes them.
 *   - `outline-none` always, and separately. Tailwind v4 changed it to emit a
 *     bare `outline-style: none`, dropping the transparent outline that keeps a
 *     focus indicator paintable in forced-colors mode; `outline-hidden` is the
 *     spelling that kept v3's behaviour.
 *
 * `group-focus`/`peer-focus` do not count as a fallback — they describe a parent
 * or sibling's state, not focus on this element — matching the precedent in
 * `accentGuard.contract.test.ts`. `data-[macro-focus=…]` does count: it is the
 * codebase's own mechanism for regions whose focus is owned by app state.
 *
 * Opt out with:
 *   // eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- <reason>
 *
 * See docs/themes/component-contract.md.
 */

import { createClassExpressionVisitor, normalizeToken } from "./classStrings.js";

/** Element-owned focus variants. The lookbehind keeps `group-focus`/`peer-focus` out. */
const ELEMENT_FOCUS_VARIANT = /(?<![\w-])focus(?:-visible|-within)?(?![\w-])/;
const MACRO_FOCUS_VARIANT = /data-\[macro-focus/;

/** Utilities that hide a focus indicator rather than paint one. */
const SUPPRESSORS = new Set([
  "outline-hidden",
  "outline-none",
  "outline-0",
  "ring-0",
  "border-transparent",
]);

function isFocusFallback(token) {
  const { variants, base } = normalizeToken(token);
  if (!variants) return false;
  if (SUPPRESSORS.has(base)) return false;
  return ELEMENT_FOCUS_VARIANT.test(variants) || MACRO_FOCUS_VARIANT.test(variants);
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Require a replacement focus treatment wherever the outline is suppressed",
      recommended: true,
    },
    schema: [],
    messages: {
      unpaired:
        "`{{token}}` removes the focus outline with nothing painted in its place, so the element disappears for keyboard users. Add an element-owned focus treatment (e.g. `focus-visible:ring-2 focus-visible:ring-accent-primary`). Elements that delegate focus to a wrapper opt out with `// eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- <reason>`.",
      unsafeOutlineNone:
        "`outline-none` emits a bare `outline-style: none` in Tailwind v4, which leaves forced-colors mode with no outline to recolour. Use `outline-hidden`, which keeps the transparent outline v3 painted. Genuine exceptions opt out with `// eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- <reason>`.",
    },
  },

  create(context) {
    return createClassExpressionVisitor(context, (entries) => {
      const hasFallback = entries.some(({ token }) => isFocusFallback(token));

      for (const { token, node } of entries) {
        const { base } = normalizeToken(token);
        if (base === "outline-none") {
          context.report({ node, messageId: "unsafeOutlineNone" });
        } else if (base === "outline-hidden" && !hasFallback) {
          context.report({ node, messageId: "unpaired", data: { token } });
        }
      }
    });
  },
};
