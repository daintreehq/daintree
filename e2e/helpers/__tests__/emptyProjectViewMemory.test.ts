import { describe, expect, it } from "vitest";
import type { HeapSnapshot } from "../heapSnapshot";
import {
  bucketVmmapRegions,
  median,
  parseTopFootprints,
  parseVmmapSize,
  parseVmmapSummary,
  summarizeHeapSnapshot,
  summarizeMemoryInfra,
} from "../emptyProjectViewMemory";

const VMMAP = `Process:         Daintree Helper (Renderer) [32347]
Physical footprint:         212.4M
Physical footprint (peak):  1.2G
Idle exit:                  untracked
----

                                VIRTUAL RESIDENT    DIRTY  SWAPPED VOLATILE   NONVOL    EMPTY   REGION
REGION TYPE                        SIZE     SIZE     SIZE     SIZE     SIZE     SIZE     SIZE    COUNT (non-coalesced)
===========                     ======= ========    =====  ======= ========   ======    =====  =======
IOSurface                         24.0M    24.0M    24.0M       0K       0K       0K       0K        3
MALLOC_MEDIUM                    256.0M    1408K    1408K     512K       0K       0K       0K        2         see MALLOC ZONE table below
MALLOC_SMALL (empty)              24.0M     112K     112K       0K       0K       0K       0K        3         see MALLOC ZONE table below
Memory Tag 255                   646.0M    4448K    4448K       0K       0K       0K       0K       32
Memory Tag 255 (reserved)           64K       0K       0K       0K       0K       0K       0K        1         reserved VM address space (unallocated)
__DATA_CONST                      12.2M    6876K     1888       0K       0K       0K       0K      314
===========                     ======= ========    =====  ======= ========   ======    =====  =======
TOTAL                              2.1G   201.7M    11.3M       0K       0K       0K       0K     1640

                                 VIRTUAL   RESIDENT      DIRTY    SWAPPED ALLOCATION      BYTES DIRTY+SWAP          REGION
MALLOC ZONE                         SIZE       SIZE       SIZE       SIZE      COUNT  ALLOCATED  FRAG SIZE  % FRAG   COUNT
`;

describe("parseVmmapSize", () => {
  it("reads bare numbers as bytes and suffixed numbers in binary units", () => {
    expect(parseVmmapSize("2048")).toBe(2);
    expect(parseVmmapSize("1408K")).toBe(1408);
    expect(parseVmmapSize("1.5M")).toBe(1536);
    expect(parseVmmapSize("2G")).toBe(2 * 1024 * 1024);
    expect(parseVmmapSize("see")).toBeNull();
  });
});

describe("parseVmmapSummary", () => {
  const summary = parseVmmapSummary(VMMAP);

  it("reads the footprint header lines", () => {
    expect(summary.physicalFootprintKb).toBeCloseTo(212.4 * 1024, 0);
    expect(summary.physicalFootprintPeakKb).toBe(1.2 * 1024 * 1024);
  });

  it("keeps region names that end in or contain numbers intact", () => {
    const names = summary.regions.map((r) => r.region);
    expect(names).toEqual([
      "IOSurface",
      "MALLOC_MEDIUM",
      "MALLOC_SMALL (empty)",
      "Memory Tag 255",
      "Memory Tag 255 (reserved)",
      "__DATA_CONST",
    ]);
    const tag = summary.regions.find((r) => r.region === "Memory Tag 255")!;
    expect(tag.columns.virtual).toBe(646 * 1024);
    expect(tag.columns.count).toBe(32);
  });

  it("stops at the end of the region table, before TOTAL and the malloc zones", () => {
    expect(summary.regions.some((r) => r.region.startsWith("TOTAL"))).toBe(false);
    expect(summary.regions.some((r) => r.region.includes("Zone"))).toBe(false);
  });

  it("returns no regions for output without a region table", () => {
    expect(parseVmmapSummary("vmmap: process not found").regions).toEqual([]);
  });
});

describe("bucketVmmapRegions", () => {
  it("groups dirty plus swapped size and drops clean regions", () => {
    const buckets = bucketVmmapRegions(parseVmmapSummary(VMMAP).regions);
    expect(buckets.malloc).toBe(1408 + 512 + 112);
    expect(buckets["gpu-shared"]).toBe(24 * 1024);
    expect(buckets["Memory Tag 255"]).toBe(4448);
    expect(buckets.libraries).toBeCloseTo(1888 / 1024, 1);
    expect("Memory Tag 255 (reserved)" in buckets).toBe(false);
  });
});

