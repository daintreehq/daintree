/**
 * The one place Daintree calls Tailwind's programmatic compiler.
 *
 * `compile()` and `__unstable__loadDesignSystem()` are undocumented internals —
 * the same core `@tailwindcss/vite`, `@tailwindcss/postcss` and the Play CDN
 * build all sit on, structurally stable across 4.0–4.3, but internals all the
 * same. `tailwindcss` is therefore pinned exactly in `package.json`, a bump is
 * its own PR, and every guarantee this module makes is covered by semantic
 * contract tests rather than a stylesheet snapshot (a snapshot would churn on
 * every Tailwind patch while proving none of the things that actually matter).
 *
 * What makes the runtime path viable at all: `tailwindcss/dist/lib.mjs` is
 * dependency-free and touches no Node built-in. The Rust scanner in
 * `@tailwindcss/oxide` only exists to FIND class names in files; hand `build()`
 * the candidate strings directly and no native binary is involved. `loadModule`
 * and `loadStylesheet` are the only I/O seams, and this module supplies the
 * latter from bytes Vite has already inlined — so nothing here reads a file.
 */

import { compile, __unstable__loadDesignSystem, type Polyfills } from "tailwindcss";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "@shared/types/plugin";
// Inlined at build time by `scripts/lib/plugin-style-contract.mjs`, which both
// vite.config.ts and vitest.config.ts install. Not `?raw` imports: Vitest stubs
// every `.css` specifier to an empty string (`?raw` included), and
// `tw-animate-css` exposes only a `style` export condition, so its bytes are
// unreachable from a JS module graph by specifier at all.
import {
  designContractCss,
  tailwindThemeCss,
  tailwindUtilitiesCss,
  twAnimateCss,
} from "virtual:daintree-plugin-style-contract";

/**
 * Disables Tailwind's `@property` and `color-mix()` fallbacks. Both target
 * Safari and older Firefox; Chromium 148 needs neither.
 *
 * This is load-bearing rather than a size tweak. The `@property` fallback emits
 * `@layer properties { @supports (…) { *, ::before, ::after, ::backdrop { … } } }`
 * — a universal selector, and the only rule Tailwind would place OUTSIDE our
 * `@scope` wrapper. Dropping it is what lets
 * `pluginTailwindAdapter.contract.test.ts` assert the stronger invariant: the
 * compiled output contains no style rule outside the plugin scope at all.
 *
 * Spelled as a cast because `Polyfills` is an ambient `const enum`, which
 * `isolatedModules` forbids importing as a value.
 */
const NO_POLYFILLS = 0 as Polyfills;

/** `@scope` prelude every generated utility is nested inside. */
export const PLUGIN_SCOPE_SELECTOR = `[${PLUGIN_STYLE_ROOT_ATTRIBUTE}]`;

const THEME_STYLESHEET_ID = "tailwindcss/theme";
const ANIMATE_STYLESHEET_ID = "tw-animate-css";
const DESIGN_CONTRACT_STYLESHEET_ID = "daintree:design-contract";

/**
 * The stylesheets `compile()` may resolve, by the exact specifier the input
 * imports. Everything is already a string in the bundle, so resolution is a
 * lookup: no `fetch`, no filesystem, and an unknown specifier is a programming
 * error rather than something to search for.
 */
const STYLESHEETS: ReadonlyMap<string, string> = new Map([
  [THEME_STYLESHEET_ID, tailwindThemeCss],
  [ANIMATE_STYLESHEET_ID, twAnimateCss],
  [DESIGN_CONTRACT_STYLESHEET_ID, designContractCss],
]);

