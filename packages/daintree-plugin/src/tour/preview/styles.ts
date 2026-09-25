import fs from "node:fs/promises";
import path from "node:path";
import { compile, type Polyfills } from "tailwindcss";
import {
  designContractCss,
  hostRootVariablesCss,
  tailwindPreflightCss,
  tailwindThemeCss,
  tailwindUtilitiesCss,
  twAnimateCss,
} from "virtual:daintree-plugin-style-contract";
import { CAPTURE_WIDTH } from "./protocol.js";
import { tokenizePluginSource } from "../../../../../src/services/plugin/tailwind/candidateTokenizer.js";
import {
  BUILT_IN_APP_SCHEMES,
  getAppThemeCssVariables,
  resolveAppTheme,
} from "../../../../../shared/theme/themes.js";

const STYLESHEETS: ReadonlyMap<string, string> = new Map([
  ["tailwindcss/theme", tailwindThemeCss],
  ["tailwindcss/preflight", tailwindPreflightCss],
  ["daintree:design-contract", designContractCss],
  ["tw-animate-css", twAnimateCss],
]);

/**
 * The host document's stylesheet, rebuilt for the preview: Tailwind's theme and
 * preflight, Daintree's design contract, and utilities for exactly the classes
 * the scenes use. Unlike a plugin panel's scoped sheet this is the whole page's,
 * because the preview page stands in for the host.
 */
const COMPILER_INPUT = `@layer theme, base, components, utilities;
@import "tailwindcss/theme" layer(theme);
@import "tailwindcss/preflight" layer(base);
@import "daintree:design-contract";
@import "tw-animate-css";
${tailwindUtilitiesCss.trim()}
`;

/**
 * Host rules the mockup kit relies on that live in the host's own stylesheet
 * rather than the design contract. Mirrors `.tour-click-ring` in src/index.css.
 */
const HOST_TOUR_CSS = `@keyframes tour-click-ring {
  0% { opacity: 0.9; transform: scale(0.3); }
  100% { opacity: 0; transform: scale(1.6); }
}
.tour-click-ring { animation: tour-click-ring 450ms ease-out 1 both; }
@media (prefers-reduced-motion: reduce) { .tour-click-ring { display: none; } }
`;

/** The preview's own chrome around the stage. */
const HARNESS_CSS = `body { margin: 0; background: var(--theme-surface-canvas); color: var(--theme-text-primary); font: 13px/1.4 system-ui, sans-serif; }
.tp-root { max-width: 1024px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.tp-header, .tp-controls { display: flex; align-items: center; gap: 12px; }
.tp-controls label { display: flex; align-items: center; gap: 4px; }
.tp-header strong { font-size: 15px; }
.tp-header select, .tp-controls button { font: inherit; color: inherit; background: var(--theme-surface-panel); border: 1px solid var(--theme-border-default); border-radius: 6px; padding: 4px 10px; }
.tp-stage { border: 1px solid var(--theme-border-default); border-radius: 8px; }
.tp-capture { width: ${CAPTURE_WIDTH}px; }
.tp-capture .tp-stage { border: 0; border-radius: 0; }
.tp-audio, .tp-time { color: var(--theme-text-secondary); font-variant-numeric: tabular-nums; }
.tp-timeline { display: flex; flex-direction: column; gap: 4px; }
.tp-timeline input[type="range"] { width: 100%; margin: 0; }
.tp-cues { position: relative; height: 34px; margin: 0 8px; }
.tp-cues .tp-cue { position: absolute; top: 0; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; background: none; border: 0; padding: 0; color: var(--theme-text-secondary); font: 11px/1.2 ui-monospace, monospace; cursor: pointer; }
.tp-cues .tp-cue::before { content: ""; width: 2px; height: 10px; margin-bottom: 2px; background: currentColor; }
.tp-cues .tp-cue-passed { color: var(--theme-accent-primary); }
.tp-caption { min-height: 1.4em; color: var(--theme-text-secondary); }
.tp-warnings { margin: 0; padding: 8px 8px 8px 24px; border: 1px solid var(--theme-status-warning); border-radius: 6px; color: var(--theme-status-warning); }
.tp-anchors { position: absolute; inset: 0; pointer-events: none; z-index: 9999; }
.tp-anchor { position: absolute; outline: 1px dashed var(--theme-accent-primary); }
.tp-anchor span { position: absolute; left: 0; top: -12px; font: 9px/1 ui-monospace, monospace; color: var(--theme-accent-primary); white-space: nowrap; }
.tp-scene-error, .tp-failure { margin: 0; padding: 16px; color: var(--theme-status-danger); white-space: pre-wrap; font: 12px/1.4 ui-monospace, monospace; }
`;

/** Built-in theme ids, for `--theme` validation. */
export function previewThemeIds(): string[] {
  return BUILT_IN_APP_SCHEMES.map((scheme) => scheme.id);
}

export interface PreviewTheme {
  id: string;
  type: "dark" | "light";
  css: string;
}

/** The theme's variables as a `:root` rule: what `applyAppThemeToRoot` sets in the app. */
export function previewTheme(themeId: string): PreviewTheme {
  if (!previewThemeIds().includes(themeId)) {
    throw new Error(`Unknown theme "${themeId}"; built-in themes: ${previewThemeIds().join(", ")}`);
  }
  const scheme = resolveAppTheme(themeId);
  const declarations = Object.entries(getAppThemeCssVariables(scheme))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  return {
    id: scheme.id,
    type: scheme.type,
    css: `:root {\n${declarations}\n  color-scheme: ${scheme.type};\n}\n`,
  };
}

/**
 * Every `.js`/`.mjs` file under `dir`. `node_modules` and hidden folders are
 * never entered, so a large dependency tree or `.git` costs nothing.
 */
export async function listScripts(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && /\.m?js$/.test(entry.name)) out.push(full);
    }
  };
  await walk(dir);
  return out.sort();
}

/**
 * Compile the page stylesheet for the class names found in `sources`. Classes
 * are read from the built files the same way the host reads a plugin's, so a
 * class the host wouldn't style is unstyled here too.
 */
export async function compilePreviewCss(sources: string[], theme: PreviewTheme): Promise<string> {
  const candidates = new Set<string>();
  for (const file of sources) {
    for (const token of tokenizePluginSource(await fs.readFile(file, "utf8"))) {
      candidates.add(token);
    }
  }
  const compiler = await compile(COMPILER_INPUT, {
    base: "/",
    // Chromium needs neither the `@property` nor the `color-mix()` fallback.
    polyfills: 0 as Polyfills,
    loadStylesheet: async (id, base) => {
      const content = STYLESHEETS.get(id);
      if (content === undefined) throw new Error(`[tour preview] no bundled stylesheet "${id}"`);
      return { path: id, base, content };
    },
  });
  return `${theme.css}${hostRootVariablesCss}\n${compiler.build([...candidates])}\n${HOST_TOUR_CSS}${HARNESS_CSS}`;
}
