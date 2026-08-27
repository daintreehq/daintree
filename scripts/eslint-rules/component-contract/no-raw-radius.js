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
 *   - hardcoded lengths — `rounded-[2px]`, `rounded-l-[1.5px]`
 *
 * Not flagged:
 *   - the named scale (`rounded-sm` … `rounded-3xl`), which IS the token scale:
 *     `@theme inline` compiles `rounded-md` to `calc(var(--radius) - 2px)`
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
const NAMED_SCALE = /^(?:xs|sm|md|lg|xl|[2-9]xl)$/;
const SHAPE = /^(?:full|none)$/;
const LENGTH = /^-?(?:\d*\.)?\d+(?:px|rem|em|pt|ch|ex|vw|vh|vmin|vmax|%)$/;

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

        if (value.startsWith("[") && value.endsWith("]")) {
          if (LENGTH.test(value.slice(1, -1))) {
            context.report({ node, messageId: "hardcoded", data: { token: base } });
          }
        }
      }
    });
  },
};
