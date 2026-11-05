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

interface CompiledRule {
  selector: string;
  body: string;
  ancestors: string[];
}

// Tailwind 4.3.4 flattens nested variants. Track each rule's enclosing media
// query so these assertions check the same conditions in either output form.
function rulesFor(css: string, className: string): CompiledRule[] {
  const escaped = className.replace(/([[\]:/.(),])/g, "\\$1");
  const rules: CompiledRule[] = [];
  const scan = (source: string, ancestors: string[]): void => {
    let cursor = 0;
    while (cursor < source.length) {
      const open = source.indexOf("{", cursor);
      if (open === -1) return;
      const selector = source
        .slice(cursor, open)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim();
      let depth = 1;
      let end = open + 1;
      while (end < source.length && depth > 0) {
        if (source[end] === "{") depth++;
        else if (source[end] === "}") depth--;
        end++;
      }
      const body = source.slice(open + 1, end - 1);
      if (selector.startsWith(`.${escaped}`)) rules.push({ selector, body, ancestors });
      scan(body, [...ancestors, selector]);
      cursor = end;
    }
  };
  scan(css, []);
  expect(rules.length, `${className} did not compile`).toBeGreaterThan(0);
  return rules;
}

function underMedia(rule: CompiledRule, query: string): boolean {
  return [...rule.ancestors, rule.body].some((text) => text.includes(query));
}

function hasAppSelector(rule: CompiledRule, selector: string): boolean {
  return rule.selector.includes(selector) || rule.body.includes(`&${selector}`);
}

describe("motion variants honour the in-app reduced-motion setting", () => {
  it("motion-reduce: applies under the app flag as well as the OS query", () => {
    const rules = rulesFor(
      compiler.build(["motion-reduce:transition-none"]),
      "motion-reduce:transition-none"
    );
    expect(rules.some((rule) => underMedia(rule, "prefers-reduced-motion: reduce"))).toBe(true);
    expect(rules.some((rule) => hasAppSelector(rule, `:where(${APP_FLAG} *)`))).toBe(true);
    expect(rules.every((rule) => !rule.selector.includes(` ${APP_FLAG}`))).toBe(true);
  });

  it("motion-safe: stops applying under the app flag", () => {
    const rules = rulesFor(
      compiler.build(["motion-safe:animate-pulse"]),
      "motion-safe:animate-pulse"
    );
    expect(
      rules.some(
        (rule) =>
          underMedia(rule, "prefers-reduced-motion: no-preference") &&
          hasAppSelector(rule, `:where(:not(${APP_FLAG} *))`)
      )
    ).toBe(true);
  });
});

describe("reduce-motion: works as a utility too", () => {
  it("carries the app-flag branch as an ancestor of the element", () => {
    const rules = rulesFor(
      compiler.build(["reduce-motion:transition-none"]),
      "reduce-motion:transition-none"
    );
    expect(rules.some((rule) => underMedia(rule, "prefers-reduced-motion: reduce"))).toBe(true);
    expect(rules.some((rule) => hasAppSelector(rule, `:where(${APP_FLAG} *)`))).toBe(true);
  });
});
