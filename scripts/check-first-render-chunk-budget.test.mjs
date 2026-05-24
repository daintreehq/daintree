import { describe, it, expect } from "vitest";
import { collectClosure, shrinkageGuardError } from "./check-first-render-chunk-budget.mjs";

// The seed list is now registry-derived (shared/config/panelKindRegistry.ts) and
// read from dist/.vite/first-render-seeds.json at runtime. collectClosure takes
// seed keys as a parameter, so these tests pass the lazy seeds as a literal —
// the registry contract itself is covered by panelKindRegistry.test.ts.
const LAZY_FIRST_RENDER_SEEDS = [
  "src/components/Browser/BrowserPane.tsx",
  "src/components/DevPreview/DevPreviewPane.tsx",
];

// Synthetic manifest mirroring the Vite 8 / Rolldown shape: top-level keys are
// either source paths (for entries / lazy seeds) or `_vendor-*.js` keys for
// shared chunks. Each entry has a `file` and optional `imports[]` /
// `dynamicImports[]` arrays of manifest keys. The motion case under test:
// `_vendor-motion.js` (LazyMotion/MotionConfig) is a STATIC import of the
// entry, while `_vendor-motion-features.js` (domMax) is reachable only via the
// dynamic `import("./lib/motionFeatures")` boundary — the #8821 split.
function makeManifest(extra = {}) {
  return {
    "index.html": {
      file: "assets/index-abc.js",
      isEntry: true,
      imports: ["_vendor-react.js", "_vendor-motion.js"],
      dynamicImports: ["src/lib/motionFeatures.ts", "src/components/Browser/BrowserPane.tsx"],
    },
    "_vendor-react.js": { file: "assets/vendor-react-def.js", imports: [], dynamicImports: [] },
    "_vendor-motion.js": {
      file: "assets/vendor-motion-ghi.js",
      imports: ["_vendor-react.js"],
      dynamicImports: [],
    },
    "src/lib/motionFeatures.ts": {
      file: "assets/motionFeatures-jkl.js",
      imports: ["_vendor-motion-features.js"],
      dynamicImports: [],
    },
    "_vendor-motion-features.js": {
      file: "assets/vendor-motion-features-mno.js",
      imports: [],
      dynamicImports: [],
    },
    "src/components/Browser/BrowserPane.tsx": {
      file: "assets/BrowserPane-pqr.js",
      imports: ["_vendor-browser.js"],
      dynamicImports: [],
    },
    "_vendor-browser.js": { file: "assets/vendor-browser-stu.js", imports: [], dynamicImports: [] },
    "src/components/DevPreview/DevPreviewPane.tsx": {
      file: "assets/DevPreviewPane-vwx.js",
      imports: [],
      dynamicImports: [],
    },
    ...extra,
  };
}

describe("collectClosure — eager walk (followDynamic: false)", () => {
  it("follows imports[] only, excluding the dynamic domMax boundary", () => {
    const manifest = makeManifest();
    const closure = collectClosure(manifest, ["index.html"], { followDynamic: false });
    expect([...closure].sort()).toEqual(["_vendor-motion.js", "_vendor-react.js", "index.html"]);
  });

  it("does NOT pull domMax (motionFeatures) into the eager closure", () => {
    const manifest = makeManifest();
    const closure = collectClosure(manifest, ["index.html"], { followDynamic: false });
    expect(closure.has("src/lib/motionFeatures.ts")).toBe(false);
    expect(closure.has("_vendor-motion-features.js")).toBe(false);
  });

  it("keeps eager LazyMotion/MotionConfig (vendor-motion) in the closure", () => {
    const manifest = makeManifest();
    const closure = collectClosure(manifest, ["index.html"], { followDynamic: false });
    expect(closure.has("_vendor-motion.js")).toBe(true);
  });
});

describe("collectClosure — total walk (default followDynamic: true)", () => {
  it("follows both imports[] and dynamicImports[], including domMax", () => {
    const manifest = makeManifest();
    const closure = collectClosure(manifest, ["index.html"]);
    expect(closure.has("src/lib/motionFeatures.ts")).toBe(true);
    expect(closure.has("_vendor-motion-features.js")).toBe(true);
    expect(closure.has("src/components/Browser/BrowserPane.tsx")).toBe(true);
  });
});

