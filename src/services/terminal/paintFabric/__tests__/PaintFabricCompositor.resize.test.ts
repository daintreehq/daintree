import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaintFabricCompositor } from "../PaintFabricCompositor";
import { GRID_RESIZE_COALESCE_MS } from "../../types";
import { makeSurface } from "./fakePaintPlane";

// Phase 1 watch-list: "cross-surface resize-pass coordination". One logical
// pass can span every surface, while scoped passes must not discard pending
// fresh-measurement obligations on surfaces outside their id set.
function makeCompositor() {
  const a = makeSurface("a");
  const b = makeSurface("b");
  const compositor = new PaintFabricCompositor({
    surfaces: [a.surface, b.surface],
    choosePlacement: (terminalId, registry) =>
      registry.surfaces().find((s) => s.id === (terminalId.endsWith("-b") ? "b" : "a")) ??
      registry.defaultSurface(),
  });
  return { compositor, a: a.plane, b: b.plane };
}

describe("PaintFabricCompositor resize coordination", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst into ONE logical pass partitioned across surfaces", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    await compositor.getOrCreate("t2-a", undefined, {});

    compositor.scheduleBatchResize(["t1-b"]);
    compositor.scheduleBatchResize(["t2-a"]);
    expect(a.runResizePass).not.toHaveBeenCalled();
    expect(b.runResizePass).not.toHaveBeenCalled();

    // Trailing-edge debounce + the frame hop (setTimeout fallback in Node).
    vi.advanceTimersByTime(GRID_RESIZE_COALESCE_MS + 16);

    expect(b.runResizePass).toHaveBeenCalledWith(["t1-b"]);
    expect(a.runResizePass).toHaveBeenCalledWith(["t2-a"]);
    // Shards of the SAME logical pass never cancel each other.
    expect(a.cancelActiveResizePass).not.toHaveBeenCalled();
    expect(b.cancelActiveResizePass).not.toHaveBeenCalled();
  });

  it("a scoped pass preserves active work on surfaces outside the pass", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    await compositor.getOrCreate("t2-a", undefined, {});

    // Pass 1 hits only surface b; its chunked work is now in flight.
    compositor.runResizePass(["t1-b"]);
    expect(b.runResizePass).toHaveBeenCalledWith(["t1-b"]);
    expect(a.cancelActiveResizePass).not.toHaveBeenCalled();

    // Pass 2 is independently scoped to surface a. Surface b's pending work is
    // still valid and remains owned until it completes or is explicitly
    // cancelled.
    compositor.runResizePass(["t2-a"]);
    expect(a.runResizePass).toHaveBeenCalledWith(["t2-a"]);
    expect(b.cancelActiveResizePass).not.toHaveBeenCalled();
  });

  it("an empty pass is a no-op and cancels nothing", () => {
    const { compositor, a, b } = makeCompositor();
    compositor.runResizePass([]);
    expect(a.runResizePass).not.toHaveBeenCalled();
    expect(b.runResizePass).not.toHaveBeenCalled();
    expect(a.cancelActiveResizePass).not.toHaveBeenCalled();
    expect(b.cancelActiveResizePass).not.toHaveBeenCalled();
  });

  it("issues no cross-surface cancels at surface-count 1 (Phase 0 parity)", () => {
    const only = makeSurface("only");
    const compositor = new PaintFabricCompositor({ surfaces: [only.surface] });
    compositor.runResizePass(["t1", "t2"]);
    expect(only.plane.runResizePass).toHaveBeenCalledWith(["t1", "t2"]);
    expect(only.plane.cancelActiveResizePass).not.toHaveBeenCalled();
  });

  it("cancelActiveResizePass fans out to every surface", () => {
    const { compositor, a, b } = makeCompositor();
    compositor.cancelActiveResizePass();
    expect(a.cancelActiveResizePass).toHaveBeenCalledTimes(1);
    expect(b.cancelActiveResizePass).toHaveBeenCalledTimes(1);
  });

  it("dispose clears a pending coalesced pass", async () => {
    const { compositor, a, b } = makeCompositor();
    await compositor.getOrCreate("t1-b", undefined, {});
    compositor.scheduleBatchResize(["t1-b"]);
    compositor.dispose();
    vi.advanceTimersByTime(GRID_RESIZE_COALESCE_MS + 32);
    expect(a.runResizePass).not.toHaveBeenCalled();
    expect(b.runResizePass).not.toHaveBeenCalled();
  });
});
