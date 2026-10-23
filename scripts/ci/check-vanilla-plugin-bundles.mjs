#!/usr/bin/env node
// Holds the renderer's emitted startup chunks to the vanilla-install rule
// (#14129): code of a built-in plugin that ships disabled must not load before
// anyone enables it. Each such plugin may register its views from a tiny entry
// at module eval (`src/registry/builtinPluginRenderers.ts` globs those on
// purpose), but its editor, controllers and guest code ride in lazy chunks.
//
// Reads what Vite actually shipped, after a production `npm run build`: chunk
// grouping can pull a lazily imported module into a chunk the entry imports
// statically, which only the emitted manifest and per-file module lists show.
// Fails closed: a walked chunk with no module list, or a seed missing from the
// manifest, is a failure, never a skipped check.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectClosure } from "../first-render-closure-lib.mjs";
import { findEntryKey } from "../check-renderer-import-budget.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const DIST = path.join(root, "dist");

/** `daintree.linear` ships its sources under `plugins/builtin/linear/`. */
export function disabledBuiltinDirs(defaultsSource) {
  const ids = [...defaultsSource.matchAll(/"daintree\.([a-z0-9-]+)"/g)].map((m) => m[1]);
  return ids.map((name) => `plugins/builtin/${name}/`);
}

/** What a disabled plugin may put in the startup closure: its registration stub and the ids it imports. */
const ALLOWED_STARTUP_FILE =
  /\/(renderer\/(index\.tsx?|recoverDrafts\.ts)|shared\/ids\.[cm]?[jt]s)$/;

/**
 * @param {{
 *   manifest: Record<string, { file: string, imports?: string[], dynamicImports?: string[], isEntry?: boolean }>,
 *   modulesByFile: Record<string, string[]>,
 *   seeds: string[],
 *   disabledDirs: string[],
 * }} build
 * @returns {string[]} one line per problem; empty is the only pass
 */
export function checkVanillaPluginBundles({ manifest, modulesByFile, seeds, disabledDirs }) {
  const entryKey = findEntryKey(manifest);
  if (entryKey === null) return ["the manifest has no renderer entry chunk"];
  const problems = [];
  if (disabledDirs.length === 0) problems.push("no default-disabled built-in plugins were found");
  if (seeds.length === 0) problems.push("the build named no first-render seeds");
  for (const seed of seeds) {
    if (!manifest[seed]) problems.push(`first-render seed ${seed} is not in the manifest`);
  }

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
      for (const dependency of manifest[key].imports ?? []) {
        if (!manifest[dependency]) {
          problems.push(`${label}: ${key} imports ${dependency}, which the manifest lacks`);
        }
      }
      const members = modulesByFile[manifest[key].file];
      if (!Array.isArray(members)) {
        problems.push(`${label}: no module list for ${manifest[key].file}`);
        continue;
      }
      for (const id of new Set(members.map((member) => member.replace(/[?#].*$/, "")))) {
        const dir = disabledDirs.find((candidate) => id.startsWith(candidate));
        if (dir && !ALLOWED_STARTUP_FILE.test(id)) {
          problems.push(`${label}: ${dir} code outside its registration stub — ${id}`);
        }
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
  const problems = checkVanillaPluginBundles({
    manifest: readJson(path.join(DIST, ".vite", "manifest.json")),
    modulesByFile: readJson(path.join(DIST, "chunk-modules-by-file.json")),
    seeds: readJson(path.join(DIST, ".vite", "first-render-seeds.json")),
    disabledDirs: disabledBuiltinDirs(
      readFileSync(path.join(root, "shared", "config", "pluginDefaults.ts"), "utf8")
    ),
  });
  if (problems.length === 0) {
    console.log("[vanilla-plugin-bundles] startup chunks carry no default-disabled plugin code");
    return;
  }
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
