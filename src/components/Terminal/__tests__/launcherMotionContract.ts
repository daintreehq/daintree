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
  // Comments are stripped first, or a class merely *mentioned* in prose would
  // count as neutralized — which would let this contract pass against a rule
  // that no longer exists.
  const css = readFileSync(resolve(__dirname, "../../../index.css"), "utf-8").replace(
    /\/\*[\s\S]*?\*\//g,
    ""
  );
  const classes = new Set<string>();

  const MARKER = "@variant reduce-motion";
  for (let i = css.indexOf(MARKER); i !== -1; i = css.indexOf(MARKER, i + 1)) {
    let depth = 0;
    for (let k = css.indexOf("{", i); k < css.length; k++) {
      if (css[k] === "{") depth++;
      if (css[k] === "}" && --depth === 0) {
        // Selector text only — the chunk preceding each `{`. A class name that
        // appears inside a declaration value is not a rule, and must not count.
        for (const rule of css.slice(i, k).matchAll(/(?:^|[};])([^{};]*)\{/g)) {
          const selectorText = rule[1] ?? "";
          for (const name of selectorText.matchAll(/\.(-?[a-zA-Z][\w-]*)/g)) {
            if (name[1]) classes.add(name[1]);
          }
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

/**
 * Does this class pull a transform property into the element's transition set?
 *
 * If it does, the press scale interpolates over the shared 150ms instead of
 * snapping. Variant prefixes are stripped first, and arbitrary lists are read,
 * so `md:transition-all` and `transition-[opacity,scale]` are both caught.
 */
export const widensTransitionToTransform = (cls: string): boolean => {
  const utility = cls.slice(cls.lastIndexOf(":") + 1);
  if (["transition", "transition-all", "transition-transform"].includes(utility)) return true;

  const properties = /^transition-\[(.+)\]$/.exec(utility)?.[1];
  return properties ? /\b(transform|scale|translate|rotate|all)\b/.test(properties) : false;
};

/** The transform-widening classes on an element, if any. */
export const transitionWideners = (className: string): string[] =>
  className.split(/\s+/).filter(widensTransitionToTransform);
