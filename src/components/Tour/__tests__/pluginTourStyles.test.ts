import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  PLUGIN_SCOPE_SELECTOR,
  createPluginCandidateValidator,
  createPluginCssCompiler,
  type PluginCandidateValidator,
  type PluginCssCompiler,
} from "@/services/plugin/tailwind/pluginTailwindAdapter";
import { tokenizePluginSource } from "@/services/plugin/tailwind/candidateTokenizer";
import { reveal } from "@daintreehq/tour/kit";

/**
 * A plugin tour scene sits inside the plugin style root beside kit components
 * the host compiles itself, so its own additions have to reach the same tokens
 * through the plugin compiler (#12773). The fixture reaches for the ones the
 * plugin vocabulary is easiest to doubt on: the `category-*` colours.
 */
const FIXTURE_SOURCE = readFileSync(
  path.resolve(__dirname, "../../../../plugins/fixtures/installed/acme.welcome-tour/dist/tour.js"),
  "utf-8"
);

const CATEGORY_CLASSES = [
  "border-category-amber-border",
  "bg-category-amber-subtle",
  "text-category-amber-text",
  "bg-category-teal-subtle",
  "text-category-teal-text",
];

let compiler: PluginCssCompiler;
let validate: PluginCandidateValidator;

beforeAll(async () => {
  [compiler, validate] = await Promise.all([
    createPluginCssCompiler(),
    createPluginCandidateValidator(),
  ]);
});

describe("plugin tour scene styling", () => {
  it("finds the fixture scene's category classes in its source, as the runtime does", () => {
    const candidates = new Set(tokenizePluginSource(FIXTURE_SOURCE));
    for (const className of CATEGORY_CLASSES) expect(candidates.has(className)).toBe(true);
  });

  it("compiles them against the same live theme variables the kit's own marks use", () => {
    expect(validate(CATEGORY_CLASSES).filter((verdict) => !verdict.generated)).toEqual([]);
    const css = compiler.build(CATEGORY_CLASSES);
    expect(css).toContain(PLUGIN_SCOPE_SELECTOR);
    expect(css).toContain("var(--theme-category-amber)");
    expect(css).toContain("var(--theme-category-teal)");
  });

  it("compiles the kit helpers a scene composes its own elements with", () => {
    const kitClasses = [reveal(true), reveal(false)].join(" ").split(/\s+/).filter(Boolean);
    expect(validate(kitClasses).filter((verdict) => !verdict.generated)).toEqual([]);
  });
});
