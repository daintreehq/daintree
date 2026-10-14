// Pure helpers for scripts/build-plugin-ui-browser.mjs: the checks the browser
// build of `@daintreehq/plugin-ui` must pass before it is written, and the
// rewrites that turn the host stylesheet into a page's `preview.css`. Kept
// apart from the build so they test without running Vite.

import path from "node:path";

/** React's entrypoints. The page's import map serves them, so the kit never bundles one. */
export const REACT_SPECIFIER = /^react(-dom)?(\/|$)/;

/** A module that is React itself; finding one in the bundle means a second React (#11296). */
const REACT_IMPLEMENTATION = /[\\/]node_modules[\\/](react|react-dom)[\\/]/;

/** Source the stylesheet scan reads for class names. */
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

/** Names in a `const NAME = [ "...", ... ] as const` array literal, read from source. */
export function readStringArray(source, constName) {
  const start = source.indexOf(`const ${constName}`);
  if (start === -1) throw new Error(`no ${constName} in source`);
  const body = /=\s*\[([^\]]*)\]/.exec(source.slice(start));
  if (!body) throw new Error(`${constName} is not an array literal`);
  return [...body[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** The `@daintreehq/plugin-ui` entry of vite.config.ts's HOST_FACADE_REQUIRED_EXPORTS. */
export function facadeRequiredExports(viteConfigSource) {
  const table = viteConfigSource.slice(
    viteConfigSource.indexOf("const HOST_FACADE_REQUIRED_EXPORTS")
  );
  const entry = /"@daintreehq\/plugin-ui":\s*\[([^\]]*)\]/.exec(table);
  if (!entry) throw new Error("no @daintreehq/plugin-ui entry in HOST_FACADE_REQUIRED_EXPORTS");
  return [...entry[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/**
 * Every reason the built kit cannot be served as one import-map target: more
 * than one file, an import the page's map does not serve, a bundled React, or
 * exports that differ from the facade's contract. Empty when it can.
 */
export function validateKitBundle({ chunks, hostSpecifiers, requiredExports }) {
  const problems = [];
  if (chunks.length !== 1) {
    problems.push(
      `expected one JS file, got ${chunks.length}: ${chunks.map((c) => c.fileName).join(", ")}`
    );
  }
  const served = new Set(hostSpecifiers.filter((specifier) => REACT_SPECIFIER.test(specifier)));
  for (const chunk of chunks) {
    for (const specifier of [...chunk.imports, ...chunk.dynamicImports]) {
      // Rolldown lists a dynamic import it inlined as one of the file itself.
      if (specifier === chunk.fileName) continue;
      if (!served.has(specifier)) {
        problems.push(
          `${chunk.fileName} imports "${specifier}", which the import map does not serve`
        );
      }
    }
    for (const id of chunk.moduleIds) {
      if (REACT_IMPLEMENTATION.test(id)) {
        problems.push(`${chunk.fileName} bundles React itself (${id})`);
        break;
      }
    }
  }
  const actual = new Set(chunks.flatMap((chunk) => chunk.exports));
  const promised = new Set(requiredExports);
  const missing = requiredExports.filter((name) => !actual.has(name));
  const extra = [...actual].filter((name) => !promised.has(name));
  if (missing.length > 0) problems.push(`missing facade exports: ${missing.sort().join(", ")}`);
  if (extra.length > 0) problems.push(`exports outside the facade: ${extra.sort().join(", ")}`);
  return problems;
}

/**
 * The repository source files in the bundle, whose class names the stylesheet
 * covers. Dependencies are left out: none of them write the app's classes.
 */
export function scannableModules(moduleIds, root) {
  const files = new Set();
  for (const raw of moduleIds) {
    const id = raw.replace(/^\0/, "").replace(/\?.*$/, "");
    if (!path.isAbsolute(id) || /[\\/]node_modules[\\/]/.test(id)) continue;
    if (path.relative(root, id).startsWith("..")) continue;
    if (SCANNED_EXTENSIONS.has(path.extname(id))) files.add(id);
  }
  return [...files].sort();
}

/**
 * Every custom property a stylesheet reads through `var()`, sorted. The kit's
 * own sheets (syntax tokens, the data table, the colour area) read theme
 * variables the host compile emits only when something marks them used: passed
 * to `compiler.build` as candidates, they are declared in `preview.css` even
 * when no host rule or kit class happens to name them.
 */
export function readCustomProperties(css) {
  return [...new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]))].sort();
}

/**
 * The host's full-window rule (`html, body, #root` at 100% with overflow
 * hidden) clips a preview page that scrolls, so the preview drops it. Exactly
 * one must be found: a reworded rule would otherwise slip through unnoticed.
 */
export function dropFullWindowRule(css) {
  const rule = /(^|\n)html,\s*body,\s*#root\s*\{[^}]*\}/g;
  const matches = css.match(rule) ?? [];
  if (matches.length !== 1) {
    throw new Error(`expected one "html, body, #root" rule, found ${matches.length}`);
  }
  return css.replace(rule, "$1");
}

/**
 * Points every local `url()` at a copy beside the stylesheet. `resolveFrom` is
 * the directory the compiled sheet's relative urls are written against.
 * Returns the rewritten CSS and the files to copy (`source` → `target`, a path
 * relative to the stylesheet). A url to a file that is not there throws.
 */
export function rewriteLocalUrls(css, resolveFrom, exists, assetDir = "assets") {
  const assets = new Map();
  const taken = new Map();
  const rewritten = css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (whole, quote, url) => {
    if (/^(data:|https?:|#|\/\/)/.test(url)) return whole;
    const suffix = /[?#].*$/.exec(url)?.[0] ?? "";
    const source = path.resolve(resolveFrom, url.slice(0, url.length - suffix.length));
    if (!exists(source))
      throw new Error(`preview.css references ${url}, which is not at ${source}`);
    let target = assets.get(source);
    if (!target) {
      const base = path.basename(source);
      const claimed = taken.get(base);
      const name = claimed === undefined || claimed === source ? base : `${assets.size}-${base}`;
      taken.set(name, source);
      target = `${assetDir}/${name}`;
      assets.set(source, target);
    }
    return `url(${quote}./${target}${suffix}${quote})`;
  });
  return { css: rewritten, assets: [...assets].map(([source, target]) => ({ source, target })) };
}
