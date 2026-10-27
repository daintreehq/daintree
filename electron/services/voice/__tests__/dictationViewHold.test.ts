import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetDictationViewHoldsForTests,
  holdDictationView,
  isDictationViewHeld,
  onDictationViewReleased,
} from "../dictationViewHold.js";

const view = (id: number, destroyed = false) =>
  ({ id, isDestroyed: () => destroyed }) as unknown as Electron.WebContents;

describe("dictationViewHold", () => {
  beforeEach(() => _resetDictationViewHoldsForTests());
  afterEach(() => {
    _resetDictationViewHoldsForTests();
    vi.useRealTimers();
  });

  it("holds a view until its last hold is released, and says so once", () => {
    const released = vi.fn();
    const off = onDictationViewReleased(released);
    const session = holdDictationView(7);
    const cleanup = holdDictationView(7);

    session();
    session();
    expect(isDictationViewHeld(view(7))).toBe(true);
    expect(released).not.toHaveBeenCalled();

    cleanup();
    expect(isDictationViewHeld(view(7))).toBe(false);
    expect(released).toHaveBeenCalledExactlyOnceWith(7);
    off();
  });

  it("keeps each view's holds apart", () => {
    const release = holdDictationView(7);
    holdDictationView(8);

    release();

    expect(isDictationViewHeld(view(7))).toBe(false);
    expect(isDictationViewHeld(view(8))).toBe(true);
  });

  it("lets a hold with a deadline lapse, and a later release drop nothing", () => {
    vi.useFakeTimers();
    const lapsed = holdDictationView(7, 1_000);

    vi.advanceTimersByTime(1_000);
    expect(isDictationViewHeld(view(7))).toBe(false);

    const next = holdDictationView(7);
    lapsed();
    expect(isDictationViewHeld(view(7))).toBe(true);
    next();
  });

  it("ignores a release from before a reset, so it can't drop a newer hold", () => {
    const stale = holdDictationView(7);
    _resetDictationViewHoldsForTests();
    holdDictationView(7);

    stale();

    expect(isDictationViewHeld(view(7))).toBe(true);
  });

  it("reads a destroyed view as needing nothing", () => {
    holdDictationView(7);

    expect(isDictationViewHeld(view(7, true))).toBe(false);
  });

  it("tells every listener even when one throws", () => {
    const failing = onDictationViewReleased(() => {
      throw new Error("boom");
    });
    const heard = vi.fn();
    const off = onDictationViewReleased(heard);

    holdDictationView(7)();

    expect(heard).toHaveBeenCalledWith(7);
    failing();
    off();
  });
});
