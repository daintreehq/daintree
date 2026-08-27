/**
 * ESLint rule: no-unpaired-outline-suppression
 *
 * An element that suppresses its focus outline must paint a replacement. Without
 * one it simply vanishes from keyboard navigation, and nothing about the class
 * string says so.
 *
 * This mirrors `src/config/__tests__/focusRingFallback.contract.test.ts`, which
 * remains the authoritative gate: it fails the build, scans the GitHub plugin
 * renderer as well as `src/**`, carries a 44-entry allowlist of the elements that
 * legitimately delegate focus to a wrapper, and covers a second trap this rule
 * does not — `--tw-outline-style` does not inherit, so `outline-hidden` and
 * `focus-visible:outline-2` on the same element resolve to nothing painted at
 * all. What the lint rule adds is latency: the squiggle lands as you type rather
 * than on the next full test run, and the opt-out sits on the line it excuses
 * instead of in a central array.
 *
 * Running both means a genuinely new exception has to be recorded twice — an
 * inline disable here and an allowlist entry there. Consolidating the two onto
 * one shared predicate is worth doing and is not done yet.
 *
 * Flagged:
 *   - `outline-hidden`, and `outline-0` which zeroes the width to the same effect,
 *     where the class expression carries no element-owned focus treatment. The whole expression counts — a fallback in a sibling `cn()`
 *     argument or the other arm of a ternary satisfies it, because that is how
 *     the codebase actually writes them.
 *   - `outline-none` always, and separately. Tailwind v4 changed it to emit a
 *     bare `outline-style: none`, dropping the transparent outline that keeps a
 *     focus indicator paintable in forced-colors mode; `outline-hidden` is the
 *     spelling that kept v3's behaviour.
 *
 * A fallback has to be element-owned AND actually paint something. The variant
 * chain is split into segments and each is classified on its own, so a descendant
 * or sibling state that merely mentions focus — `group-focus`, `peer-focus`,
 * `group-has-[:focus-visible]`, `data-[state=focus]` — is not mistaken for one.
 * `data-[macro-focus=…]` does count: it is the codebase's own mechanism for
 * regions whose focus is owned by app state. The variant also has to carry a
 * visible treatment, so `focus-visible:pointer-events-auto` is not a focus ring.
 *
 * Known limitation, shared with the contract test: the whole class expression is
 * one scope, so a fallback in one arm of a ternary or one `cva()` variant counts
 * for the others too. Branch-sensitive analysis is the contract test's job.
 *
 * Opt out with:
 *   // eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- <reason>
 *
 * See docs/themes/component-contract.md.
 */

import { createClassExpressionVisitor, normalizeToken, variantSegments } from "./classStrings.js";

/** A whole variant segment that means "this element has focus". */
const ELEMENT_FOCUS_SEGMENT = /^focus(?:-visible|-within)?$/;
const MACRO_FOCUS_SEGMENT = /^data-\[macro-focus/;

/** Utility namespaces that paint something a keyboard user can see. */
const PAINTS =
  /^(?:outline|ring|inset-ring|border|bg|shadow|text|decoration|underline|fill|stroke)\b/;

/** Utilities that remove a focus indicator rather than paint one. */
const SUPPRESSORS = new Set([
  "outline-hidden",
  "outline-none",
  "outline-0",
  "ring-0",
  "border-0",
  "border-transparent",
  "ring-transparent",
  "outline-transparent",
  "shadow-none",
]);

/** Suppressors that are themselves reportable when nothing replaces them. */
const REPORTABLE_SUPPRESSORS = new Set(["outline-hidden", "outline-0"]);

/** `outline-[0px]` and friends declare a treatment and then give it no size. */
const ZERO_WIDTH = /^(?:outline|ring|border)-\[0[a-z%]*\]$/;

function isFocusFallback(token) {
  const { variants, base } = normalizeToken(token);
  if (SUPPRESSORS.has(base) || ZERO_WIDTH.test(base) || !PAINTS.test(base)) return false;
  return variantSegments(variants).some(
    (segment) => ELEMENT_FOCUS_SEGMENT.test(segment) || MACRO_FOCUS_SEGMENT.test(segment)
  );
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
        "`{{token}}` removes the focus indicator with nothing painted in its place: the element still takes keyboard focus, but nothing shows where that focus is. Add an element-owned focus treatment (e.g. `focus-visible:ring-2 focus-visible:ring-accent-primary`). Elements that delegate focus to a wrapper opt out with `// eslint-disable-next-line component-contract/no-unpaired-outline-suppression -- <reason>`.",
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
        } else if (REPORTABLE_SUPPRESSORS.has(base) && !hasFallback) {
          context.report({ node, messageId: "unpaired", data: { token } });
        }
      }
    });
  },
};
