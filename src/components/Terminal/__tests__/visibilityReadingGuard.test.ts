import { describe, expect, it } from "vitest";
import { isStaleHiddenReading } from "../visibilityReadingGuard";

// Build a rect from a top-left origin and a size.
const rectAt = (left: number, top: number, width: number, height: number): DOMRect =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {},
  }) as DOMRect;

const root = () => rectAt(0, 0, 1000, 800);
const visible = (intersecting: boolean) => ({ isIntersecting: intersecting });

describe("isStaleHiddenReading", () => {
  it("never flags a visible reading as stale, regardless of geometry", () => {
    expect(isStaleHiddenReading(visible(true), () => rectAt(0, 0, 0, 0), root)).toBe(false);
    expect(isStaleHiddenReading(visible(true), () => rectAt(0, 0, 200, 400), root)).toBe(false);
    expect(isStaleHiddenReading(visible(true), () => undefined, root)).toBe(false);
  });

  it("flags a `false` reading as stale when the element overlaps the root (on-screen)", () => {
    expect(isStaleHiddenReading(visible(false), () => rectAt(0, 100, 400, 520), root)).toBe(true);
  });

  it("trusts a `false` reading when the element is scrolled off below the root", () => {
    // Full layout box, but its top is past the root's bottom edge.
    expect(isStaleHiddenReading(visible(false), () => rectAt(0, 1500, 400, 520), root)).toBe(false);
  });

  it("trusts a `false` reading when the element is scrolled off above the root", () => {
    expect(isStaleHiddenReading(visible(false), () => rectAt(0, -600, 400, 520), root)).toBe(false);
  });

  it("trusts a `false` reading when geometry confirms zero size (genuine hide)", () => {
    expect(isStaleHiddenReading(visible(false), () => rectAt(0, 0, 0, 0), root)).toBe(false);
  });

  it("trusts a `false` reading when only one dimension is zero (collapsed pane)", () => {
    expect(isStaleHiddenReading(visible(false), () => rectAt(0, 0, 200, 0), root)).toBe(false);
    expect(isStaleHiddenReading(visible(false), () => rectAt(0, 0, 0, 400), root)).toBe(false);
  });

  it("trusts a `false` reading when the element is unmounted (no element rect)", () => {
    expect(isStaleHiddenReading(visible(false), () => undefined, root)).toBe(false);
  });

  it("trusts a `false` reading when the root cannot be measured", () => {
    expect(
      isStaleHiddenReading(
        visible(false),
        () => rectAt(0, 0, 400, 520),
        () => undefined
      )
    ).toBe(false);
  });

  it("treats an element straddling the root edge as on-screen (partial overlap)", () => {
    // Element starts inside the root and extends past its bottom edge.
    expect(isStaleHiddenReading(visible(false), () => rectAt(0, 700, 400, 520), root)).toBe(true);
  });

  it("reads geometry lazily — never measures for a visible reading", () => {
    let measured = false;
    isStaleHiddenReading(
      visible(true),
      () => {
        measured = true;
        return rectAt(0, 0, 200, 400);
      },
      root
    );
    expect(measured).toBe(false);
  });
});
