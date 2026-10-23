#!/usr/bin/env node
// Holds the renderer's emitted startup chunks to the Element Picker's lazy
// budget (#13889): nothing a picker session loads — its guest scripts, its
// resolver host, any compiler, parser or map decoder — may ride in a chunk the
// renderer loads before anyone opens the picker, and of the picker's own UI
// only the toolbar's tool definition may.
//
// `scripts/lazy-compiler-boundary.test.ts` proves the same of esbuild's graph
// of the tool's entry. This reads what Vite actually shipped, after a
// production `npm run build`: chunk grouping can put a lazily imported module
// into a chunk the entry imports statically, and only the emitted manifest and
// the build's per-file module lists can show that.
//
// Fails closed: a walked chunk with no module list, or a seed that is not in
// the manifest, is a failure, never a skipped check.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ELEMENT_PICKER_FRAMEWORK_PATTERNS, scanForbiddenModules } from "../import-budget-lib.mjs";
import { collectClosure } from "../first-render-closure-lib.mjs";
import { findEntryKey } from "../check-renderer-import-budget.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const DIST = path.join(root, "dist");

const PICKER_UI_DIR = "src/panels/dev-preview/element-picker/";

/** What every dev preview's toolbar imports: the tool's definition, its button and its id. */
export const EAGER_PICKER_UI = new Set(
  ["elementPickerTool.ts", "ElementPickerButton.tsx", "toolId.ts"].map(
    (file) => `${PICKER_UI_DIR}${file}`
  )
);

/**
 * @param {{
 *   manifest: Record<string, { file: string, src?: string, imports?: string[], dynamicImports?: string[], isEntry?: boolean, name?: string }>,
 *   modulesByFile: Record<string, string[]>,
 *   seeds: string[],
 * }} build
 * @returns {string[]} one line per problem; empty is the only pass
 */
export function checkElementPickerBundles({ manifest, modulesByFile, seeds }) {
  const entryKey = findEntryKey(manifest);
  if (entryKey === null) return ["the manifest has no renderer entry chunk"];
  const problems = [];
  // The lists are only evidence if they hold what the walk starts from.
  if (modulesByFile[manifest[entryKey].file]?.length === 0) {
    problems.push(`the entry chunk ${manifest[entryKey].file} lists no modules`);
  }
  if (seeds.length === 0) problems.push("the build named no first-render seeds");
  for (const seed of seeds) {
    if (!manifest[seed]) problems.push(`first-render seed ${seed} is not in the manifest`);
  }

  const graphs = [
    { label: "the renderer's eager graph", roots: [entryKey], owners: [] },
    { label: "the first-render graph", roots: [entryKey, ...seeds], owners: seeds },
  ];
  for (const { label, roots, owners } of graphs) {
    const chunks = collectClosure(roots, {
      getNode: (key) => manifest[key],
      getStaticImports: (chunk) => chunk.imports,
      getDynamicImports: (chunk) => chunk.dynamicImports,
      followDynamic: false,
    });
    const modules = [];
    for (const key of chunks) {
      const members = modulesByFile[manifest[key].file];
      if (!Array.isArray(members)) {
        problems.push(`${label}: no module list for ${manifest[key].file}`);
        continue;
      }
      modules.push(...members);
    }
    for (const source of owners) {
      if (manifest[source] && !modules.includes(source)) {
        problems.push(`${label}: ${source} is missing from its own chunk's module list`);
      }
    }
    for (const { file, label: family } of scanForbiddenModules(
      modules,
      ELEMENT_PICKER_FRAMEWORK_PATTERNS
    )) {
      problems.push(`${label}: ${family} — ${file}`);
    }
    for (const file of new Set(modules)) {
      if (file.startsWith(PICKER_UI_DIR) && !EAGER_PICKER_UI.has(file)) {
        problems.push(`${label}: Element Picker UI beyond the toolbar's tool — ${file}`);
      }
    }
  }
  return problems;
}

function readJson(file) {
  if (!existsSync(file)) {
    console.error(`::error::${path.relative(root, file)} not found — run \`npm run build\` first`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function main() {
  const problems = checkElementPickerBundles({
    manifest: readJson(path.join(DIST, ".vite", "manifest.json")),
    modulesByFile: readJson(path.join(DIST, "chunk-modules-by-file.json")),
    seeds: readJson(path.join(DIST, ".vite", "first-render-seeds.json")),
  });
  if (problems.length === 0) {
    console.log("[element-picker-bundles] the renderer's startup chunks carry no picker code");
    return;
  }
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
