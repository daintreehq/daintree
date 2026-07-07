import { describe, expect, it, vi } from "vitest";
import { IdleHeapCompactor, IDLE_HEAP_COMPACT_AFTER_MS } from "../analysis/idleHeapCompactor.js";

describe("IdleHeapCompactor", () => {
  it("compacts once after the idle threshold and re-arms only on new activity", () => {
    const gc = vi.fn();
    const compactor = new IdleHeapCompactor(gc, 1000);

    compactor.noteActivity(10_000);
    expect(compactor.maybeCompact(10_500)).toBe(false);
    expect(gc).not.toHaveBeenCalled();

    expect(compactor.maybeCompact(11_000)).toBe(true);
    expect(gc).toHaveBeenCalledTimes(1);

    // Still idle — no repeated GCs.
    expect(compactor.maybeCompact(20_000)).toBe(false);
    expect(gc).toHaveBeenCalledTimes(1);

    // New activity re-arms.
    compactor.noteActivity(21_000);
    expect(compactor.maybeCompact(21_500)).toBe(false);
    expect(compactor.maybeCompact(22_000)).toBe(true);
    expect(gc).toHaveBeenCalledTimes(2);
  });

  it("observeActivityAt only moves the clock forward", () => {
    const gc = vi.fn();
    const compactor = new IdleHeapCompactor(gc, 1000);

    compactor.noteActivity(10_000);
    expect(compactor.maybeCompact(11_000)).toBe(true);

    // Re-polling the same stale timestamp must not re-arm compaction.
    compactor.observeActivityAt(10_000);
    expect(compactor.maybeCompact(12_000)).toBe(false);
    expect(gc).toHaveBeenCalledTimes(1);

    // A genuinely newer timestamp does re-arm.
    compactor.observeActivityAt(12_500);
    expect(compactor.maybeCompact(13_500)).toBe(true);
    expect(gc).toHaveBeenCalledTimes(2);
  });

  it("is a no-op without a gc function", () => {
    const compactor = new IdleHeapCompactor(null, 1000);
    compactor.noteActivity(10_000);
    expect(compactor.maybeCompact(20_000)).toBe(false);
  });

  it("does not latch compacted state when gc throws", () => {
    const gc = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("gc failed");
      })
      .mockImplementation(() => {});
    const compactor = new IdleHeapCompactor(gc, 1000);

    compactor.noteActivity(10_000);
    expect(compactor.maybeCompact(11_000)).toBe(false);
    // Next check retries instead of assuming the failed GC ran.
    expect(compactor.maybeCompact(11_100)).toBe(true);
    expect(gc).toHaveBeenCalledTimes(2);
  });

  it("uses the exported default threshold", () => {
    const gc = vi.fn();
    const compactor = new IdleHeapCompactor(gc);
    compactor.noteActivity(0);
    expect(compactor.maybeCompact(IDLE_HEAP_COMPACT_AFTER_MS - 1)).toBe(false);
    expect(compactor.maybeCompact(IDLE_HEAP_COMPACT_AFTER_MS)).toBe(true);
  });
});