describe("collectClosure — first-render seeds", () => {
  it("always enqueues explicit seeds regardless of followDynamic", () => {
    const manifest = makeManifest();
    const seeds = ["index.html", ...LAZY_FIRST_RENDER_SEEDS];

    // BrowserPane/DevPreviewPane are first-render seeds even though they're
    // nominally lazy — they're passed in as seedKeys, not discovered by
    // walking dynamicImports[]. They must appear in the eager closure.
    const eager = collectClosure(manifest, seeds, { followDynamic: false });
    expect(eager.has("src/components/Browser/BrowserPane.tsx")).toBe(true);
    expect(eager.has("src/components/DevPreview/DevPreviewPane.tsx")).toBe(true);
    // And the BrowserPane's own static import is reachable from the seed.
    expect(eager.has("_vendor-browser.js")).toBe(true);
    // domMax is still excluded — it isn't a seed and only the dynamic edge
    // reaches it.
    expect(eager.has("_vendor-motion-features.js")).toBe(false);
  });

  it("visits each shared chunk exactly once (identity = manifest key)", () => {
    // Both index.html and _vendor-motion.js import _vendor-react.js.
    const manifest = makeManifest();
    const closure = collectClosure(manifest, ["index.html"], { followDynamic: false });
    const reactChunks = [...closure].filter((k) => k === "_vendor-react.js");
    expect(reactChunks.length).toBe(1);
  });

  it("skips seed keys not present in the manifest", () => {
    const manifest = makeManifest();
    const closure = collectClosure(manifest, ["src/missing-entry.tsx"], { followDynamic: false });
    expect(closure.size).toBe(0);
  });

  it("tolerates chunks with missing imports/dynamicImports arrays", () => {
    const manifest = {
      "index.html": { file: "a.js", isEntry: true, imports: ["_x.js"] },
      "_x.js": { file: "x.js" },
    };
    const closure = collectClosure(manifest, ["index.html"], { followDynamic: false });
    expect([...closure].sort()).toEqual(["_x.js", "index.html"]);
  });

  it("skips imports referencing keys absent from the manifest", () => {
    const manifest = {
      "index.html": { file: "a.js", isEntry: true, imports: ["_missing.js", "_present.js"] },
      "_present.js": { file: "p.js", imports: [] },
    };
    const closure = collectClosure(manifest, ["index.html"], { followDynamic: false });
    expect(closure.has("_present.js")).toBe(true);
    expect(closure.has("_missing.js")).toBe(false);
  });
});

describe("shrinkageGuardError", () => {
  const THRESHOLD = 0.1; // 10%

  it("returns null when eager gzip is unchanged", () => {
    expect(shrinkageGuardError(100, 100, THRESHOLD)).toBeNull();
  });

  it("returns null when eager gzip grows (not a shrinkage)", () => {
    expect(shrinkageGuardError(100, 120, THRESHOLD)).toBeNull();
  });

  it("returns null when shrinkage is below threshold (5%)", () => {
    expect(shrinkageGuardError(100, 95, THRESHOLD)).toBeNull();
  });

  it("returns null at exactly the threshold (10% drop)", () => {
    expect(shrinkageGuardError(100, 90, THRESHOLD)).toBeNull();
  });

  it("returns an error message when shrinkage exceeds threshold (the domMax exit)", () => {
    // The #8821 fix removes ~43KB from the eager closure — a large intentional
    // shrink that must trip the guard so --force is required to re-baseline.
    const err = shrinkageGuardError(100000, 57000, THRESHOLD);
    expect(err).not.toBeNull();
    expect(err).toContain("100000");
    expect(err).toContain("57000");
  });

  it("returns null when priorGzip is 0 / missing (no usable baseline)", () => {
    expect(shrinkageGuardError(0, 50, THRESHOLD)).toBeNull();
    expect(shrinkageGuardError(undefined, 50, THRESHOLD)).toBeNull();
    expect(shrinkageGuardError(null, 50, THRESHOLD)).toBeNull();
  });
});
