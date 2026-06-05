import { describe, expect, it } from "vitest";
import { isStaleHiddenReading } from "../visibilityReadingGuard";

const rect = (width: number, height: number): DOMRect =>
  ({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON() {},
  }) as DOMRect;

describe("isStaleHiddenReading", () => {
  it("never flags a visible reading as stale, regardless of geometry", () => {
    expect(isStaleHiddenReading({ isIntersecting: true }, () => rect(0, 0))).toBe(false);
    expect(isStaleHiddenReading({ isIntersecting: true }, () => rect(200, 400))).toBe(false);
    expect(isStaleHiddenReading({ isIntersecting: true }, () => undefined)).toBe(false);
  });

  it("flags a `false` reading as stale when the element still has non-zero bounds", () => {
    expect(isStaleHiddenReading({ isIntersecting: false }, () => rect(200, 400))).toBe(true);
  });

  it("trusts a `false` reading when geometry confirms zero size (genuine hide)", () => {
    expect(isStaleHiddenReading({ isIntersecting: false }, () => rect(0, 0))).toBe(false);
  });

  it("trusts a `false` reading when only one dimension is zero (collapsed pane)", () => {
    expect(isStaleHiddenReading({ isIntersecting: false }, () => rect(200, 0))).toBe(false);
    expect(isStaleHiddenReading({ isIntersecting: false }, () => rect(0, 400))).toBe(false);
  });

  it("trusts a `false` reading when the element is unmounted (no rect)", () => {
    expect(isStaleHiddenReading({ isIntersecting: false }, () => undefined)).toBe(false);
  });

  it("reads geometry lazily — never measures for a visible reading", () => {
    let measured = false;
    isStaleHiddenReading({ isIntersecting: true }, () => {
      measured = true;
      return rect(200, 400);
    });
    expect(measured).toBe(false);
  });
});
