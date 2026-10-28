import type { HeapSnapshot } from "./heapSnapshot";

/** One `vmmap -summary` region-type row, every size column in KiB. */
export interface VmmapRegion {
  region: string;
  columns: Record<string, number>;
}

export interface VmmapSummary {
  physicalFootprintKb: number | null;
  physicalFootprintPeakKb: number | null;
  regions: VmmapRegion[];
}

const SIZE_TOKEN = /^(\d+(?:\.\d+)?)([KMGT]?)$/;
const UNIT_TO_KB: Record<string, number> = {
  "": 1 / 1024,
  K: 1,
  M: 1024,
  G: 1024 * 1024,
  T: 1024 * 1024 * 1024,
};

/** vmmap prints `1888` for bytes and `1408K`/`256.0M` otherwise. */
export function parseVmmapSize(token: string): number | null {
  const match = SIZE_TOKEN.exec(token);
  if (!match) return null;
  return Math.round(Number(match[1]) * UNIT_TO_KB[match[2]] * 10) / 10;
}

/**
 * Parses the region-type table of `vmmap -summary <pid>`. Column names come
 * from the header so a macOS release that adds or drops a column still lines
 * up. Rows are anchored on the end of their numeric run, not the start,
 * because region names can end in a number ("Memory Tag 255").
 */
export function parseVmmapSummary(output: string): VmmapSummary {
  const lines = output.split("\n");
  const footprint = (label: string): number | null => {
    const line = lines.find((l) => l.startsWith(`${label}:`));
    const token = line
      ?.slice(label.length + 1)
      .trim()
      .split(/\s+/)[0];
    return token ? parseVmmapSize(token) : null;
  };

  const regions: VmmapRegion[] = [];
  const headerIndex = lines.findIndex((l) => /^REGION TYPE\s/.test(l));
  if (headerIndex > 0) {
    const names = lines[headerIndex - 1].trim().split(/\s+/);
    const columnCount = lines[headerIndex]
      .trim()
      .split(/\s+/)
      .filter((t) => t === "SIZE" || t === "COUNT").length;
    const columns = names.slice(0, columnCount).map((name, index) => {
      const lower = name.toLowerCase();
      return index === columnCount - 1 && lower === "region" ? "count" : lower;
    });

    let separators = 0;
    for (const line of lines.slice(headerIndex + 1)) {
      if (/^=+\s/.test(line)) {
        if (++separators === 2) break;
        continue;
      }
      if (separators !== 1 || line.trim() === "") continue;
      const tokens = line.trim().split(/\s+/);
      let first = -1;
      for (let start = 1; start < tokens.length && first < 0;) {
        if (!SIZE_TOKEN.test(tokens[start])) {
          start++;
          continue;
        }
        let end = start;
        while (end < tokens.length && SIZE_TOKEN.test(tokens[end])) end++;
        if (end - start >= columnCount) first = end - columnCount;
        start = end;
      }
      if (first < 0) continue;
      const row: Record<string, number> = {};
      columns.forEach((name, index) => {
        const token = tokens[first + index];
        row[name] = name === "count" ? Number(token) : (parseVmmapSize(token) ?? 0);
      });
      regions.push({ region: tokens.slice(0, first).join(" "), columns: row });
    }
  }

  return {
    physicalFootprintKb: footprint("Physical footprint"),
    physicalFootprintPeakKb: footprint("Physical footprint (peak)"),
    regions,
  };
}

/**
 * Groups vmmap regions into the buckets the empty-view investigation reports
 * on, by dirty size (resident pages the process wrote, which is what
 * footprint charges; reserved address space is not consumption).
 */
export function bucketVmmapRegions(regions: VmmapRegion[]): Record<string, number> {
  const buckets: Record<string, number> = {};
  for (const { region, columns } of regions) {
    if (region.startsWith("TOTAL")) continue;
    // Older macOS releases head the column SWAP rather than SWAPPED.
    const dirty = (columns.dirty ?? 0) + (columns.swapped ?? columns.swap ?? 0);
    if (dirty === 0) continue;
    const bucket = region.startsWith("MALLOC")
      ? "malloc"
      : region.startsWith("IOSurface") || region.startsWith("IOAccelerator")
        ? "gpu-shared"
        : region.startsWith("CoreAnimation") || region.startsWith("CG ")
          ? "graphics"
          : /^(__|unused but dirty shlib)/.test(region)
            ? "libraries"
            : region.startsWith("Stack")
              ? "stacks"
              : region;
    buckets[bucket] = Math.round(((buckets[bucket] ?? 0) + dirty) * 10) / 10;
  }
  return buckets;
}

interface TraceAllocatorNode {
  attrs?: Record<string, { units?: string; value?: string | number }>;
}

interface TraceEvent {
  ph?: string;
  pid?: number;
  id?: string;
  args?: { dumps?: { allocators?: Record<string, TraceAllocatorNode>; level_of_detail?: string } };
}

export interface MemoryInfraNode {
  path: string;
  sizeKb: number;
  effectiveSizeKb: number | null;
}

export interface MemoryInfraSummary {
  dumpId: string | null;
  levelOfDetail: string | null;
  /** Top-level providers (`malloc`, `partition_alloc`, `v8`, `blink_gc`, …). */
  providers: Record<string, MemoryInfraNode>;
  /** Every node at most `maxDepth` deep and at least `minKb`, largest first. */
  detail: MemoryInfraNode[];
}

