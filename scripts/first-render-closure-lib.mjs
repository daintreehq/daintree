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
