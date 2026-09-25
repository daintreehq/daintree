/**
 * Supplies the stylesheets the renderer's plugin Tailwind compiler compiles
 * against, as one virtual module.
 *
 * The compiler runs `compile()` in the renderer, and `loadStylesheet` is its
 * only I/O seam — there is no filesystem to fall back on — so every stylesheet
 * it can import has to be inlined into the bundle as text. Three things make a
 * plain `?raw` import the wrong tool for that:
 *
 *   - Vitest stubs anything matching `.css($|?)` to an empty string, `?raw`
 *     included, so the adapter's tests would silently compile against nothing.
 *   - `tw-animate-css` publishes an `exports` map carrying only the `style`
 *     condition, so its bytes are unreachable from a JS module graph by
 *     specifier at all.
 *   - The set of stylesheets in the contract is a real architectural decision
 *     (notably: `@tailwindcss/typography` is excluded), and it deserves to be
 *     written down in one place rather than inferred from imports.
 *
 * One virtual module solves all three, and gives the app and its tests byte-
 * identical inputs. Wired into both `vite.config.ts` and `vitest.config.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const PLUGIN_STYLE_CONTRACT_MODULE_ID = "virtual:daintree-plugin-style-contract";

const RESOLVED_ID = `\0${PLUGIN_STYLE_CONTRACT_MODULE_ID}`;
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * Exported name -> path, relative to the repo root.
 *
 * `tw-animate-css` is reached by path rather than by specifier because of the
 * exports-map limitation above; the others are addressed the same way for
 * symmetry, since all four are pinned dependencies whose layout is fixed.
 */
const CONTRACT_SOURCES = {
  /** The host's own `@theme` / `@custom-variant` blocks — the shared vocabulary. */
  designContractCss: "src/styles/design-contract.css",
  /** Tailwind's stock theme. Imported as `reference`, so it emits nothing. */
  tailwindThemeCss: "node_modules/tailwindcss/theme.css",
  /** The `@tailwind utilities;` entry, inlined inside the plugin `@scope`. */
  tailwindUtilitiesCss: "node_modules/tailwindcss/utilities.css",
  /** Approved extension: the host uses it, and its classes are `@utility` definitions. */
  twAnimateCss: "node_modules/tw-animate-css/dist/tw-animate.css",
};

/**
 * Stylesheets exposed beside the contract that are NOT part of it. Tailwind's
 * preflight is host chrome and never reaches a plugin compile; it is here for
 * `daintree-plugin tour preview`, which stands in for the host document and so
 * needs the host's base layer too.
 */
const STANDALONE_SOURCES = {
  tailwindPreflightCss: "node_modules/tailwindcss/preflight.css",
};

/** The host stylesheet whose root-level variables the standalone preview needs. */
const HOST_STYLESHEET = "src/index.css";

/**
 * The custom properties the host stylesheet declares on `:root`, `.light` and
 * `.dark`, as those three rules and nothing else. The design contract's tokens
 * read some of them (`--theme-surface-dialog`, the shadcn aliases), so a page
 * without the host's stylesheet needs them to draw those tokens at all.
 */
export function hostRootVariablesCss(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = new Map([
    [":root", []],
    [".light", []],
    [".dark", []],
  ]);
  const opener = /^(:root|\.light|\.dark)\s*\{/gm;
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    let depth = 1;
    let index = opener.lastIndex;
    while (index < source.length && depth > 0) {
      if (source[index] === "{") depth++;
      else if (source[index] === "}") depth--;
      index++;
    }
    const body = source.slice(opener.lastIndex, index - 1);
    // Only top-level declarations of this rule, not ones nested in a child block.
    let flat = "";
    let nested = 0;
    for (const char of body) {
      if (char === "{") nested++;
      else if (char === "}") nested--;
      else if (nested === 0) flat += char;
    }
    for (const decl of flat.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      blocks.get(match[1]).push(`  ${decl[1]}: ${decl[2].trim().replace(/\s+/g, " ")};`);
    }
    opener.lastIndex = index;
  }
  return [...blocks]
    .filter(([, decls]) => decls.length > 0)
    .map(([selector, decls]) => `${selector} {\n${decls.join("\n")}\n}`)
    .join("\n");
}

/** The virtual module's source: one string export per stylesheet. */
function renderModule(onFile) {
  const exports = [];
  for (const [name, relative] of Object.entries({ ...CONTRACT_SOURCES, ...STANDALONE_SOURCES })) {
    const absolute = path.join(REPO_ROOT, relative);
    if (!existsSync(absolute)) {
      throw new Error(
        `[daintree-plugin-style-contract] missing ${relative}. The plugin Tailwind ` +
          `compiler inlines this file, so the renderer cannot be built without it.`
      );
    }
    onFile?.(absolute);
    exports.push(`export const ${name} = ${JSON.stringify(readFileSync(absolute, "utf-8"))};`);
  }
  const host = path.join(REPO_ROOT, HOST_STYLESHEET);
  onFile?.(host);
  exports.push(
    `export const hostRootVariablesCss = ${JSON.stringify(hostRootVariablesCss(readFileSync(host, "utf-8")))};`
  );
  return exports.join("\n");
}

/** Absolute paths of every stylesheet in the contract. */
export function pluginStyleContractSources() {
  return Object.values(CONTRACT_SOURCES).map((relative) => path.join(REPO_ROOT, relative));
}

/**
 * Vite plugin exposing {@link PLUGIN_STYLE_CONTRACT_MODULE_ID}.
 *
 * `enforce: "pre"` matters: it has to resolve and load ahead of Vite's own CSS
 * pipeline and Vitest's CSS stubber, both of which would otherwise claim these
 * ids first.
 *
 * @returns {import("vite").Plugin}
 */
export function pluginStyleContract() {
  return {
    name: "daintree-plugin-style-contract",
    enforce: "pre",

    resolveId(id) {
      return id === PLUGIN_STYLE_CONTRACT_MODULE_ID ? RESOLVED_ID : null;
    },

    load(id) {
      if (id !== RESOLVED_ID) return null;
      // Editing the design contract has to rebuild the compiler's input in
      // dev, not just the host stylesheet.
      return renderModule((absolute) => this.addWatchFile?.(absolute));
    },
  };
}

/**
 * The same module for an esbuild build (tsup), so the `daintree-plugin` CLI
 * bundles byte-identical stylesheets to the ones the renderer compiles with.
 *
 * @returns {import("esbuild").Plugin}
 */
export function pluginStyleContractEsbuild() {
  const filter = new RegExp(`^${PLUGIN_STYLE_CONTRACT_MODULE_ID.replace(/[.:-]/g, "\\$&")}$`);
  return {
    name: "daintree-plugin-style-contract",
    setup(build) {
      build.onResolve({ filter }, () => ({
        path: PLUGIN_STYLE_CONTRACT_MODULE_ID,
        namespace: "daintree-style-contract",
      }));
      build.onLoad({ filter: /.*/, namespace: "daintree-style-contract" }, () => {
        const watchFiles = [];
        return {
          contents: renderModule((absolute) => watchFiles.push(absolute)),
          loader: "js",
          watchFiles,
        };
      });
    },
  };
}