/**
 * The compile input, and with it the whole plugin styling contract.
 *
 * - The theme comes in as `reference`, so its tokens register but emit nothing.
 *   No `:root` block and no preflight reach the output, which is what keeps a
 *   plugin mount from touching host chrome.
 * - The design contract is the host's own `@theme`/`@custom-variant` blocks,
 *   the same bytes `src/index.css` imports. `--color-*: initial` in there
 *   deletes the stock palette, so `bg-red-500` compiles to nothing for a plugin
 *   exactly as it does for the host.
 * - `tw-animate-css` is included because the host uses it; its classes are
 *   `@utility` definitions Tailwind can order. `@tailwindcss/typography` is
 *   deliberately excluded — `prose` needs `loadModule` for a JS plugin, and a
 *   themed prose surface should be a deliberate host contract, not a side
 *   effect of this.
 * - Utilities are emitted nested inside `@layer utilities { @scope (…) }`.
 *   `@layer` membership, not specificity, is what orders these against the
 *   host's own utilities, so the layer name has to be the document-global
 *   `utilities` — and the `@scope` inside it is what stops a plugin's `p-4`
 *   from re-declaring a host element's.
 *
 * The utilities entry is INLINED rather than `@import`ed, because `@import` is
 * only valid at the top level of a stylesheet: nested inside the scope it is
 * dropped, and the compiler silently emits an empty `@layer utilities;` with
 * every candidate missing. Inlining the package's own bytes (rather than
 * hard-coding `@tailwind utilities;`) keeps the directive sourced from
 * Tailwind, so a change to that entry file still reaches us.
 */
function buildCompilerInput(scopeSelector: string): string {
  return `@import "${THEME_STYLESHEET_ID}" layer(theme) reference;
@import "${DESIGN_CONTRACT_STYLESHEET_ID}";
@import "${ANIMATE_STYLESHEET_ID}";
@layer utilities {
  @scope (${scopeSelector}) {
    ${tailwindUtilitiesCss.trim()}
  }
}
`;
}

async function loadStylesheet(
  id: string,
  base: string
): Promise<{
  path: string;
  base: string;
  content: string;
}> {
  const content = STYLESHEETS.get(id);
  if (content === undefined) {
    throw new Error(
      `[pluginTailwindAdapter] no bundled stylesheet for "${id}" (base "${base}"). ` +
        `The plugin compiler resolves imports from a fixed map, never from disk.`
    );
  }
  return { path: id, base, content };
}

/**
 * A prepared Tailwind compiler for one document's plugin views.
 *
 * `build()` is cumulative by design: it returns the stylesheet for every
 * candidate the compiler has ever been handed, not just this call's. That is
 * what preserves Tailwind's ordering — `p-4` sorts before `px-3` and `flex`
 * before `hidden` for a reason, and appending deltas would replace that order
 * with whatever order classes happened to be discovered in.
 */
export interface PluginCssCompiler {
  /** Cumulative CSS for `candidates` plus everything built before. */
  build(candidates: string[]): string;
}

/**
 * Compile the host design contract once, ready to generate utilities for
 * plugin-supplied candidate classes. Roughly 10 ms; individual `build()` calls
 * are single-digit milliseconds and incremental ones are well under one.
 */
export async function createPluginCssCompiler(
  scopeSelector: string = PLUGIN_SCOPE_SELECTOR
): Promise<PluginCssCompiler> {
  const compiler = await compile(buildCompilerInput(scopeSelector), {
    base: "/",
    polyfills: NO_POLYFILLS,
    loadStylesheet,
  });
  return { build: (candidates) => compiler.build(candidates) };
}

/** Per-class verdict from {@link createPluginCandidateValidator}. */
export interface PluginCandidateVerdict {
  readonly candidate: string;
  /** Whether the class generates any CSS against Daintree's design contract. */
  readonly generated: boolean;
}

/**
 * Classifies candidate classes as generating CSS or not, which is what makes a
 * "this class does nothing" diagnostic possible (#12214).
 *
 * Backed by `candidatesToCss()`, which returns `null` per class that generates
 * nothing — the same signal Tailwind's own IntelliSense uses. Deliberately NOT
 * `getClassList()`: that enumerates ~20k static names and can judge neither
 * arbitrary values (`w-[327px]`) nor variants (`hover:`), so it would report
 * false negatives for the two things plugin authors most often get wrong.
 */
export type PluginCandidateValidator = (candidates: string[]) => PluginCandidateVerdict[];

export async function createPluginCandidateValidator(
  scopeSelector: string = PLUGIN_SCOPE_SELECTOR
): Promise<PluginCandidateValidator> {
  const designSystem = await __unstable__loadDesignSystem(buildCompilerInput(scopeSelector), {
    base: "/",
    polyfills: NO_POLYFILLS,
    loadStylesheet,
  });
  return (candidates) => {
    const css = designSystem.candidatesToCss(candidates);
    return candidates.map((candidate, index) => ({
      candidate,
      generated: css[index] != null,
    }));
  };
}
