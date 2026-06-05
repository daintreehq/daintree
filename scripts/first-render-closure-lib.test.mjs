import { describe, it, expect } from "vitest";
import { collectClosure } from "./first-render-closure-lib.mjs";

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
