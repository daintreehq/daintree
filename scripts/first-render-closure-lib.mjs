// Generic chunk-graph closure walk shared by two consumers that traverse the
// SAME first-render dependency graph through different key schemes:
//
//   • scripts/check-first-render-chunk-budget.mjs walks the Vite MANIFEST,
//     where nodes are keyed by source path and `imports[]` / `dynamicImports[]`
//     reference other source-path keys.
//   • the firstRenderModulePreloadPlugin in vite.config.ts walks the Rolldown
//     OutputBundle, where chunks are keyed by hashed file name and `imports[]`
//     / `dynamicImports[]` reference other file names.
//
// Both schemes are the same BFS over a directed graph; only the node lookup and
// the edge accessors differ. Parameterizing those accessors lets ONE traversal
// serve both, so the gated budget closure and the injected preload set cannot
// drift — the whole point of #9771.
//
// `followDynamic` selects the closure semantics:
//   • false (eager) — follow only `imports[]`: the entry plus everything
//     statically reachable from it and from the explicit first-render seeds.
//     This is the "download before interactive" set and the gated metric.
//   • true  (total) — follow `imports[]` and `dynamicImports[]`: the entire
//     reachable bundle. Report-only.
//
// Seeds are always enqueued explicitly (if present) regardless of
// `followDynamic` — they're first-paint paths by definition (a persisted
// browser/dev-preview/review panel restores synchronously), not edges
// discovered by walking `dynamicImports[]`.
//
// Identity is the node KEY, so a chunk shared via multiple edges (vendor-react
// imported by both the entry and vendor-motion) is visited exactly once. A seed
// or edge that doesn't resolve to a node is skipped, so a dangling reference
// never enters the closure.
export function collectClosure(
  seedKeys,
  { getNode, getStaticImports, getDynamicImports, followDynamic = false } = {}
) {
  const visited = new Set();
  const queue = [];

  for (const seed of seedKeys) {
    if (getNode(seed)) queue.push(seed);
  }

  while (queue.length > 0) {
    const key = queue.shift();
    if (visited.has(key)) continue;

    const node = getNode(key);
    if (!node) continue;
    visited.add(key);

    for (const dep of getStaticImports(node) ?? []) queue.push(dep);
    if (followDynamic) {
      for (const dep of getDynamicImports(node) ?? []) queue.push(dep);
    }
  }

  return visited;
}

// Computes the set of output file names to inject as `<link rel="modulepreload">`
// for the first-render seed chunks, given a Rolldown OutputBundle's chunks. This
// is the pure core of the firstRenderModulePreloadPlugin (vite.config.ts),
// factored out so the seed-matching, entry-subtraction, and eager-only traversal
// are unit-testable without the Vite build machinery.
//
//   • `chunks` — iterable of bundle outputs ({ type, fileName, isEntry,
//     facadeModuleId, imports[], dynamicImports[] }). Non-"chunk" outputs
//     (CSS/assets) are ignored, so no asset is ever preloaded as a module.
//   • `seedSourcePaths` — Set of repo-relative POSIX source paths from the panel
//     registry (getFirstRenderSeeds). A chunk is a seed when its facadeModuleId,
//     normalized via `toRelativePosix`, is in this set.
//   • `toRelativePosix` — maps an absolute facadeModuleId to the repo-relative
//     POSIX form for comparison against the seeds (kept as a callback so this
//     module stays free of node:path and cwd).
//
// Returns `{ files, matchedSeedCount }`. `files` is the eager static closure of
// the matched seed chunks MINUS the entry chunks' eager static closure (what
// Vite already auto-preloads), sorted and deduplicated — never following a
// dynamicImports[] edge, so deferred subtrees stay off the first-paint path.
// `matchedSeedCount` lets the caller warn on zero / partial seed resolution.
export function computeFirstRenderPreloadFiles(chunks, seedSourcePaths, toRelativePosix) {
  const chunksByFileName = new Map();
  const seedFileNames = [];
  const entryFileNames = [];

  for (const output of chunks) {
    if (output.type !== "chunk") continue;
    chunksByFileName.set(output.fileName, output);
    if (output.isEntry) entryFileNames.push(output.fileName);
    if (output.facadeModuleId && seedSourcePaths.has(toRelativePosix(output.facadeModuleId))) {
      seedFileNames.push(output.fileName);
    }
  }

  if (seedFileNames.length === 0) {
    return { files: [], matchedSeedCount: 0 };
  }

  const options = {
    getNode: (fileName) => chunksByFileName.get(fileName),
    getStaticImports: (chunk) => chunk.imports,
    getDynamicImports: (chunk) => chunk.dynamicImports,
    followDynamic: false,
  };

  const seedClosure = collectClosure(seedFileNames, options);
  const entryClosure = collectClosure(entryFileNames, options);
  const files = [...seedClosure].filter((fileName) => !entryClosure.has(fileName)).sort();
  return { files, matchedSeedCount: seedFileNames.length };
}
