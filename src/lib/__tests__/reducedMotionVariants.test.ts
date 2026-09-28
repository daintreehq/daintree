/**
 * The in-app "Reduce UI animations" setting sets `body[data-reduce-animations]`.
 * Tailwind's stock `motion-reduce:` / `motion-safe:` read only the OS media
 * query, so every component guarding motion with them ignored the setting until
 * `design-contract.css` redefined both. These compile real utilities through the
 * same compiler the plugin views use (it reads the same contract bytes the host
 * does) and check the output reacts to the app flag, not just the media query.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
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

describe("components guard motion with the utility spelling that works", () => {
  // `reduce-motion` is the at-rule spelling (`@variant reduce-motion { }` in CSS
  // files). As a class prefix its app-flag branch nests under the element and
  // never matches, so components must use `motion-reduce:` instead.
  const roots = ["src", "packages"].map((dir) => path.resolve(__dirname, "../../..", dir));

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) sourceFiles(full, out);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("never uses reduce-motion: as a class prefix", () => {
    const offenders = roots
      .flatMap((root) => sourceFiles(root))
      .filter((file) => /(^|[\s"'`])reduce-motion:[\w[-]/m.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(path.resolve(__dirname, "../../.."), file));
    expect(offenders).toEqual([]);
  });
});
