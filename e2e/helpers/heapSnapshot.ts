import { readFileSync, rmSync } from "fs";

// V8 heap snapshot format: a flat-array graph. `nodes` is a packed integer
// array stepped by `node_fields.length`; field meaning comes from `node_fields`
// and `node_types`. Strings (including class names) are interned in `strings`.
//
// Reference: https://v8.dev/blog/custom-startup-snapshots — the .heapsnapshot
// JSON shape has been stable across V8 versions since 2016.
export interface HeapSnapshot {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: Array<string[] | string>;
    };
  };
  nodes: number[];
  strings: string[];
}

export function parseHeapSnapshot(filePath: string): HeapSnapshot {
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw) as HeapSnapshot;
}

/**
 * Count the number of object nodes in the snapshot whose constructor name
 * matches `className`. Returns 0 if the class name does not appear in the
 * snapshot's interned string table.
 *
 * Note: TypeScript `interface`s are erased at compile time and never appear
 * here — only ES6 classes (or anything else with a real constructor name)
 * are visible. Use this primarily as a diagnostic / observability signal.
 */
export function countInstancesByName(snapshot: HeapSnapshot, className: string): number {
  const fields = snapshot.snapshot.meta.node_fields;
  const nodeSize = fields.length;
  const typeIdx = fields.indexOf("type");
  const nameIdx = fields.indexOf("name");
  if (typeIdx === -1 || nameIdx === -1) return 0;

  const typeEnum = snapshot.snapshot.meta.node_types[typeIdx];
  if (!Array.isArray(typeEnum)) return 0;
  const objectTypeIndex = typeEnum.indexOf("object");
  if (objectTypeIndex === -1) return 0;

  const classNameStrIdx = snapshot.strings.indexOf(className);
  if (classNameStrIdx === -1) return 0;

  let count = 0;
  for (let i = 0; i < snapshot.nodes.length; i += nodeSize) {
    if (
      snapshot.nodes[i + typeIdx] === objectTypeIndex &&
      snapshot.nodes[i + nameIdx] === classNameStrIdx
    ) {
      count++;
    }
  }
  return count;
}

export function cleanupHeapSnapshot(filePath: string): void {
  try {
    rmSync(filePath, { force: true });
  } catch {
    // best-effort cleanup
  }
}
