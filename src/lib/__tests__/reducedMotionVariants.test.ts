/**
 * The in-app "Reduce UI animations" setting sets `body[data-reduce-animations]`.
 * Tailwind's stock `motion-reduce:` / `motion-safe:` read only the OS media
 * query, so every component guarding motion with them ignored the setting until
 * `design-contract.css` redefined both. These compile real utilities through the
 * same compiler the plugin views use (it reads the same contract bytes the host
 * does) and check the output reacts to the app flag, not just the media query.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  createPluginCssCompiler,
  type PluginCssCompiler,
} from "@/services/plugin/tailwind/pluginTailwindAdapter";

const APP_FLAG = 'body[data-reduce-animations="true"]';

let compiler: PluginCssCompiler;

beforeAll(async () => {
  compiler = await createPluginCssCompiler();
});

/**
 * The compiled rule for `className`, brace-matched. The compiler keeps CSS
 * nesting, so the variant's branches appear inside it as nested rules.
 */
function blockFor(css: string, className: string): string {
  const escaped = className.replace(/([[\]:/.(),])/g, "\\$1");
  const at = css.indexOf(`.${escaped} {`);
  expect(at, `${className} did not compile`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(at, i + 1);
  }
  return css.slice(at);
}

describe("motion variants honour the in-app reduced-motion setting", () => {
  it("motion-reduce: applies under the app flag as well as the OS query", () => {
    const block = blockFor(
      compiler.build(["motion-reduce:transition-none"]),
      "motion-reduce:transition-none"
    );
    expect(block).toContain("prefers-reduced-motion: reduce");
    // The flag must be an ANCESTOR of the element (`&:where(body[…] *)`), and
    // at zero specificity. A bare nested `body[…] { }` compiles to `.x body[…]`,
    // a body inside the element, which silently never matches.
    expect(block).toContain(`&:where(${APP_FLAG} *)`);
    expect(block).not.toMatch(/^\s*body\[data-reduce-animations/m);
  });

  it("motion-safe: stops applying under the app flag", () => {
    const block = blockFor(
      compiler.build(["motion-safe:animate-pulse"]),
      "motion-safe:animate-pulse"
    );
    expect(block).toContain("prefers-reduced-motion: no-preference");
    expect(block).toContain(`&:where(:not(${APP_FLAG} *))`);
  });
});

describe("reduce-motion: works as a utility too", () => {
  // `reduce-motion` is also the at-rule spelling (`@variant reduce-motion { }`
  // in CSS files), and the plugin vocabulary advertises it as a class prefix.
  // As a prefix its bare `body[…] { }` branch nests under the element and never
  // matches, so the ancestor branch is what makes the utility honour the app flag.
  it("carries the app-flag branch as an ancestor of the element", () => {
    const block = blockFor(
      compiler.build(["reduce-motion:transition-none"]),
      "reduce-motion:transition-none"
    );
    expect(block).toContain("prefers-reduced-motion: reduce");
    expect(block).toContain(`&:where(${APP_FLAG} *)`);
  });
});
