// The plugin UI kit must bundle for a plain browser page (the plugin preview),
// so its module graph may not reach the app's wiring: the barrels that re-export
// every hook and store, ActionService and its action definitions, the IPC
// clients and the panel registry. The kit gets those behaviours through
// `src/components/PluginKit/kitHost.ts` instead, which the app fills at boot.

// Dynamic imports count: a preview that renders a DiffView loads the lazy
// chunk too, so a forbidden module behind `import()` breaks it just the same.
export const KIT_EDGE_KINDS = new Set(["import-statement", "require-call", "dynamic-import"]);

export const KIT_ENTRIES = ["src/pluginUi/index.ts", "src/pluginUi/kit.tsx"];

export const FORBIDDEN_KIT_MODULES = [
  { label: "the @/hooks barrel", test: (p) => p === "src/hooks/index.ts" },
  { label: "the @/store barrel", test: (p) => p === "src/store/index.ts" },
  { label: "ActionService", test: (p) => p === "src/services/ActionService.ts" },
  { label: "an IPC client", test: (p) => p.startsWith("src/clients/") },
  { label: "the registry", test: (p) => p.startsWith("src/registry/") },
  { label: "the panel registry", test: (p) => p === "src/panels/registry.tsx" },
];

function forbiddenLabel(path, forbidden) {
  for (const rule of forbidden) if (rule.test(path)) return rule.label;
  return null;
}

/**
 * Breadth-first from every entry, so each forbidden module is reported with
 * the shortest chain that reaches it. Externals (packages) have no inputs
 * entry and end the walk there.
 */
export function findForbiddenKitReach(metafile, entries, forbidden = FORBIDDEN_KIT_MODULES) {
  const inputs = metafile.inputs ?? {};
  const parent = new Map();
  const queue = [];
  for (const entry of entries) {
    if (!inputs[entry]) throw new Error(`entry ${entry} is not in the metafile`);
    if (parent.has(entry)) continue;
    parent.set(entry, null);
    queue.push(entry);
  }
  const hits = [];
  for (let at = 0; at < queue.length; at++) {
    const file = queue[at];
    const label = forbiddenLabel(file, forbidden);
    if (label) {
      const chain = [];
      for (let step = file; step !== null; step = parent.get(step)) chain.unshift(step);
      hits.push({ module: file, label, chain });
      // Whatever lies past a forbidden module is reported through it.
      continue;
    }
    for (const edge of inputs[file]?.imports ?? []) {
      if (edge.external || !KIT_EDGE_KINDS.has(edge.kind)) continue;
      if (!inputs[edge.path] || parent.has(edge.path)) continue;
      parent.set(edge.path, file);
      queue.push(edge.path);
    }
  }
  return { hits, moduleCount: parent.size };
}

export function formatKitReach(hits) {
  return hits.map(({ label, chain }) => `${label}: ${chain.join(" > ")}`).join("\n");
}
