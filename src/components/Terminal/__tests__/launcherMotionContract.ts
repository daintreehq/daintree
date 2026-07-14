import { readFileSync } from "fs";
import { resolve } from "path";
import { buttonVariants } from "@/components/ui/button";

/**
 * Shared motion contracts for the empty-grid launcher (issue #11169). Both
 * helpers derive their expectation from a source of truth rather than restating
 * it, so a change to the canonical recipe fails the launcher's tests instead of
 * quietly diverging from it.
 */

/**
 * Every class name the app's `@variant reduce-motion` blocks neutralize.
 *
 * That block is the only thing that reads Daintree's in-app reduce-animations
 * toggle (a `body` attribute), so it is the authority on which motion that
 * toggle can actually stop. Tailwind's `motion-safe:` variant sees only the OS
 * preference, and no Tailwind variant can reach the body attribute from a
 * utility class — so a launcher animation is suppressible by the in-app toggle
 * if, and only if, one of its class names is named in this block.
 */
export const reduceMotionSelectors = (): Set<string> => {
  const css = readFileSync(resolve(__dirname, "../../../index.css"), "utf-8");
  const classes = new Set<string>();

  const MARKER = "@variant reduce-motion";
  for (let i = css.indexOf(MARKER); i !== -1; i = css.indexOf(MARKER, i + 1)) {
    let depth = 0;
    for (let k = css.indexOf("{", i); k < css.length; k++) {
      if (css[k] === "{") depth++;
      if (css[k] === "}" && --depth === 0) {
        for (const [, name] of css.slice(i, k).matchAll(/\.(-?[a-zA-Z][\w-]*)/g)) {
          classes.add(name);
        }
        break;
      }
    }
  }
  return classes;
};

/**
 * The press treatment every shared `Button` inherits, read out of the cva
 * itself rather than copied: the `ghost` variant contributes no `active:`
 * classes of its own, so what survives is exactly the base press recipe.
 *
 * The launcher's recipe cards and quick actions are hand-rolled buttons, not
 * `Button`, so nothing makes them inherit this — which is what these assertions
 * are for.
 */
export const basePressTreatment = (): string[] =>
  buttonVariants({ variant: "ghost" })
    .split(/\s+/)
    .filter((token) => token.startsWith("active:"));

/** Class names that widen a transition set to cover the press transform. */
export const TRANSITION_WIDENERS = ["transition", "transition-all", "transition-transform"];
