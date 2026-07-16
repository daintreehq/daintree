import { describe, it, expect } from "vitest";
import {
  collectClosure,
  findEntryKey,
  shrinkageGuardError,
  classifyFirstRenderBudget,
} from "./check-first-render-chunk-budget.mjs";

// The seed list is now registry-derived (shared/config/panelKindRegistry.ts) and
// read from dist/.vite/first-render-seeds.json at runtime. collectClosure takes
// seed keys as a parameter, so these tests pass the lazy seeds as a literal —
// the registry contract itself is covered by panelKindRegistry.test.ts.
const LAZY_FIRST_RENDER_SEEDS = [
  "src/components/Browser/BrowserPane.tsx",
  "src/components/DevPreview/DevPreviewPane.tsx",
  "src/panels/review/ReviewPane.tsx",
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
    "src/panels/review/ReviewPane.tsx": {
      file: "assets/ReviewPane-yz0.js",
      imports: ["_vendor-review.js"],
      dynamicImports: [],
    },
    "_vendor-review.js": { file: "assets/vendor-review-123.js", imports: [], dynamicImports: [] },
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
    expect(findEntryKey(manifest)).toBe("index.html");
  });

  it("identifies a facade by its file path when the manifest carries no name", () => {
    const manifest = {
      "\0virtual:daintree-host-react/react/jsx-runtime": {
        file: "assets/host-react-react-jsx-runtime-bbb.js",
        isEntry: true,
        imports: ["_vendor-react.js"],
        dynamicImports: [],
      },
      ...makeManifest(),
    };
    expect(findEntryKey(manifest)).toBe("index.html");
  });

  it("does not mistake a real chunk for a facade just because it imports react", () => {
    expect(findEntryKey(makeManifest())).toBe("index.html");
  });
});

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
    // ReviewPane is the seed that previously drifted out of the list (#8895) —
    // it must be enqueued and its static vendor dep pulled into the closure.
    expect(eager.has("src/panels/review/ReviewPane.tsx")).toBe(true);
    expect(eager.has("_vendor-review.js")).toBe(true);
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

