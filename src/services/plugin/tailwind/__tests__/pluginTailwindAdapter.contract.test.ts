/**
 * Semantic contract for the plugin Tailwind compiler.
 *
 * `compile()` is an undocumented Tailwind internal, so the mitigation is an
 * exact version pin plus these tests. They assert BEHAVIOUR, never bytes: a
 * stylesheet snapshot would churn on every Tailwind patch release while proving
 * none of the things a plugin author actually depends on, and would go green
 * again the moment someone re-recorded it.
 *
 * Each test here corresponds to a promise the plugin styling docs make.
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  PLUGIN_SCOPE_SELECTOR,
  createPluginCssCompiler,
  createPluginCandidateValidator,
  type PluginCssCompiler,
  type PluginCandidateValidator,
} from "@/services/plugin/tailwind/pluginTailwindAdapter";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "@shared/types/plugin";

/** Everything the definition-of-done names, plus the ordering probes. */
const DOD_CANDIDATES = [
  "bg-surface-panel",
  "text-text-muted",
  "hover:bg-surface-hover",
  "gap-2",
  "p-4",
  "rounded-md",
  "w-[327px]",
];

let compiler: PluginCssCompiler;
let validate: PluginCandidateValidator;

beforeAll(async () => {
  [compiler, validate] = await Promise.all([
    createPluginCssCompiler(),
    createPluginCandidateValidator(),
  ]);
});

/** Character offset of a class selector, or -1. Escapes `[`/`]` the way CSS does. */
function selectorIndex(css: string, className: string): number {
  return css.indexOf(`.${className.replace(/([[\]:/.])/g, "\\$1")}`);
}

describe("plugin Tailwind adapter — the design system, enforced by the compiler", () => {
  it("compiles Daintree's semantic tokens to the host's live theme variables", () => {
    const css = compiler.build(["bg-surface-panel", "text-text-muted", "border-border-subtle"]);

    // `var(--theme-*)` rather than a resolved colour is the whole point of the
    // host theme being `@theme inline`: a plugin panel follows a theme switch
    // with no recompile, because the variable is resolved by the document.
    expect(css).toContain("background-color: var(--theme-surface-panel)");
    expect(css).toContain("color: var(--theme-text-muted)");
    expect(css).toContain("border-color: var(--theme-border-subtle)");
  });

  it("generates nothing for the stock Tailwind palette", () => {
    // `--color-*: initial` at the top of the design contract deletes the stock
    // palette. This is what stops a plugin escaping the design system, so it is
    // a contract, not an accident of configuration.
    const css = compiler.build(["bg-red-500", "text-blue-600", "border-green-400"]);

    expect(selectorIndex(css, "bg-red-500")).toBe(-1);
    expect(selectorIndex(css, "text-blue-600")).toBe(-1);
    expect(selectorIndex(css, "border-green-400")).toBe(-1);
  });

  it("compiles arbitrary values and dynamic scales", () => {
    const css = compiler.build(["w-[327px]", "grid-cols-47"]);

    expect(css).toContain("width: 327px");
    expect(css).toContain("grid-cols-47");
  });

  it("expands `reduce-motion:` to BOTH triggers, not just the media query", () => {
    // The host variant composes the OS preference with Daintree's own "Reduce UI
    // animations" toggle. A plugin honouring only one of them is a bug the user
    // sees as the setting not working inside plugin panels.
    const css = compiler.build(["reduce-motion:transition-none"]);

    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain('body[data-reduce-animations="true"]');
  });

  it("compiles tw-animate-css utilities, which the host itself uses", () => {
    // `tw-animate-css` is in the contract because the host uses it (see
    // `ContentFadeIn`), so a plugin panel can match host motion rather than
    // inventing its own.
    const css = compiler.build(["animate-in", "fade-in", "duration-150", "ease-snappy"]);

    expect(selectorIndex(css, "animate-in")).toBeGreaterThanOrEqual(0);
    expect(selectorIndex(css, "fade-in")).toBeGreaterThanOrEqual(0);
    expect(css).toContain("animation: enter");
  });

  it("resolves motion tokens from the contract's own `@theme` blocks", () => {
    const css = compiler.build(["duration-150", "ease-snappy"]);

    // The two `@theme` forms behave differently, and both are deliberate.
    // Durations are a plain `@theme`, so Tailwind substitutes the literal at
    // compile time — a duration is not something a colour scheme should change.
    expect(css).toContain("transition-duration: 150ms");
    // Easings are named curves, so the reference survives and stays legible.
    expect(css).toContain("var(--ease-snappy)");
  });

  it("compiles the host's sub-12px type scale", () => {
    const css = compiler.build(["text-2xs", "text-3xs", "text-4xs"]);

    expect(css).toContain("var(--text-2xs)");
    expect(css).toContain("var(--text-3xs)");
    expect(css).toContain("var(--text-4xs)");
  });
});

