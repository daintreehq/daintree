import { describe, it, expect } from "vitest";
import { computeThumbGeometry, computeTrackPageTarget } from "../GridScrollbar";

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

describe("computeTrackPageTarget", () => {
  const TRACK = 800;
  const MIN = 44;
  const metrics = (scrollTop: number, scrollHeight = 6000) => ({
    scrollTop,
    scrollHeight,
    clientHeight: 1000,
  });

  it("does nothing once the handle sits under the pointer", () => {
    const geo = computeThumbGeometry(metrics(2000), TRACK, MIN)!;
    expect(computeTrackPageTarget(metrics(2000), TRACK, MIN, geo.top + geo.height / 2)).toBeNull();
  });

  it("pages toward the pointer and never carries the handle's centre past it", () => {
    for (const scrollTop of [0, 1200, 2500, 4000, 5000]) {
      for (let pointerY = 0; pointerY <= TRACK; pointerY += 37) {
        const before = computeThumbGeometry(metrics(scrollTop), TRACK, MIN)!;
        const next = computeTrackPageTarget(metrics(scrollTop), TRACK, MIN, pointerY);
        if (next === null) continue;
        const after = computeThumbGeometry(metrics(next), TRACK, MIN)!;
        const centre = after.top + after.height / 2;
        if (pointerY < before.top) {
          expect(next).toBeLessThan(scrollTop);
          expect(centre).toBeGreaterThanOrEqual(pointerY - 1);
        } else {
          expect(next).toBeGreaterThan(scrollTop);
          expect(centre).toBeLessThanOrEqual(pointerY + 1);
        }
        expect(Math.abs(next - scrollTop)).toBeLessThanOrEqual(1000);
      }
    }
  });

  it("brings the handle under a held pointer in a bounded number of repeats", () => {
    for (const [start, pointerY] of [
      [0, TRACK - 2],
      [5000, 2],
      [0, 420],
      [5000, 300],
    ] as const) {
      let scrollTop: number = start;
      let steps = 0;
      for (;;) {
        const next = computeTrackPageTarget(metrics(scrollTop), TRACK, MIN, pointerY);
        if (next === null) break;
        scrollTop = next;
        steps += 1;
        expect(steps).toBeLessThan(10);
      }
      const geo = computeThumbGeometry(metrics(scrollTop), TRACK, MIN)!;
      const underPointer = pointerY >= geo.top && pointerY <= geo.top + geo.height;
      const atEnd = scrollTop === 0 || scrollTop === 5000;
      expect(underPointer || atEnd).toBe(true);
    }
  });

  it("does nothing when the content does not overflow", () => {
    expect(computeTrackPageTarget(metrics(0, 1000), TRACK, MIN, 700)).toBeNull();
  });
});
