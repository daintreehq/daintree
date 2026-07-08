import { describe, expect, it } from "vitest";
import {
  boundsAreValid,
  boundsIntersect,
  boundsContain,
  boundingBox,
  findBoundsConflicts,
} from "../paintSurfaceGeometry.js";
import type { SurfaceViewBounds } from "../../types/paintFabricSurface.js";

const rect = (x: number, y: number, width: number, height: number): SurfaceViewBounds => ({
  x,
  y,
  width,
  height,
});

describe("boundsAreValid", () => {
  it("accepts finite non-negative-size rects, including zero-size", () => {
    expect(boundsAreValid(rect(0, 0, 100, 50))).toBe(true);
    expect(boundsAreValid(rect(-10, -10, 0, 0))).toBe(true);
  });

  it("rejects negative sizes and non-finite fields", () => {
    expect(boundsAreValid(rect(0, 0, -1, 10))).toBe(false);
    expect(boundsAreValid(rect(0, 0, 10, -1))).toBe(false);
    expect(boundsAreValid(rect(Number.NaN, 0, 10, 10))).toBe(false);
    expect(boundsAreValid(rect(0, Number.POSITIVE_INFINITY, 10, 10))).toBe(false);
  });
});

describe("boundsIntersect", () => {
  it("detects overlap and rejects edge-adjacent rects", () => {
    expect(boundsIntersect(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toBe(true);
    // Sharing an edge is NOT overlap — adjacent bands must be legal.
    expect(boundsIntersect(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBe(false);
    expect(boundsIntersect(rect(0, 0, 10, 10), rect(0, 10, 10, 10))).toBe(false);
    expect(boundsIntersect(rect(0, 0, 10, 10), rect(20, 20, 5, 5))).toBe(false);
  });

  it("treats zero-area rects as never intersecting", () => {
    expect(boundsIntersect(rect(5, 5, 0, 0), rect(0, 0, 10, 10))).toBe(false);
    expect(boundsIntersect(rect(0, 0, 10, 10), rect(5, 5, 0, 10))).toBe(false);
  });
});

describe("boundingBox", () => {
  it("returns null for an empty set", () => {
    expect(boundingBox([])).toBeNull();
  });

  it("computes the band covering all pane rects", () => {
    expect(boundingBox([rect(10, 20, 30, 40), rect(50, 0, 10, 10)])).toEqual(rect(10, 0, 50, 60));
  });
});

describe("boundsContain", () => {
  it("accepts inner rects up to the shared edge", () => {
    expect(boundsContain(rect(0, 0, 100, 100), rect(0, 0, 100, 100))).toBe(true);
    expect(boundsContain(rect(0, 0, 100, 100), rect(90, 90, 10, 10))).toBe(true);
    expect(boundsContain(rect(0, 0, 100, 100), rect(95, 95, 10, 10))).toBe(false);
  });
});

describe("findBoundsConflicts", () => {
  it("names every overlapping sibling and honors the exclusion", () => {
    const placed = new Map<string, SurfaceViewBounds>([
      ["a", rect(0, 0, 100, 100)],
      ["b", rect(100, 0, 100, 100)],
      ["c", rect(0, 100, 100, 100)],
    ]);
    expect(findBoundsConflicts(rect(0, 50, 100, 100), placed)).toEqual(["a", "c"]);
    expect(findBoundsConflicts(rect(0, 50, 100, 100), placed, "a")).toEqual(["c"]);
    expect(findBoundsConflicts(rect(200, 200, 10, 10), placed)).toEqual([]);
  });
});