describe("summarizeMemoryInfra", () => {
  const dump = (pid: number, detail: string, allocators: Record<string, unknown>) => ({
    ph: "v",
    pid,
    id: `${pid}-${detail}`,
    args: { dumps: { level_of_detail: detail, allocators } },
  });
  const size = (bytes: number, effective?: number) => ({
    attrs: {
      size: { units: "bytes", value: bytes.toString(16) },
      ...(effective === undefined
        ? {}
        : { effective_size: { units: "bytes", value: effective.toString(16) } }),
    },
  });

  const trace = {
    traceEvents: [
      dump(7, "detailed", { malloc: size(99 << 20) }),
      dump(42, "detailed", {
        malloc: size(30 << 20, 20 << 20),
        v8: size(40 << 20),
        "v8/main/heap/code_space": size(4 << 20),
        "v8/main/heap/code_space/deep/node": size(8 << 20),
        "blink_gc/main": size(256 << 10),
      }),
      dump(42, "light", { malloc: size(1 << 20) }),
      { ph: "X", pid: 42, name: "unrelated" },
    ],
  };

  it("takes the target pid's detailed dump and decodes hex scalars", () => {
    const summary = summarizeMemoryInfra(trace, 42)!;
    expect(summary.dumpId).toBe("42-detailed");
    expect(summary.providers.malloc).toEqual({
      path: "malloc",
      sizeKb: 30 * 1024,
      effectiveSizeKb: 20 * 1024,
    });
    expect(summary.providers.v8.effectiveSizeKb).toBeNull();
  });

  it("limits detail by depth and size, largest first", () => {
    const paths = summarizeMemoryInfra(trace, 42, { maxDepth: 4, minKb: 512 })!.detail.map(
      (n) => n.path
    );
    expect(paths).toEqual(["v8", "malloc", "v8/main/heap/code_space"]);
  });

  it("returns null when the pid has no dump", () => {
    expect(summarizeMemoryInfra(trace, 1)).toBeNull();
    expect(summarizeMemoryInfra(null, 42)).toBeNull();
  });
});

describe("summarizeHeapSnapshot", () => {
  // Fields deliberately out of the usual order to prove lookup is by name.
  const snapshot: HeapSnapshot = {
    snapshot: {
      meta: {
        node_fields: ["name", "self_size", "type", "id"],
        node_types: [
          "string",
          "number",
          ["hidden", "object", "string", "code", "closure"],
          "number",
        ],
      },
    },
    strings: ["Map", "hello", "FiberNode", "render"],
    // prettier-ignore
    nodes: [
      0, 100, 1, 1,
      0, 300, 1, 2,
      2, 50, 1, 3,
      1, 2048, 2, 4,
      3, 1024, 3, 5,
      3, 10, 4, 6,
    ],
  };

  it("totals self size by type and by constructor, largest first", () => {
    const summary = summarizeHeapSnapshot(snapshot);
    expect(summary.nodeCount).toBe(6);
    expect(summary.byType.string).toBe(2);
    expect(summary.byType.object).toBeCloseTo(450 / 1024, 1);
    expect(summary.topGroups[0]).toEqual({ type: "string", name: "", count: 1, selfSizeKb: 2 });
    const map = summary.topGroups.find((g) => g.name === "Map")!;
    expect(map.count).toBe(2);
    expect(summary.topGroups.find((g) => g.type === "code")!.name).toBe("");
    expect(summary.topGroups.find((g) => g.type === "closure")!.name).toBe("render");
  });

  it("rejects a snapshot without the fields it needs", () => {
    expect(() =>
      summarizeHeapSnapshot({
        snapshot: { meta: { node_fields: ["id"], node_types: [] } },
        nodes: [],
        strings: [],
      })
    ).toThrow(/self_size/);
  });
});

describe("parseTopFootprints", () => {
  it("reads top's mem column in every unit it prints", () => {
    const parsed = parseTopFootprints("PID    MEM\n35493  1280K\n12  279M+\n13  1.5G\n14  512B\n");
    expect(Object.fromEntries(parsed)).toEqual({ 35493: 1280, 12: 279 * 1024, 13: 1572864, 14: 1 });
  });
});

describe("median", () => {
  it("handles odd, even and empty inputs", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
