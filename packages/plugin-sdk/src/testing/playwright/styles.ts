import {
  designContractCss,
  tailwindThemeCss,
  tailwindUtilitiesCss,
  twAnimateCss,
} from "virtual:daintree-plugin-style-contract";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "../../../../../shared/types/plugin.js";
import { tokenizePluginSource } from "../../../../../src/services/plugin/tailwind/candidateTokenizer.js";
import type { Polyfills } from "tailwindcss";
import { loadOptionalPeer } from "./peers.js";

const STYLESHEETS: ReadonlyMap<string, string> = new Map([
  ["tailwindcss/theme", tailwindThemeCss],
  ["tw-animate-css", twAnimateCss],
  ["daintree:design-contract", designContractCss],
]);

/**
 * The input Daintree compiles a plugin's classes against, as
 * `buildCompilerInput` in src/services/plugin/tailwind/pluginTailwindAdapter.ts
 * writes it: the theme as reference, the design contract, tw-animate, and the
 * utilities scoped to the view's style root. The utilities entry is inlined
 * because an `@import` nested in `@scope` is dropped.
 */
const COMPILER_INPUT = `@import "tailwindcss/theme" layer(theme) reference;
@import "daintree:design-contract";
@import "tw-animate-css";
@layer utilities {
  @scope ([${PLUGIN_STYLE_ROOT_ATTRIBUTE}]) {
    ${tailwindUtilitiesCss.trim()}
  }
}
`;

/** Class candidates in `sources`, read the way the host reads a plugin's. */
export function collectCandidates(sources: Iterable<string>): string[] {
  const candidates = new Set<string>();
  for (const source of sources) {
    for (const token of tokenizePluginSource(source)) candidates.add(token);
  }
  return [...candidates];
}

/**
 * The plugin's own stylesheet: utilities for exactly the classes its sources
 * use, compiled once instead of by the host's DOM observer. A class built from
 * fragments is unstyled here as it is in Daintree.
 */
export async function compilePanelCss(candidates: readonly string[]): Promise<string> {
  const { compile } = await loadOptionalPeer<typeof import("tailwindcss")>(
    "tailwindcss",
    () => import("tailwindcss")
  );
  const compiler = await compile(COMPILER_INPUT, {
    base: "/",
    // Chromium needs neither the `@property` nor the `color-mix()` fallback,
    // and the `@property` one is a universal rule outside the scope.
    polyfills: 0 as Polyfills,
    loadStylesheet: async (id, base) => {
      const content = STYLESHEETS.get(id);
      if (content === undefined) throw new Error(`[panel preview] no bundled stylesheet "${id}"`);
      return { path: id, base, content };
    },
  });
  return compiler.build([...candidates]);
}
