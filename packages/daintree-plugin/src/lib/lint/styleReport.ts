import { __unstable__loadDesignSystem, type Polyfills } from "tailwindcss";
import {
  designContractCss,
  tailwindThemeCss,
  tailwindUtilitiesCss,
  twAnimateCss,
} from "virtual:daintree-plugin-style-contract";
import { splitToken } from "./classTokens.js";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "../../../../../shared/types/plugin.js";

/**
 * The offline twin of the host's `getPluginStyleReport()`: the same design
 * system (theme as reference, the design contract, tw-animate, utilities inside
 * the plugin `@scope`) built from the same bytes the renderer inlines, asked the
 * same question — does this class generate any CSS? Mirrors
 * `createPluginCandidateValidator` in src/services/plugin/tailwind/pluginTailwindAdapter.ts.
 */
const STYLESHEETS: ReadonlyMap<string, string> = new Map([
  ["tailwindcss/theme", tailwindThemeCss],
  ["tw-animate-css", twAnimateCss],
  ["daintree:design-contract", designContractCss],
]);

const COMPILER_INPUT = `@import "tailwindcss/theme" layer(theme) reference;
@import "daintree:design-contract";
@import "tw-animate-css";
@layer utilities {
  @scope ([${PLUGIN_STYLE_ROOT_ATTRIBUTE}]) {
    ${tailwindUtilitiesCss.trim()}
  }
}
`;

type DesignSystem = Awaited<ReturnType<typeof __unstable__loadDesignSystem>>;

let designSystem: Promise<DesignSystem> | null = null;

function loadDesignSystem(): Promise<DesignSystem> {
  designSystem ??= __unstable__loadDesignSystem(COMPILER_INPUT, {
    base: "/",
    polyfills: 0 as Polyfills,
    loadStylesheet: async (id, base) => {
      const content = STYLESHEETS.get(id);
      if (content === undefined) throw new Error(`no bundled stylesheet "${id}"`);
      return { path: id, base, content };
    },
  });
  return designSystem;
}

/**
 * The classes among `candidates` that look like Tailwind but generate nothing.
 *
 * Unlike the host report, which reads real DOM classes, these come from source
 * strings, so a token Tailwind cannot even parse as a utility (`open`, `utf8`,
 * a custom class of the plugin's own) is left out rather than reported. A token
 * whose variant is unknown but whose utility parses (`foo:p-4`) is kept: that
 * is a typo, not someone else's class.
 */
export async function classesThatCompileToNothing(candidates: string[]): Promise<Set<string>> {
  const unique = [...new Set(candidates)];
  if (unique.length === 0) return new Set();
  const system = await loadDesignSystem();
  const css = system.candidatesToCss(unique);
  const dead = new Set<string>();
  unique.forEach((candidate, index) => {
    if (css[index] != null) return;
    // A bare word that generates nothing is a string compared in the class
    // expression (`side === "start"`), not a class; bare utilities that exist
    // (`flex`, `hidden`) have already generated CSS above.
    if (/^[a-z]+$/.test(candidate)) return;
    if (system.parseCandidate(candidate).length > 0) {
      dead.add(candidate);
      return;
    }
    const { variants, base } = splitToken(candidate);
    if (variants.length > 0 && base && system.parseCandidate(base).length > 0) dead.add(candidate);
  });
  return dead;
}
