import { describe, it, expect } from "vitest";
import {
  collectEagerChunks,
  compareReport,
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
});
