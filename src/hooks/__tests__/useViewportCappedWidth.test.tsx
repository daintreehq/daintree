// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { resizeCappedPreference, useViewportCappedWidth } from "../useViewportCappedWidth";

const originalWidth = window.innerWidth;

function resizeTo(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
});

describe("useViewportCappedWidth", () => {
  it("keeps the preferred width when the viewport has room for it", () => {
    resizeTo(1600);
    const { result } = renderHook(() => useViewportCappedWidth(600, 200, 240));
    expect(result.current).toBe(600);
  });

  it("narrows to leave the reserve free in a tile narrower than the preference", () => {
    resizeTo(476);
    const { result } = renderHook(() => useViewportCappedWidth(600, 200, 240));
    expect(result.current).toBe(236);
  });

  it("never goes below the minimum", () => {
    resizeTo(300);
    const { result } = renderHook(() => useViewportCappedWidth(600, 200, 240));
    expect(result.current).toBe(200);
  });

  it("follows the viewport as it shrinks and grows back to the preference", () => {
    resizeTo(1600);
    const { result } = renderHook(() => useViewportCappedWidth(350, 200, 240));
    expect(result.current).toBe(350);
    act(() => resizeTo(500));
    expect(result.current).toBe(260);
    act(() => resizeTo(1200));
    expect(result.current).toBe(350);
  });

  it("does not re-render on resizes that leave the result unchanged", () => {
    resizeTo(1600);
    let renders = 0;
    renderHook(() => {
      renders++;
      return useViewportCappedWidth(350, 200, 240);
    });
    const before = renders;
    act(() => resizeTo(1400));
    act(() => resizeTo(1000));
    expect(renders).toBe(before);
  });
});

describe("resizeCappedPreference", () => {
  const MIN = 200;
  const MAX = 600;

  it("clamps to the min/max bounds when the viewport has room", () => {
    expect(resizeCappedPreference(150, 350, MIN, MAX, 1360)).toBe(200);
    expect(resizeCappedPreference(800, 350, MIN, MAX, 1360)).toBe(600);
    expect(resizeCappedPreference(420, 350, MIN, MAX, 1360)).toBe(420);
  });

  it("keeps a capped preference when the request can't widen what is shown", () => {
    // 500px viewport, 240px reserve: 260px shown for a 350px preference.
    expect(resizeCappedPreference(270, 350, MIN, MAX, 260)).toBe(350);
    expect(resizeCappedPreference(260, 350, MIN, MAX, 260)).toBe(350);
  });

  it("takes a narrower request below the cap as the new preference", () => {
    expect(resizeCappedPreference(230, 350, MIN, MAX, 260)).toBe(230);
  });

  it("lets an uncapped preference grow up to the cap", () => {
    expect(resizeCappedPreference(300, 240, MIN, MAX, 260)).toBe(260);
  });
});
