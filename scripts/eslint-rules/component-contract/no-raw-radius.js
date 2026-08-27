/**
 * ESLint rule: no-raw-radius
 *
 * Keeps corner radii on the `--radius-*` scale. `src/index.css` derives every
 * step from one base — `--radius: calc(0.625rem * var(--theme-radius-scale, 1))`
 * — so a theme can scale the whole app's corners at once. A hardcoded bracket
 * value opts that element out silently.
 *
 * Bare `rounded` is the subtler half. Tailwind documents it as 0.25rem, and it
 * reads that way to anyone who knows Tailwind — but the utility resolves through
 * `--radius`, which this repo overrides, so it actually renders the `rounded-lg`
 * value and tracks the theme's radius scale. 500 uses is a lot of code whose
 * corner size is not what it appears to say. Name the step you mean.
 *
 * Flagged:
 *   - bare `rounded` and bare side variants (`rounded-t`, `rounded-br`, …)
 *   - arbitrary values that hardcode a radius rather than reading a custom
 *     property — `rounded-[2px]`, `rounded-l-[1.5px]`, `rounded-[0]`,
 *     `rounded-[calc(2px)]`, `rounded-[2px_4px]`
 *
 * Not flagged:
 *   - the named scale `rounded-xs` … `rounded-3xl`, which IS the token scale:
 *     `@theme inline` compiles `rounded-md` to `calc(var(--radius) - 2px)`. Stops
 *     at `3xl` because that is where `src/index.css` stops redefining; Tailwind's
 *     stock `rounded-4xl` is a fixed 2rem that no theme can scale.
 *   - `rounded-[var(--radius-md)]`, the same value spelled explicitly — the
 *     codebase's prevailing idiom, and token-backed either way
 *   - `rounded-full` and `rounded-none` (and their side variants), which are
 *     shape decisions rather than points on a scale
 *
 * Opt out with:
 *   // eslint-disable-next-line component-contract/no-raw-radius -- <reason>
 *
 * See docs/themes/component-contract.md.
 */

import { createClassExpressionVisitor, normalizeToken } from "./classStrings.js";
import { arbitraryBody } from "./fontSize.js";

const SIDES = new Set([
  "t",
  "r",
  "b",
  "l",
  "tl",
  "tr",
  "bl",
  "br",
  "s",
  "e",
  "ss",
  "se",
  "es",
  "ee",
]);
/** The steps `src/index.css` actually redefines from `--radius`. */
const NAMED_SCALE = /^(?:xs|sm|md|lg|xl|2xl|3xl)$/;
const SHAPE = /^(?:full|none)$/;

/** Strip `rounded` and any side segment, returning the scale value (`""` when absent). */
function radiusValue(base) {
  if (base === "rounded") return "";
  if (!base.startsWith("rounded-")) return null;

  let value = base.slice("rounded-".length);
  const dash = value.indexOf("-");
  const head = dash === -1 ? value : value.slice(0, dash);
  if (SIDES.has(head)) value = dash === -1 ? "" : value.slice(dash + 1);
  return value;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Keep corner radii on the `--radius-*` scale",
      recommended: true,
    },
    schema: [],
    messages: {
      unnamedStep:
        "`{{token}}` leaves the radius step unnamed. It resolves through `--radius`, so it renders the `rounded-lg` value rather than Tailwind's documented 0.25rem — say which step you mean. Genuine exceptions opt out with `// eslint-disable-next-line component-contract/no-raw-radius -- <reason>`.",
      hardcoded:
        "`{{token}}` hardcodes a radius, so it ignores `--theme-radius-scale` and will not move when a theme scales the app's corners. Use a step on the `--radius-*` scale. Genuine exceptions opt out with `// eslint-disable-next-line component-contract/no-raw-radius -- <reason>`.",
    },
  },

  create(context) {
    return createClassExpressionVisitor(context, (entries) => {
      for (const { token, node } of entries) {
        const { base } = normalizeToken(token);
        const value = radiusValue(base);
        if (value === null) continue;

        if (value === "") {
          context.report({ node, messageId: "unnamedStep", data: { token: base } });
          continue;
        }
        if (SHAPE.test(value) || NAMED_SCALE.test(value)) continue;

        const body = arbitraryBody(value);
        if (body === null) {
          // A named step this repo never redefines, so it keeps Tailwind's fixed
          // value (`rounded-4xl` is 2rem) and no theme can scale it.
          context.report({ node, messageId: "hardcoded", data: { token: base } });
          continue;
        }
        // Any arbitrary radius that never reads a custom property is a literal
        // value — `[0]`, `[calc(2px)]` and `[2px_4px]` all bypass the scale
        // exactly as `[2px]` does.
        if (!body.includes("var(") && !body.startsWith("--")) {
          context.report({ node, messageId: "hardcoded", data: { token: base } });
        }
      }
    });
  },
};
