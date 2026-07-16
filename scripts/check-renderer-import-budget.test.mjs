import { describe, it, expect } from "vitest";
import {
  collectEagerChunks,
  compareReport,
  findEntryKey,
  parseArgs,
  shrinkageGuardError,
  stableChunkId,
} from "./check-renderer-import-budget.mjs";

// Synthetic manifest mirroring the Vite 8 / Rolldown shape: top-level keys are
// either source paths (for entries) or `_shared-*.js` keys for shared chunks,
// each entry has a `file`, optional `isEntry`, and `imports[]` / `dynamicImports[]`
// arrays of manifest keys.
function makeManifest(extra = {}) {
  return {
    "src/main.tsx": {
      file: "assets/index-abc.js",
      isEntry: true,
      imports: ["_vendor-react.js", "_vendor-xterm.js"],
      dynamicImports: ["src/components/Browser/BrowserPane.tsx"],
    },
    "_vendor-react.js": {
      file: "assets/vendor-react-def.js",
      imports: [],
      dynamicImports: [],
    },
    "_vendor-xterm.js": {
      file: "assets/vendor-xterm-ghi.js",
      imports: ["_vendor-react.js"],
      dynamicImports: [],
    },
    "src/components/Browser/BrowserPane.tsx": {
      file: "assets/BrowserPane-jkl.js",
      imports: ["_vendor-browser.js"],
      dynamicImports: [],
    },
    "_vendor-browser.js": {
      file: "assets/vendor-browser-mno.js",
      imports: [],
      dynamicImports: [],
    },
    ...extra,
  };
}

// vite.config.ts emits five `host-react-*` React facade entry chunks for the
// plugin import map (#11208). They are `isEntry: true` but are not the app, and
// manifest key order is not specified — so the gate must identify the app entry
// by more than "first entry wins" or it silently measures a re-export shim.
describe("findEntryKey", () => {
  it("skips host-react facade entries that precede the app entry", () => {
    const manifest = {
      "\0virtual:daintree-host-react/react": {
        file: "assets/host-react-react-aaa.js",
        name: "host-react-react",
        isEntry: true,
        imports: ["_vendor-react.js"],
        dynamicImports: [],
      },
      ...makeManifest(),
    };
    expect(findEntryKey(manifest)).toBe("src/main.tsx");
  });

  it("identifies a facade by its file path when the manifest carries no name", () => {
    const manifest = {
      "\0virtual:daintree-host-react/react-dom/client": {
        file: "assets/host-react-react-dom-client-bbb.js",
        isEntry: true,
        imports: ["_vendor-react.js"],
        dynamicImports: [],
      },
      ...makeManifest(),
    };
    expect(findEntryKey(manifest)).toBe("src/main.tsx");
  });

  it("does not mistake a real chunk for a facade just because it imports react", () => {
    expect(findEntryKey(makeManifest())).toBe("src/main.tsx");
  });

  it("returns null when the manifest has only facade entries", () => {
    const manifest = {
      "\0virtual:daintree-host-react/react": {
        file: "assets/host-react-react-aaa.js",
        name: "host-react-react",
        isEntry: true,
        imports: [],
        dynamicImports: [],
      },
    };
    expect(findEntryKey(manifest)).toBeNull();
  });
});