describe("plugin Tailwind adapter — scoping, which is what protects host chrome", () => {
  it("nests utilities inside `@layer utilities` and the plugin `@scope`", () => {
    const css = compiler.build(DOD_CANDIDATES);

    expect(css).toContain("@layer utilities");
    expect(css).toContain(`@scope (${PLUGIN_SCOPE_SELECTOR})`);
    expect(PLUGIN_SCOPE_SELECTOR).toBe(`[${PLUGIN_STYLE_ROOT_ATTRIBUTE}]`);

    // Layer membership, not specificity and not scope proximity, is what orders
    // these against the host's utilities. A differently-named layer (or none)
    // would silently move every plugin rule in the cascade.
    const layerIndex = css.indexOf("@layer utilities");
    const scopeIndex = css.indexOf("@scope (");
    expect(layerIndex).toBeGreaterThanOrEqual(0);
    expect(scopeIndex).toBeGreaterThan(layerIndex);
  });

  it("emits NO style rule outside the plugin scope", () => {
    // The strongest form of "a plugin mount cannot change host chrome". With
    // polyfills disabled the only top-level constructs Tailwind emits are
    // `@property` registrations and `@keyframes` — both global-by-nature, both
    // byte-identical to what the host already registers, so both coalesce.
    // Anything else at top level would apply to the whole document.
    const css = compiler.build([...DOD_CANDIDATES, "animate-in", "duration-150", "flex"]);

    for (const construct of topLevelConstructs(css)) {
      expect(
        /^@(?:property|keyframes|layer)\b/.test(construct),
        `unscoped top-level construct would reach host chrome: ${construct}`
      ).toBe(true);
    }
  });

  it("re-emits neither preflight nor the theme's `:root` variables", () => {
    // The theme is imported as `reference`, so it registers tokens and emits
    // nothing. Re-emitting either would restyle every element in the document.
    const css = compiler.build(DOD_CANDIDATES);

    expect(css).not.toContain(":root");
    expect(css).not.toContain("*, ::before, ::after");
  });
});

describe("plugin Tailwind adapter — ordering and cumulative builds", () => {
  it("keeps Tailwind's own utility order regardless of discovery order", async () => {
    // Tailwind orders `p-4` before `px-3` and `flex` before `hidden` so the
    // narrower utility wins. Handing them over in the opposite order — which is
    // exactly what DOM discovery does — must not change the emitted order.
    const fresh = await createPluginCssCompiler();
    const css = fresh.build(["px-3", "hidden", "p-4", "flex"]);

    expect(selectorIndex(css, "p-4")).toBeLessThan(selectorIndex(css, "px-3"));
    expect(selectorIndex(css, "flex")).toBeLessThan(selectorIndex(css, "hidden"));
  });

  it("returns a cumulative sheet, so a later build never drops an earlier class", async () => {
    const fresh = await createPluginCssCompiler();
    fresh.build(["p-4"]);
    const second = fresh.build(["gap-2"]);

    // `build()` returns the whole stylesheet, not a delta. This is why the sheet
    // is installed with `replaceSync()` rather than appended to: a newly
    // discovered utility can sort earlier than one already emitted.
    expect(selectorIndex(second, "p-4")).toBeGreaterThanOrEqual(0);
    expect(selectorIndex(second, "gap-2")).toBeGreaterThanOrEqual(0);
  });

  it("is idempotent for a candidate set it has already seen", async () => {
    const fresh = await createPluginCssCompiler();
    const first = fresh.build(DOD_CANDIDATES);
    const again = fresh.build(DOD_CANDIDATES);

    expect(again).toBe(first);
  });

  it("ignores junk candidates instead of throwing", async () => {
    // The source tokeniser is heuristic by design — it hands over every token it
    // sees and lets Tailwind decide. That is only safe because non-utilities are
    // dropped silently.
    const fresh = await createPluginCssCompiler();

    expect(() =>
      fresh.build(["", "   ", "<div", "https://example.com", "console.log", "not_a_class", "p-4"])
    ).not.toThrow();
    expect(selectorIndex(fresh.build(["p-4"]), "p-4")).toBeGreaterThanOrEqual(0);
  });
});

describe("plugin Tailwind adapter — candidate validation for diagnostics", () => {
  it("reports classes that generate no CSS", () => {
    const verdicts = validate([
      "bg-surface-panel",
      "bg-red-500",
      "w-[327px]",
      "hover:bg-surface-hover",
      "definitely-not-a-class",
    ]);

    expect(Object.fromEntries(verdicts.map((v) => [v.candidate, v.generated]))).toEqual({
      "bg-surface-panel": true,
      // The headline diagnostic: a stock-palette colour is reported as
      // generating nothing rather than silently doing nothing.
      "bg-red-500": false,
      // Arbitrary values and variants are exactly what `getClassList()` cannot
      // judge, which is why validation goes through `candidatesToCss()`.
      "w-[327px]": true,
      "hover:bg-surface-hover": true,
      "definitely-not-a-class": false,
    });
  });

  it("preserves input order and length", () => {
    const input = ["p-4", "bg-red-500", "gap-2"];
    expect(validate(input).map((v) => v.candidate)).toEqual(input);
  });
});

/**
 * Text of every construct at brace depth 0. Crude but sufficient: Tailwind's
 * output is machine-generated and consistently indented, and the assertion only
 * needs to know what sits outside the `@scope` block.
 */
function topLevelConstructs(css: string): string[] {
  const constructs: string[] = [];
  let depth = 0;

  for (const line of css.split("\n")) {
    const trimmed = line.trim();
    if (depth === 0 && trimmed && !trimmed.startsWith("/*")) {
      const construct = trimmed.replace(/\s*\{$/, "");
      if (construct) constructs.push(construct);
    }
    depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
  }
  return constructs;
}
