#!/usr/bin/env node
// Holds the renderer's emitted startup chunks to the Radix overlay deferral
// (#17028): tooltips, popovers, menus and selects load through
// `src/components/ui/radix-deferred.ts` on first gesture, so none of their
// packages, nor what only they pull in (Floating UI, aria-hidden,
// react-remove-scroll), may ride in a chunk the renderer loads before first
// paint.
// `@radix-ui/react-dismissable-layer` is the sanctioned exception: AppDialog's
// `DialogDismissSurface` needs it synchronously, and `vite.config.ts` groups it
// with the eager `vendor-radix-utils` so it doesn't carry the overlays along.
//
// Reads what Vite actually shipped, after a production `npm run build`: one
// eager import of a module grouped into the overlay chunk preloads all of it,
// which only the emitted manifest, the per-file module lists and the
// modulepreload links in `index.html` show. Fails closed: a walked or preloaded
// chunk with no module list, or a seed missing from the manifest, is a failure,
// never a skipped check.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectClosure } from "../first-render-closure-lib.mjs";
import { findEntryKey } from "../check-renderer-import-budget.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const DIST = path.join(root, "dist");

/** The overlay family `radix-deferred.ts` loads lazily, and everything only it pulls in. */
const DEFERRED_RADIX_PACKAGES = [
  "react-tooltip",
  "react-popover",
  "react-dropdown-menu",
  "react-select",
  "react-context-menu",
  "react-menu",
  "react-dialog",
  "react-popper",
  "react-arrow",
  "react-collection",
  "react-roving-focus",
  "react-focus-scope",
  "react-focus-guards",
  "react-portal",
  "react-visually-hidden",
  "react-direction",
];
const DEFERRED_RADIX_MODULE = new RegExp(
  `(^|/)node_modules/@radix-ui/(${DEFERRED_RADIX_PACKAGES.join("|")})/`
);
const FLOATING_UI_MODULE = /(^|\/)node_modules\/@floating-ui\//;
/** What only the popover, menu and select overlays pull in from outside `@radix-ui`. */
const OVERLAY_ONLY_PACKAGES = ["aria-hidden", "react-remove-scroll", "react-remove-scroll-bar"];
const OVERLAY_ONLY_MODULE = new RegExp(`(^|/)node_modules/(${OVERLAY_ONLY_PACKAGES.join("|")})/`);
const RADIX_DEFERRED_BARREL = "src/components/ui/radix-deferred.ts";

const stripQuery = (id) => id.replace(/[?#].*$/, "");

/** @param {string} id a repo-relative module id from the build's module lists */
export function deferredOverlayFamily(id) {
  if (DEFERRED_RADIX_MODULE.test(id)) return "a deferred Radix overlay";
  if (FLOATING_UI_MODULE.test(id)) return "Floating UI";
  if (OVERLAY_ONLY_MODULE.test(id)) return "an overlay-only dependency";
  if (id === RADIX_DEFERRED_BARREL) return "the deferred Radix barrel";
  return null;
}

const LINK_TAG = /<link\b([^>]*)>/gi;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Attribute names are case-insensitive and the first occurrence wins, as in an HTML parser. */
function linkAttributes(source) {
  const attributes = new Map();
  for (const [, name, doubleQuoted, singleQuoted, bare] of source.matchAll(ATTRIBUTE)) {
    const key = name.toLowerCase();
    if (!attributes.has(key)) attributes.set(key, doubleQuoted ?? singleQuoted ?? bare ?? "");
  }
  return attributes;
}

/** `<link rel="modulepreload" href="./assets/x.js">` → `assets/x.js`, the key the module lists use. */
export function modulePreloadFiles(html) {
  const files = [];
  for (const [, source] of html.matchAll(LINK_TAG)) {
    const attributes = linkAttributes(source);
    const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
    const href = attributes.get("href");
    if (rel.includes("modulepreload") && href) {
      files.push(stripQuery(href.replace(/^(\.?\/)+/, "")));
    }
  }
  return files;
}

/**
 * @param {{
 *   manifest: Record<string, { file: string, imports?: string[], dynamicImports?: string[], isEntry?: boolean }>,
 *   modulesByFile: Record<string, string[]>,
 *   seeds: string[],
 *   preloadFiles: string[],
 * }} build
 * @returns {string[]} one line per problem; empty is the only pass
 */
export function checkRadixOverlayBundles({ manifest, modulesByFile, seeds, preloadFiles }) {
  const entryKey = findEntryKey(manifest);
  if (entryKey === null) return ["the manifest has no renderer entry chunk"];
  const problems = [];
  if (seeds.length === 0) problems.push("the build named no first-render seeds");
  // The lists are only evidence if they hold what the walk starts from.
  if (modulesByFile[manifest[entryKey].file]?.length === 0) {
    problems.push(`the entry chunk ${manifest[entryKey].file} lists no modules`);
  }
  for (const seed of seeds) {
    if (!manifest[seed]) {
      problems.push(`first-render seed ${seed} is not in the manifest`);
      continue;
    }
    const members = modulesByFile[manifest[seed].file];
    if (Array.isArray(members) && !members.some((id) => stripQuery(id) === seed)) {
      problems.push(`first-render seed ${seed} is missing from its own chunk's module list`);
    }
  }
  // The first-render preload plugin always links the entry's closure, so an
  // empty list means the HTML wasn't read right, not that nothing preloads.
  if (preloadFiles.length === 0) problems.push("index.html names no modulepreload links");

  const scanFile = (label, file) => {
    const members = modulesByFile[file];
    if (!Array.isArray(members)) {
      problems.push(`${label}: no module list for ${file}`);
      return;
    }
    for (const id of new Set(members.map(stripQuery))) {
      const family = deferredOverlayFamily(id);
      if (family) problems.push(`${label}: ${family} in ${file} — ${id}`);
    }
  };

  const graphs = [
    { label: "the renderer's eager graph", roots: [entryKey] },
    { label: "the first-render graph", roots: [entryKey, ...seeds] },
  ];
  for (const { label, roots } of graphs) {
    const chunks = collectClosure(roots, {
      getNode: (key) => manifest[key],
      getStaticImports: (chunk) => chunk.imports,
      getDynamicImports: (chunk) => chunk.dynamicImports,
      followDynamic: false,
    });
    for (const key of chunks) {
      // The closure walk skips an edge it cannot follow; here that is a gap.
      for (const dependency of manifest[key].imports ?? []) {
        if (!manifest[dependency]) {
          problems.push(`${label}: ${key} imports ${dependency}, which the manifest lacks`);
        }
      }
      scanFile(label, manifest[key].file);
    }
  }
  for (const file of new Set(preloadFiles)) scanFile("index.html modulepreload", file);
  return problems;
}

function readDist(file, parse = JSON.parse) {
  if (!existsSync(file)) {
    console.error(`::error::${path.relative(root, file)} not found — run \`npm run build\` first`);
    process.exit(1);
  }
  return parse(readFileSync(file, "utf8"));
}

function main() {
  const problems = checkRadixOverlayBundles({
    manifest: readDist(path.join(DIST, ".vite", "manifest.json")),
    modulesByFile: readDist(path.join(DIST, "chunk-modules-by-file.json")),
    seeds: readDist(path.join(DIST, ".vite", "first-render-seeds.json")),
    preloadFiles: readDist(path.join(DIST, "index.html"), modulePreloadFiles),
  });
  if (problems.length === 0) {
    console.log("[radix-overlay-bundles] startup chunks carry no deferred Radix overlay code");
    return;
  }
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