describe("classifyFirstRenderBudget", () => {
  const THRESHOLD = 0.05;

  it("returns regression when ratio exceeds threshold, even with decreasing total", () => {
    const result = classifyFirstRenderBudget({
      delta: 6000,
      totalDelta: -5000,
      ratio: 0.06,
      threshold: THRESHOLD,
    });
    expect(result.classification).toBe("regression");
    expect(result.emoji).toBe("🔴");
  });

  it("returns pass when ratio equals threshold exactly", () => {
    // ratio === threshold: not > threshold, so not regression.
    // delta=5000 > stabilityBytes and ratio <= threshold → falls through to pass.
    const result = classifyFirstRenderBudget({
      delta: 5000,
      totalDelta: 1000,
      ratio: 0.05,
      threshold: THRESHOLD,
    });
    expect(result.classification).toBe("pass");
  });

  it("returns win when eager shrinks meaningfully and total is stable/down", () => {
    // Eager down 5000, total down 10000 — genuine net reduction.
    const result = classifyFirstRenderBudget({
      delta: -5000,
      totalDelta: -10000,
      ratio: -0.05,
      threshold: THRESHOLD,
    });
    expect(result.classification).toBe("win");
    expect(result.emoji).toBe("🟢");
  });

  it("returns win when eager shrinks and total is within stability band (+500)", () => {
    // Eager down 5000, total up only 500 — within noise floor.
    const result = classifyFirstRenderBudget({
      delta: -5000,
      totalDelta: 500,
      ratio: -0.05,
      threshold: THRESHOLD,
    });
    expect(result.classification).toBe("win");
  });

  it("returns shift-trap when eager shrinks meaningfully but total grew", () => {
    // Eager down 5000, but total up 5000 — bytes just moved to lazy.
    const result = classifyFirstRenderBudget({
      delta: -5000,
      totalDelta: 5000,
      ratio: -0.05,
      threshold: THRESHOLD,
    });
    expect(result.classification).toBe("shift-trap");
    expect(result.emoji).toBe("⚠️");
  });

  it("returns watch when eager is stable but total is creeping up", () => {
    // Eager delta within ±1024, total up past stability band.
    const result = classifyFirstRenderBudget({
      delta: 500,
      totalDelta: 5000,
      ratio: 0.005,
      threshold: THRESHOLD,
    });
    expect(result.classification).toBe("watch");
    expect(result.emoji).toBe("🟡");
  });

  it("returns pass when both eager and total are stable", () => {
    const result = classifyFirstRenderBudget({
      delta: 100,
      totalDelta: -100,
      ratio: 0.001,
      threshold: THRESHOLD,
    });
    expect(result.classification).toBe("pass");
    expect(result.emoji).toBe("✅");
  });

  it("returns pass when eager grows within stability band and total is stable", () => {
    const result = classifyFirstRenderBudget({
      delta: 800,
      totalDelta: 300,
      ratio: 0.008,
      threshold: THRESHOLD,
    });
    expect(result.classification).toBe("pass");
  });

  it("respects custom stabilityBytes", () => {
    // With stabilityBytes=5000, a delta of 3000 is "stable", making this a watch
    // since totalDelta > 5000.
    const result = classifyFirstRenderBudget(
      { delta: 3000, totalDelta: 6000, ratio: 0.03, threshold: THRESHOLD },
      { stabilityBytes: 5000 }
    );
    expect(result.classification).toBe("watch");
  });

  it("treats ratio 0 (zero baseline) as pass", () => {
    const result = classifyFirstRenderBudget({
      delta: 10000,
      totalDelta: 10000,
      ratio: 0,
      threshold: THRESHOLD,
    });
    expect(result.classification).toBe("pass");
  });

  it("returns regression when delta is just above threshold boundary", () => {
    // Baseline 100000, threshold 5% → budget at 105000. Delta of 5001 on 100000
    // baseline is ratio 0.05001 > 0.05.
    const result = classifyFirstRenderBudget({
      delta: 5001,
      totalDelta: 5001,
      ratio: 0.05001,
      threshold: THRESHOLD,
    });
    expect(result.classification).toBe("regression");
  });

  it("returns correct label and description for each classification", () => {
    const win = classifyFirstRenderBudget({
      delta: -5000,
      totalDelta: -5000,
      ratio: -0.05,
      threshold: THRESHOLD,
    });
    expect(win.label).toBe("Win");
    expect(win.description).toBeTruthy();

    const regression = classifyFirstRenderBudget({
      delta: 6000,
      totalDelta: 6000,
      ratio: 0.06,
      threshold: THRESHOLD,
    });
    expect(regression.label).toBe("Regression");
    expect(regression.description).toBeTruthy();

    const shiftTrap = classifyFirstRenderBudget({
      delta: -5000,
      totalDelta: 5000,
      ratio: -0.05,
      threshold: THRESHOLD,
    });
    expect(shiftTrap.label).toBe("Shift trap");
    expect(shiftTrap.description).toBeTruthy();

    const watch = classifyFirstRenderBudget({
      delta: 500,
      totalDelta: 5000,
      ratio: 0.005,
      threshold: THRESHOLD,
    });
    expect(watch.label).toBe("Watch");
    expect(watch.description).toBeTruthy();

    const pass = classifyFirstRenderBudget({
      delta: 100,
      totalDelta: -100,
      ratio: 0.001,
      threshold: THRESHOLD,
    });
    expect(pass.label).toBe("Pass");
    expect(pass.description).toBeTruthy();
  });

  it("returns watch when eager is stable-negative but total is creeping up", () => {
    // Eager slightly down (within stability band), total growing — still a watch
    // because the total-bundle trend is what matters.
    const result = classifyFirstRenderBudget({
      delta: -500,
      totalDelta: 5000,
      ratio: -0.005,
      threshold: THRESHOLD,
    });
    expect(result.classification).toBe("watch");
  });

  describe("stabilityBytes boundary", () => {
    it("delta -1024, totalDelta 1024 → win (exactly at stability boundary)", () => {
      const result = classifyFirstRenderBudget({
        delta: -1024,
        totalDelta: 1024,
        ratio: -0.01,
        threshold: THRESHOLD,
      });
      expect(result.classification).toBe("win");
    });

    it("delta -1024, totalDelta 1025 → shift-trap (total just past stability)", () => {
      const result = classifyFirstRenderBudget({
        delta: -1024,
        totalDelta: 1025,
        ratio: -0.01,
        threshold: THRESHOLD,
      });
      expect(result.classification).toBe("shift-trap");
    });

    it("delta 1024, totalDelta 1025 → watch (eager at stability edge, total up)", () => {
      const result = classifyFirstRenderBudget({
        delta: 1024,
        totalDelta: 1025,
        ratio: 0.01,
        threshold: THRESHOLD,
      });
      expect(result.classification).toBe("watch");
    });

    it("delta 1025, totalDelta 1025 → pass (eager grew beyond noise but within budget)", () => {
      const result = classifyFirstRenderBudget({
        delta: 1025,
        totalDelta: 1025,
        ratio: 0.01,
        threshold: THRESHOLD,
      });
      expect(result.classification).toBe("pass");
    });
  });
});