describe("collectEagerChunks", () => {
  it("walks imports[] from the entry key", () => {
    const manifest = makeManifest();
    const closure = collectEagerChunks(manifest, "src/main.tsx");
    expect([...closure].sort()).toEqual(["_vendor-react.js", "_vendor-xterm.js", "src/main.tsx"]);
  });

  it("does NOT walk dynamicImports[] (the whole point of the gate)", () => {
    const manifest = makeManifest();
    const closure = collectEagerChunks(manifest, "src/main.tsx");
    expect(closure.has("src/components/Browser/BrowserPane.tsx")).toBe(false);
    expect(closure.has("_vendor-browser.js")).toBe(false);
  });

  it("visits each shared chunk exactly once even when reachable via multiple paths", () => {
    // Both src/main.tsx AND _vendor-xterm.js import _vendor-react.js. The
    // BFS must not double-count it. (Identity = manifest key.)
    const manifest = makeManifest();
    const closure = collectEagerChunks(manifest, "src/main.tsx");
    const reactChunks = [...closure].filter((k) => k === "_vendor-react.js");
    expect(reactChunks.length).toBe(1);
  });

  it("returns an empty set when the entry key is not in the manifest", () => {
    const manifest = makeManifest();
    const closure = collectEagerChunks(manifest, "src/missing-entry.tsx");
    expect(closure.size).toBe(0);
  });

  it("tolerates chunks with missing imports/dynamicImports arrays", () => {
    const manifest = {
      "src/main.tsx": { file: "a.js", isEntry: true, imports: ["_x.js"] },
      "_x.js": { file: "x.js" }, // no imports/dynamicImports at all
    };
    const closure = collectEagerChunks(manifest, "src/main.tsx");
    expect([...closure].sort()).toEqual(["_x.js", "src/main.tsx"]);
  });

  it("skips imports referencing keys not present in the manifest (not counted)", () => {
    const manifest = {
      "src/main.tsx": {
        file: "a.js",
        isEntry: true,
        imports: ["_missing.js", "_present.js"],
      },
      "_present.js": { file: "p.js", imports: [] },
    };
    const closure = collectEagerChunks(manifest, "src/main.tsx");
    expect(closure.has("_present.js")).toBe(true);
    expect(closure.has("src/main.tsx")).toBe(true);
    // Missing key is NOT added to the closure — the gate measures real chunks.
    expect(closure.has("_missing.js")).toBe(false);
  });
});

describe("stableChunkId", () => {
  it("returns chunk.name when set (the hash-stripped identity)", () => {
    const manifest = {
      "_vendor-react-CSdVl0cc.js": {
        name: "vendor-react",
        file: "assets/vendor-react-CSdVl0cc.js",
      },
    };
    expect(stableChunkId(manifest, "_vendor-react-CSdVl0cc.js")).toBe("vendor-react");
  });

  it("falls back to the manifest key when name is absent", () => {
    const manifest = {
      "src/main.tsx": { file: "assets/index-abc.js", isEntry: true },
    };
    expect(stableChunkId(manifest, "src/main.tsx")).toBe("src/main.tsx");
  });

  it("falls back to the manifest key when name is not a string", () => {
    const manifest = { _x: { file: "x.js", name: 42 } };
    expect(stableChunkId(manifest, "_x")).toBe("_x");
  });
});

describe("shrinkageGuardError", () => {
  const THRESHOLD = 0.1; // 10%

  it("returns null when next count is unchanged", () => {
    expect(shrinkageGuardError(100, 100, THRESHOLD)).toBeNull();
  });

  it("returns null when next count grows (not a shrinkage)", () => {
    expect(shrinkageGuardError(100, 120, THRESHOLD)).toBeNull();
  });

  it("returns null when shrinkage is below threshold (5%)", () => {
    expect(shrinkageGuardError(100, 95, THRESHOLD)).toBeNull();
  });

  it("returns null at exactly the threshold (10% drop)", () => {
    expect(shrinkageGuardError(100, 90, THRESHOLD)).toBeNull();
  });

  it("returns an error message when shrinkage exceeds threshold (11% drop)", () => {
    const err = shrinkageGuardError(100, 89, THRESHOLD);
    expect(err).not.toBeNull();
    expect(err).toContain("100");
    expect(err).toContain("89");
  });

  it("returns null when priorCount is 0 (initial state)", () => {
    expect(shrinkageGuardError(0, 50, THRESHOLD)).toBeNull();
  });

  it("returns null when priorCount is missing (no baseline)", () => {
    expect(shrinkageGuardError(undefined, 50, THRESHOLD)).toBeNull();
    expect(shrinkageGuardError(null, 50, THRESHOLD)).toBeNull();
  });
});

