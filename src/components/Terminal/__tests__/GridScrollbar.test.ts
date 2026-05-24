import { describe, it, expect } from "vitest";
import { computeThumbGeometry } from "../GridScrollbar";

describe("computeThumbGeometry", () => {
  it("returns null when the content does not overflow", () => {
    expect(
      computeThumbGeometry({ scrollTop: 0, scrollHeight: 500, clientHeight: 500 }, 500, 44)
    ).toBeNull();
    expect(
      computeThumbGeometry({ scrollTop: 0, scrollHeight: 400, clientHeight: 500 }, 500, 44)
    ).toBeNull();
  });

  it("returns null for a degenerate track", () => {
    expect(
      computeThumbGeometry({ scrollTop: 0, scrollHeight: 2000, clientHeight: 1000 }, 0, 44)
    ).toBeNull();
  });

  it("sizes the handle to the visible fraction of the content", () => {
    expect(
      computeThumbGeometry({ scrollTop: 0, scrollHeight: 2000, clientHeight: 1000 }, 1000, 44)
    ).toEqual({ height: 500, top: 0 });
  });

  it("positions the handle flush to the track bottom when scrolled to the end", () => {
    const geo = computeThumbGeometry(
      { scrollTop: 1000, scrollHeight: 2000, clientHeight: 1000 },
      1000,
      44
    );
    expect(geo).not.toBeNull();
    expect(geo!.top).toBe(1000 - geo!.height);
  });

  it("clamps the handle to a minimum height for a huge fleet", () => {
    const geo = computeThumbGeometry(
      { scrollTop: 0, scrollHeight: 100000, clientHeight: 1000 },
      1000,
      44
    );
    expect(geo!.height).toBe(44);
  });

  it("keeps the handle inside the track at every scroll position", () => {
    for (const scrollTop of [0, 250, 500, 900, 1000]) {
      const geo = computeThumbGeometry(
        { scrollTop, scrollHeight: 2000, clientHeight: 1000 },
        800,
        44
      )!;
      expect(geo.top).toBeGreaterThanOrEqual(0);
      expect(geo.top + geo.height).toBeLessThanOrEqual(800);
    }
  });
});
