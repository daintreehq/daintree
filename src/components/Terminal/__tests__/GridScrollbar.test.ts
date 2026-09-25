import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { computeThumbGeometry, computeTrackPageTarget, createTrackHold } from "../GridScrollbar";

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

describe("createTrackHold", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A handle on a 1000px track that moves 100px per page and stops under the pointer. */
  function simulatedTrack(start = 0) {
    const state = { handle: start, pages: 0, smooth: [] as boolean[] };
    const page = (pointerY: number, smooth: boolean) => {
      if (Math.abs(pointerY - state.handle) < 50) return false;
      state.handle +=
        Math.sign(pointerY - state.handle) * Math.min(100, Math.abs(pointerY - state.handle));
      state.pages += 1;
      state.smooth.push(smooth);
      return true;
    };
    return { state, hold: createTrackHold(page) };
  }

  it("pages once on press and only repeats after the hold delay", () => {
    const { state, hold } = simulatedTrack();
    expect(hold.press(900, true)).toBe(true);
    expect(state.pages).toBe(1);
    vi.advanceTimersByTime(300);
    expect(state.pages).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(state.pages).toBeGreaterThan(1);
  });

  it("repeats until the handle reaches the pointer, then stops paging", () => {
    const { state, hold } = simulatedTrack();
    hold.press(600, true);
    vi.advanceTimersByTime(5000);
    expect(Math.abs(state.handle - 600)).toBeLessThan(50);
    const settled = state.pages;
    vi.advanceTimersByTime(5000);
    expect(state.pages).toBe(settled);
  });

  it("resumes a caught-up hold when the held pointer moves on", () => {
    const { state, hold } = simulatedTrack();
    hold.press(400, true);
    vi.advanceTimersByTime(5000);
    expect(Math.abs(state.handle - 400)).toBeLessThan(50);
    hold.move(900);
    vi.advanceTimersByTime(5000);
    expect(Math.abs(state.handle - 900)).toBeLessThan(50);
  });

  it("stops paging on release, even mid-repeat", () => {
    const { state, hold } = simulatedTrack();
    hold.press(900, true);
    vi.advanceTimersByTime(500);
    hold.release();
    const atRelease = state.pages;
    hold.move(0);
    vi.advanceTimersByTime(5000);
    expect(state.pages).toBe(atRelease);
  });

  it("uses the caller's motion choice for the press and instant pages for repeats", () => {
    const { state, hold } = simulatedTrack();
    hold.press(900, true);
    vi.advanceTimersByTime(5000);
    expect(state.smooth[0]).toBe(true);
    expect(state.smooth.slice(1).every((s) => s === false)).toBe(true);
  });

  it("arms nothing when the press itself has nowhere to go", () => {
    const { state, hold } = simulatedTrack(500);
    expect(hold.press(510, true)).toBe(false);
    hold.move(900);
    vi.advanceTimersByTime(5000);
    expect(state.pages).toBe(0);
  });
});