function scalarBytes(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === "number") return value;
  const parsed = Number.parseInt(value, 16);
  return Number.isFinite(parsed) ? parsed : null;
}

const toKb = (bytes: number) => Math.round((bytes / 1024) * 10) / 10;

/**
 * Reduces a Chromium MemoryInfra trace to one process's last detailed dump.
 * Providers overlap (blink_gc and v8 back onto partition_alloc and malloc),
 * so the top-level sizes are reported side by side and never summed;
 * `effective_size` is kept when the trace carries it.
 */
export function summarizeMemoryInfra(
  trace: unknown,
  pid: number,
  options: { maxDepth?: number; minKb?: number } = {}
): MemoryInfraSummary | null {
  const maxDepth = options.maxDepth ?? 3;
  const minKb = options.minKb ?? 512;
  const events: TraceEvent[] = Array.isArray(trace)
    ? (trace as TraceEvent[])
    : (((trace as { traceEvents?: TraceEvent[] } | null)?.traceEvents ?? []) as TraceEvent[]);

  let chosen: TraceEvent | null = null;
  for (const event of events) {
    if (event.ph !== "v" || event.pid !== pid || !event.args?.dumps?.allocators) continue;
    if (!chosen || event.args.dumps.level_of_detail === "detailed") chosen = event;
  }
  if (!chosen) return null;

  const providers: Record<string, MemoryInfraNode> = {};
  const detail: MemoryInfraNode[] = [];
  for (const [path, node] of Object.entries(chosen.args!.dumps!.allocators!)) {
    const size = scalarBytes(node.attrs?.size?.value);
    if (size === null) continue;
    const effective = scalarBytes(node.attrs?.effective_size?.value);
    const entry: MemoryInfraNode = {
      path,
      sizeKb: toKb(size),
      effectiveSizeKb: effective === null ? null : toKb(effective),
    };
    const depth = path.split("/").length;
    if (depth === 1) providers[path] = entry;
    if (depth <= maxDepth && entry.sizeKb >= minKb) detail.push(entry);
  }
  detail.sort((a, b) => b.sizeKb - a.sizeKb);
  return {
    dumpId: chosen.id ?? null,
    levelOfDetail: chosen.args!.dumps!.level_of_detail ?? null,
    providers,
    detail,
  };
}

export interface HeapSnapshotGroup {
  type: string;
  name: string;
  count: number;
  selfSizeKb: number;
}

export interface HeapSnapshotSummary {
  totalSelfSizeKb: number;
  nodeCount: number;
  byType: Record<string, number>;
  topGroups: HeapSnapshotGroup[];
}

/**
 * Shallow (self-size) totals per node type and per `(type, name)` group.
 * This is where the bytes sit, not who keeps them alive: retained size needs
 * a dominator tree, which DevTools computes from the same snapshot file.
 */
export function summarizeHeapSnapshot(snapshot: HeapSnapshot, top = 25): HeapSnapshotSummary {
  const fields = snapshot.snapshot.meta.node_fields;
  const stride = fields.length;
  const typeIdx = fields.indexOf("type");
  const nameIdx = fields.indexOf("name");
  const sizeIdx = fields.indexOf("self_size");
  const typeNames = snapshot.snapshot.meta.node_types[typeIdx];
  if (stride === 0 || typeIdx < 0 || nameIdx < 0 || sizeIdx < 0 || !Array.isArray(typeNames)) {
    throw new Error("heap snapshot is missing type/name/self_size node fields");
  }

  const byType: Record<string, number> = {};
  const groups = new Map<string, HeapSnapshotGroup>();
  let total = 0;
  let nodeCount = 0;
  for (let i = 0; i + stride <= snapshot.nodes.length; i += stride) {
    const type = typeNames[snapshot.nodes[i + typeIdx]] ?? "unknown";
    const size = snapshot.nodes[i + sizeIdx];
    nodeCount++;
    total += size;
    byType[type] = (byType[type] ?? 0) + size;
    // Strings and numbers are named by their value; group them by type only.
    const name =
      type === "object" || type === "native" || type === "closure"
        ? (snapshot.strings[snapshot.nodes[i + nameIdx]] ?? "")
        : "";
    const key = `${type}\u0000${name}`;
    const group = groups.get(key) ?? { type, name, count: 0, selfSizeKb: 0 };
    group.count++;
    group.selfSizeKb += size;
    groups.set(key, group);
  }

  return {
    totalSelfSizeKb: toKb(total),
    nodeCount,
    byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, toKb(v)])),
    topGroups: [...groups.values()]
      .sort((a, b) => b.selfSizeKb - a.selfSizeKb)
      .slice(0, top)
      .map((group) => ({ ...group, selfSizeKb: toKb(group.selfSizeKb) })),
  };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Parses `top -l 1 -stats pid,mem` rows into KiB per pid. */
export function parseTopFootprints(output: string): Map<number, number> {
  const footprints = new Map<number, number>();
  for (const match of output.matchAll(/^(\d+)\s+([\d.]+)([BKMG])\+?-?\s*$/gm)) {
    const value = Number(match[2]);
    const kb =
      match[3] === "G"
        ? value * 1024 * 1024
        : match[3] === "M"
          ? value * 1024
          : match[3] === "K"
            ? value
            : value / 1024;
    footprints.set(Number(match[1]), Math.round(kb));
  }
  return footprints;
}
