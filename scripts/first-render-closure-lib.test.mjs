import { describe, it, expect } from "vitest";
import { collectClosure, computeFirstRenderPreloadFiles } from "./first-render-closure-lib.mjs";

// Builds accessor options over a plain adjacency map: { key: { imports, dyn } }.
// This is intentionally NOT the manifest or bundle shape — the lib is generic
// over the key scheme, and testing it against a synthetic graph proves the
// traversal logic independently of either real consumer (manifest source paths
// vs. bundle file names).
function graphOptions(graph, followDynamic = false) {
  return {
    getNode: (key) => graph[key],
    getStaticImports: (node) => node.imports,
    getDynamicImports: (node) => node.dyn,
    followDynamic,
  };
}

describe("collectClosure — eager static walk (followDynamic: false)", () => {
  it("collects every node reachable through imports[] from the seed", () => {
    const graph = {
      a: { imports: ["b", "c"] },
      b: { imports: ["d"] },
      c: { imports: [] },
      d: { imports: [] },
    };
    const closure = collectClosure(["a"], graphOptions(graph));
    expect([...closure].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("does NOT follow dynamic edges when followDynamic is false", () => {
    const graph = {
      a: { imports: ["b"], dyn: ["x"] },
      b: { imports: [] },
      x: { imports: ["y"] },
      y: { imports: [] },
    };
    const closure = collectClosure(["a"], graphOptions(graph));
    expect(closure.has("x")).toBe(false);
    expect(closure.has("y")).toBe(false);
    expect([...closure].sort()).toEqual(["a", "b"]);
  });

  it("returns just the seed when it has no static imports", () => {
    const graph = { a: { imports: [] } };
    const closure = collectClosure(["a"], graphOptions(graph));
    expect([...closure]).toEqual(["a"]);
  });
});

describe("collectClosure — total walk (followDynamic: true)", () => {
  it("follows both static and dynamic edges", () => {
    const graph = {
      a: { imports: ["b"], dyn: ["x"] },
      b: { imports: [] },
      x: { imports: ["y"] },
      y: { imports: [] },
    };
    const closure = collectClosure(["a"], graphOptions(graph, true));
    expect([...closure].sort()).toEqual(["a", "b", "x", "y"]);
  });
});

describe("collectClosure — robustness", () => {
  it("terminates on a cycle and visits each node once", () => {
    const graph = {
      a: { imports: ["b"] },
      b: { imports: ["c"] },
      c: { imports: ["a"] }, // cycle back to a
    };
    const closure = collectClosure(["a"], graphOptions(graph));
    expect([...closure].sort()).toEqual(["a", "b", "c"]);
  });

  it("visits a diamond-shared node exactly once", () => {
    const graph = {
      a: { imports: ["b", "c"] },
      b: { imports: ["shared"] },
      c: { imports: ["shared"] },
      shared: { imports: [] },
    };
    const closure = collectClosure(["a"], graphOptions(graph));
    expect([...closure].filter((k) => k === "shared").length).toBe(1);
  });

  it("skips seed keys that resolve to no node", () => {
    const graph = { a: { imports: [] } };
    const closure = collectClosure(["missing"], graphOptions(graph));
    expect(closure.size).toBe(0);
  });

  it("skips edges that reference absent nodes", () => {
    const graph = {
      a: { imports: ["present", "absent"] },
      present: { imports: [] },
    };
    const closure = collectClosure(["a"], graphOptions(graph));
    expect(closure.has("present")).toBe(true);
    expect(closure.has("absent")).toBe(false);
  });

  it("returns an empty set for an empty seed list", () => {
    const graph = { a: { imports: ["b"] }, b: { imports: [] } };
    const closure = collectClosure([], graphOptions(graph));
    expect(closure.size).toBe(0);
  });

  it("tolerates nodes whose import accessors return undefined", () => {
    const graph = {
      a: { imports: ["b"] },
      b: {}, // no imports/dyn fields at all
    };
    // followDynamic true exercises both accessors returning undefined.
    const closure = collectClosure(["a"], graphOptions(graph, true));
    expect([...closure].sort()).toEqual(["a", "b"]);
  });

  it("unions the closures of multiple seeds", () => {
    const graph = {
      s1: { imports: ["a"] },
      s2: { imports: ["b"] },
      a: { imports: [] },
      b: { imports: [] },
    };
    const closure = collectClosure(["s1", "s2"], graphOptions(graph));
    expect([...closure].sort()).toEqual(["a", "b", "s1", "s2"]);
  });
});

// Identity normalizer for the common case where facadeModuleId is already the
// repo-relative POSIX path. Cross-platform normalization is exercised separately.
const identity = (id) => id;

describe("computeFirstRenderPreloadFiles", () => {
  it("subtracts the entry's static closure so Vite-preloaded chunks aren't duplicated", () => {
    // entry statically imports vendor-react; the seed panel statically imports
    // both its private vendor and the shared vendor-react. Only the chunks NOT
    // already in the entry closure should be injected.
    const chunks = [
      {
        type: "chunk",
        fileName: "entry.js",
        isEntry: true,
        facadeModuleId: "src/main.tsx",
        imports: ["vendor-react.js"],
        dynamicImports: ["panel.js"],
      },
      { type: "chunk", fileName: "vendor-react.js", imports: [], dynamicImports: [] },
      {
        type: "chunk",
        fileName: "panel.js",
        facadeModuleId: "src/panels/browser/index.tsx",
        imports: ["vendor-react.js", "vendor-browser.js"],
        dynamicImports: [],
      },
      { type: "chunk", fileName: "vendor-browser.js", imports: [], dynamicImports: [] },
    ];
    const { files, matchedSeedCount } = computeFirstRenderPreloadFiles(
      chunks,
      new Set(["src/panels/browser/index.tsx"]),
      identity
    );
    expect(matchedSeedCount).toBe(1);
    // vendor-react is in the entry closure → excluded; panel + its private
    // vendor are seed-only → injected.
    expect(files).toEqual(["panel.js", "vendor-browser.js"]);
    expect(files).not.toContain("vendor-react.js");
  });

  it("never injects a chunk reachable only through a dynamic import (the domMax guard)", () => {
    const chunks = [
      {
        type: "chunk",
        fileName: "entry.js",
        isEntry: true,
        facadeModuleId: "src/main.tsx",
        imports: [],
        dynamicImports: ["panel.js"],
      },
      {
        type: "chunk",
        fileName: "panel.js",
        facadeModuleId: "src/panels/browser/index.tsx",
        imports: ["panel-vendor.js"],
        dynamicImports: ["dom-max.js"], // deferred subtree
      },
      { type: "chunk", fileName: "panel-vendor.js", imports: [], dynamicImports: [] },
      { type: "chunk", fileName: "dom-max.js", imports: [], dynamicImports: [] },
    ];
    const { files } = computeFirstRenderPreloadFiles(
      chunks,
      new Set(["src/panels/browser/index.tsx"]),
      identity
    );
    expect(files).toContain("panel.js");
    expect(files).toContain("panel-vendor.js");
    expect(files).not.toContain("dom-max.js");
  });

  it("matches seeds through a platform-specific facadeModuleId normalizer", () => {
    // Simulate Windows absolute facadeModuleId + a normalizer that maps it to
    // the repo-relative POSIX seed path.
    const chunks = [
      {
        type: "chunk",
        fileName: "panel.js",
        facadeModuleId: "C:\\repo\\src\\panels\\browser\\index.tsx",
        imports: [],
        dynamicImports: [],
      },
    ];
    const toPosix = (id) =>
      id
        .replace(/^C:\\repo\\/, "")
        .split("\\")
        .join("/");
    const { files, matchedSeedCount } = computeFirstRenderPreloadFiles(
      chunks,
      new Set(["src/panels/browser/index.tsx"]),
      toPosix
    );
    expect(matchedSeedCount).toBe(1);
    expect(files).toEqual(["panel.js"]);
  });

  it("ignores non-chunk outputs so assets are never preloaded as modules", () => {
    const chunks = [
      {
        type: "chunk",
        fileName: "panel.js",
        facadeModuleId: "src/panels/browser/index.tsx",
        imports: [],
        dynamicImports: [],
      },
      { type: "asset", fileName: "style.css" },
    ];
    const { files } = computeFirstRenderPreloadFiles(
      chunks,
      new Set(["src/panels/browser/index.tsx"]),
      identity
    );
    expect(files).toEqual(["panel.js"]);
    expect(files).not.toContain("style.css");
  });

  it("reports zero matches when no chunk facadeModuleId is a seed", () => {
    const chunks = [
      {
        type: "chunk",
        fileName: "entry.js",
        isEntry: true,
        facadeModuleId: "src/main.tsx",
        imports: [],
        dynamicImports: [],
      },
    ];
    const { files, matchedSeedCount } = computeFirstRenderPreloadFiles(
      chunks,
      new Set(["src/panels/browser/index.tsx"]),
      identity
    );
    expect(matchedSeedCount).toBe(0);
    expect(files).toEqual([]);
  });

  it("reports a partial match count when only some seeds resolve", () => {
    const chunks = [
      {
        type: "chunk",
        fileName: "browser.js",
        facadeModuleId: "src/panels/browser/index.tsx",
        imports: [],
        dynamicImports: [],
      },
      // The review panel seed has no matching chunk facadeModuleId.
    ];
    const { matchedSeedCount } = computeFirstRenderPreloadFiles(
      chunks,
      new Set(["src/panels/browser/index.tsx", "src/panels/review/ReviewPane.tsx"]),
      identity
    );
    // Caller compares matchedSeedCount (1) against seedSourcePaths.size (2) to
    // warn on incomplete coverage.
    expect(matchedSeedCount).toBe(1);
  });

  it("deduplicates a chunk shared across multiple seeds", () => {
    const chunks = [
      {
        type: "chunk",
        fileName: "browser.js",
        facadeModuleId: "src/panels/browser/index.tsx",
        imports: ["shared.js"],
        dynamicImports: [],
      },
      {
        type: "chunk",
        fileName: "review.js",
        facadeModuleId: "src/panels/review/ReviewPane.tsx",
        imports: ["shared.js"],
        dynamicImports: [],
      },
      { type: "chunk", fileName: "shared.js", imports: [], dynamicImports: [] },
    ];
    const { files } = computeFirstRenderPreloadFiles(
      chunks,
      new Set(["src/panels/browser/index.tsx", "src/panels/review/ReviewPane.tsx"]),
      identity
    );
    expect(files).toEqual(["browser.js", "review.js", "shared.js"]);
    expect(files.filter((f) => f === "shared.js").length).toBe(1);
  });
});