describe("compareReport", () => {
  it("returns ok when current count equals baseline", () => {
    const report = { eagerChunkCount: 3, eagerChunks: ["a", "b", "c"] };
    const baseline = { eagerChunkCount: 3, eagerChunks: ["a", "b", "c"] };
    const result = compareReport(report, baseline);
    expect(result.ok).toBe(true);
    expect(result.grew).toBeUndefined();
  });

  it("flags grew=true when count exceeds baseline, listing added chunks", () => {
    const report = { eagerChunkCount: 4, eagerChunks: ["a", "b", "c", "NEW"] };
    const baseline = { eagerChunkCount: 3, eagerChunks: ["a", "b", "c"] };
    const result = compareReport(report, baseline);
    expect(result.ok).toBe(false);
    expect(result.grew).toBe(true);
    expect(result.added).toEqual(["NEW"]);
    expect(result.removed).toEqual([]);
  });

  it("flags shrank=true when count drops below baseline (still ok, emit notice)", () => {
    const report = { eagerChunkCount: 2, eagerChunks: ["a", "b"] };
    const baseline = { eagerChunkCount: 3, eagerChunks: ["a", "b", "GONE"] };
    const result = compareReport(report, baseline);
    expect(result.ok).toBe(true);
    expect(result.shrank).toBe(true);
    expect(result.removed).toEqual(["GONE"]);
    expect(result.added).toEqual([]);
  });

  it("returns error when baseline.eagerChunkCount is missing", () => {
    const report = { eagerChunkCount: 3, eagerChunks: ["a", "b", "c"] };
    const result = compareReport(report, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("eagerChunkCount");
  });

  it("returns error when baseline.eagerChunkCount is negative", () => {
    const report = { eagerChunkCount: 3, eagerChunks: [] };
    const result = compareReport(report, { eagerChunkCount: -1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("eagerChunkCount");
  });

  it("returns error when baseline.eagerChunks is not an array (no raw TypeError)", () => {
    const report = { eagerChunkCount: 3, eagerChunks: ["a", "b", "c"] };
    // A hand-edited baseline that swaps the array for an object should be
    // reported via the structured error path, not thrown as a TypeError from
    // the Set constructor.
    expect(() => compareReport(report, { eagerChunkCount: 3, eagerChunks: {} })).not.toThrow();
    const result = compareReport(report, { eagerChunkCount: 3, eagerChunks: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("eagerChunks");
  });

  it("treats baseline.eagerChunks === null/undefined as empty (no validation error)", () => {
    const report = { eagerChunkCount: 0, eagerChunks: [] };
    expect(compareReport(report, { eagerChunkCount: 0 }).ok).toBe(true);
    expect(compareReport(report, { eagerChunkCount: 0, eagerChunks: null }).ok).toBe(true);
  });

  it("reports both added and removed when the closure churns at equal count", () => {
    const report = { eagerChunkCount: 3, eagerChunks: ["a", "b", "Z"] };
    const baseline = { eagerChunkCount: 3, eagerChunks: ["a", "b", "Y"] };
    const result = compareReport(report, baseline);
    // Equal count => ok=true, no grew flag, but added/removed are populated.
    expect(result.ok).toBe(true);
    expect(result.grew).toBeUndefined();
    expect(result.added).toEqual(["Z"]);
    expect(result.removed).toEqual(["Y"]);
  });

  describe("eager byte gate (#8819)", () => {
    it("ignores bytes when the baseline has no eagerGzip (back-compat)", () => {
      const report = { eagerChunkCount: 3, eagerChunks: ["a", "b", "c"], eagerGzip: 999999 };
      const baseline = { eagerChunkCount: 3, eagerChunks: ["a", "b", "c"] };
      const result = compareReport(report, baseline);
      expect(result.ok).toBe(true);
      expect(result.grewBytes).toBeUndefined();
      expect(result.byteRatio).toBeUndefined();
    });

    it("passes when eager gzip shrinks even though chunk count holds", () => {
      const report = { eagerChunkCount: 3, eagerChunks: ["a", "b", "c"], eagerGzip: 800 };
      const baseline = { eagerChunkCount: 3, eagerChunks: ["a", "b", "c"], eagerGzip: 1000 };
      const result = compareReport(report, baseline);
      expect(result.ok).toBe(true);
      expect(result.grewBytes).toBeUndefined();
      expect(result.byteRatio).toBeCloseTo(-0.2);
    });

    it("fails when eager gzip grows past the threshold despite stable count", () => {
      const report = { eagerChunkCount: 3, eagerChunks: ["a", "b", "c"], eagerGzip: 1100 };
      const baseline = { eagerChunkCount: 3, eagerChunks: ["a", "b", "c"], eagerGzip: 1000 };
      const result = compareReport(report, baseline, 0.05);
      expect(result.ok).toBe(false);
      expect(result.grewBytes).toBe(true);
      expect(result.grew).toBeUndefined(); // count did not grow
    });

    it("allows byte growth within the threshold", () => {
      const report = { eagerChunkCount: 3, eagerChunks: ["a", "b", "c"], eagerGzip: 1040 };
      const baseline = { eagerChunkCount: 3, eagerChunks: ["a", "b", "c"], eagerGzip: 1000 };
      const result = compareReport(report, baseline, 0.05);
      expect(result.ok).toBe(true);
      expect(result.grewBytes).toBeUndefined();
    });

    it("fails on byte growth even when chunk count shrinks", () => {
      const report = { eagerChunkCount: 2, eagerChunks: ["a", "b"], eagerGzip: 2000 };
      const baseline = { eagerChunkCount: 3, eagerChunks: ["a", "b", "c"], eagerGzip: 1000 };
      const result = compareReport(report, baseline, 0.05);
      expect(result.ok).toBe(false);
      expect(result.grewBytes).toBe(true);
      expect(result.shrank).toBe(true); // count shrank but bytes regressed
    });
  });

  describe("module-set gate (#8890)", () => {
    const base = { eagerChunkCount: 3, eagerChunks: ["a", "b", "vendor-react"] };

    it("ignores module sets when the baseline has no chunkModules (back-compat)", () => {
      const report = { ...base, chunkModules: { "vendor-react": ["node_modules/react/x.js"] } };
      const result = compareReport(report, { ...base });
      expect(result.ok).toBe(true);
      expect(result.moduleSetChanged).toBeUndefined();
      expect(result.staleBuild).toBeUndefined();
    });

    it("passes when module sets are identical", () => {
      const mods = { "vendor-react": ["node_modules/react/a.js", "node_modules/react/b.js"] };
      const report = { ...base, chunkModules: mods };
      const baseline = { ...base, chunkModules: mods };
      const result = compareReport(report, baseline);
      expect(result.ok).toBe(true);
      expect(result.moduleSetChanged).toBeUndefined();
    });

    it("fails when a module migrates between T0 chunks (stable count + bytes)", () => {
      const baseline = {
        ...base,
        chunkModules: {
          "vendor-react": ["node_modules/react/a.js", "node_modules/react/b.js"],
        },
      };
      const report = {
        ...base,
        chunkModules: {
          // b.js left vendor-react, c.js arrived — composition changed.
          "vendor-react": ["node_modules/react/a.js", "node_modules/react/c.js"],
        },
      };
      const result = compareReport(report, baseline);
      expect(result.ok).toBe(false);
      expect(result.moduleSetChanged).toBe(true);
      expect(result.moduleDiffs).toEqual([
        {
          chunk: "vendor-react",
          added: ["node_modules/react/c.js"],
          removed: ["node_modules/react/b.js"],
        },
      ]);
    });

    it("reports diffs in both chunks when a module migrates across T0 chunks", () => {
      const baseline = {
        ...base,
        chunkModules: {
          "vendor-react": ["node_modules/react/a.js", "node_modules/shared/x.js"],
          "vendor-xterm": ["node_modules/xterm/y.js"],
        },
      };
      const report = {
        ...base,
        chunkModules: {
          // shared/x.js hopped from vendor-react into vendor-xterm — net count
          // across the two chunks is unchanged, but composition shifted.
          "vendor-react": ["node_modules/react/a.js"],
          "vendor-xterm": ["node_modules/shared/x.js", "node_modules/xterm/y.js"],
        },
      };
      const result = compareReport(report, baseline);
      expect(result.ok).toBe(false);
      expect(result.moduleSetChanged).toBe(true);
      expect(result.moduleDiffs).toEqual([
        { chunk: "vendor-react", added: [], removed: ["node_modules/shared/x.js"] },
        { chunk: "vendor-xterm", added: ["node_modules/shared/x.js"], removed: [] },
      ]);
    });

    it("flags staleBuild when the baseline has module sets but the report has none", () => {
      const baseline = { ...base, chunkModules: { "vendor-react": ["node_modules/react/a.js"] } };
      // Report lacks chunkModules entirely — sidecar missing on a stale dist/.
      const report = { ...base };
      const result = compareReport(report, baseline);
      expect(result.ok).toBe(false);
      expect(result.staleBuild).toBe(true);
    });
  });

  describe("per-T0 byte gate (#8890)", () => {
    const base = { eagerChunkCount: 2, eagerChunks: ["vendor-react", "vendor-xterm"] };

    it("ignores per-chunk bytes when the baseline has no chunkGzip (back-compat)", () => {
      const report = { ...base, chunkGzip: { "vendor-react": 999999 } };
      const result = compareReport(report, { ...base });
      expect(result.ok).toBe(true);
      expect(result.t0ByteFailures).toBeUndefined();
    });

    it("passes when each gated chunk is within the threshold", () => {
      const report = { ...base, chunkGzip: { "vendor-react": 1040, "vendor-xterm": 500 } };
      const baseline = { ...base, chunkGzip: { "vendor-react": 1000, "vendor-xterm": 500 } };
      const result = compareReport(report, baseline, 0.05);
      expect(result.ok).toBe(true);
      expect(result.t0ByteFailures).toBeUndefined();
    });

    it("fails when one gated chunk exceeds the threshold even if the aggregate holds", () => {
      const report = { ...base, chunkGzip: { "vendor-react": 2000, "vendor-xterm": 500 } };
      const baseline = { ...base, chunkGzip: { "vendor-react": 1000, "vendor-xterm": 500 } };
      const result = compareReport(report, baseline, 0.05);
      expect(result.ok).toBe(false);
      expect(result.t0ByteFailures).toHaveLength(1);
      expect(result.t0ByteFailures[0].chunk).toBe("vendor-react");
      expect(result.t0ByteFailures[0].ratio).toBeCloseTo(1.0);
    });

    it("catches a T0 chunk doubling even when the aggregate gzip shrinks (the #8890 bug class)", () => {
      // This is the exact escape path the per-T0 gate exists to close: the
      // aggregate eagerGzip is *down* (well within budget), yet vendor-react
      // doubled — a compensating shrink elsewhere masked it from the aggregate.
      const report = {
        ...base,
        eagerGzip: 900,
        chunkGzip: { "vendor-react": 2000, "vendor-xterm": 500 },
      };
      const baseline = {
        ...base,
        eagerGzip: 1000,
        chunkGzip: { "vendor-react": 1000, "vendor-xterm": 500 },
      };
      const result = compareReport(report, baseline, 0.05);
      expect(result.ok).toBe(false);
      expect(result.grewBytes).toBeUndefined(); // aggregate gate stayed green
      expect(result.t0ByteFailures).toHaveLength(1);
      expect(result.t0ByteFailures[0].chunk).toBe("vendor-react");
    });

    it("flags t0Missing when a gated chunk left the eager set", () => {
      const report = {
        eagerChunkCount: 1,
        eagerChunks: ["vendor-xterm"],
        chunkGzip: { "vendor-xterm": 500 },
      };
      const baseline = { ...base, chunkGzip: { "vendor-react": 1000, "vendor-xterm": 500 } };
      const result = compareReport(report, baseline, 0.05);
      expect(result.ok).toBe(false);
      expect(result.t0Missing).toEqual(["vendor-react"]);
    });

    it("ignores baseline entries with non-positive byte values", () => {
      const report = { ...base, chunkGzip: { "vendor-react": 1040, "vendor-xterm": 500 } };
      const baseline = { ...base, chunkGzip: { "vendor-react": 0, "vendor-xterm": 500 } };
      const result = compareReport(report, baseline, 0.05);
      expect(result.ok).toBe(true);
    });
  });
});

describe("parseArgs", () => {
  it("defaults threshold to 0.05 and flags off", () => {
    const args = parseArgs(["node", "script.mjs"]);
    expect(args).toEqual({ isUpdate: false, force: false, threshold: 0.05 });
  });

  it("parses --update and --force", () => {
    const args = parseArgs(["node", "script.mjs", "--update", "--force"]);
    expect(args.isUpdate).toBe(true);
    expect(args.force).toBe(true);
  });

  it("parses --threshold with its value", () => {
    const args = parseArgs(["node", "script.mjs", "--threshold", "0.1"]);
    expect(args.threshold).toBeCloseTo(0.1);
  });
});
