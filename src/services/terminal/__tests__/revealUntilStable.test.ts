// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logWarnMock = vi.hoisted(() => vi.fn());

vi.mock("@/utils/logger", () => ({
  logWarn: logWarnMock,
}));

import { MAX_REVEAL_FRAMES, REVEAL_CONFIRM_PAINTS, revealUntilStable } from "../revealUntilStable";

let rafQueue: FrameRequestCallback[] = [];

/**
 * Drain queued rAF callbacks and microtasks alternately. A SYNCHRONOUS rAF stub
 * (one that invokes the callback inline) collapses the frame separation the
 * confirm-paint pass depends on, so frames are queued and flushed explicitly.
 */
async function pump(ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    const queued = rafQueue;
    rafQueue = [];
    for (const cb of queued) cb(0);
    await Promise.resolve();
  }
}

beforeEach(() => {
  rafQueue = [];
  logWarnMock.mockClear();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("revealUntilStable", () => {
  it("confirms the reveal only after repeated paints on separate frames", async () => {
    const attempt = vi.fn(() => true);
    let settled = false;
    const result = revealUntilStable("t-1", attempt, () => false, "[test]").then((value) => {
      settled = true;
      return value;
    });

    // The first pass runs eagerly, but a single paint must NOT settle the reveal:
    // it can land before the compositor presents the frame, so it doesn't stick.
    // The confirm paint only becomes reachable once a frame has been yielded.
    await Promise.resolve();
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await pump(MAX_REVEAL_FRAMES);
    await expect(result).resolves.toBe(true);
    expect(attempt).toHaveBeenCalledTimes(REVEAL_CONFIRM_PAINTS);
    expect(attempt).toHaveBeenCalledWith("t-1");
  });

  it("retries across frames while the terminal reports itself unpaintable", async () => {
    const paintable = vi.fn(() => paintable.mock.calls.length > 3);
    const result = revealUntilStable("t-1", paintable, () => false, "[test]");

    await pump(MAX_REVEAL_FRAMES);

    await expect(result).resolves.toBe(true);
    // Three not-yet-paintable frames, then the confirm paints.
    expect(paintable).toHaveBeenCalledTimes(3 + REVEAL_CONFIRM_PAINTS);
  });

  it("reports the reveal undischarged when the frame budget runs out", async () => {
    const attempt = vi.fn(() => false);
    const result = revealUntilStable("t-1", attempt, () => false, "[test]");

    await pump(MAX_REVEAL_FRAMES + 2);

    // A terminal that never becomes paintable must not spin forever, and the
    // caller must learn the obligation is still outstanding.
    await expect(result).resolves.toBe(false);
    expect(attempt).toHaveBeenCalledTimes(MAX_REVEAL_FRAMES);
  });

  it("stops immediately once the caller aborts", async () => {
    let aborted = false;
    // Never paintable, so the loop is still retrying when the abort lands — a
    // reveal that had already banked its confirm paints would have exited on its
    // own and proven nothing about the abort.
    const attempt = vi.fn(() => false);
    const result = revealUntilStable("t-1", attempt, () => aborted, "[test]");

    await pump(1);
    const callsBeforeAbort = attempt.mock.calls.length;
    expect(callsBeforeAbort).toBeGreaterThan(0);

    aborted = true;
    await pump(MAX_REVEAL_FRAMES);

    await expect(result).resolves.toBe(false);
    expect(attempt).toHaveBeenCalledTimes(callsBeforeAbort);
  });

  it("does not abort when the caller stays live", async () => {
    const isAborted = vi.fn(() => false);
    const result = revealUntilStable("t-1", () => true, isAborted, "[test]");

    await pump(MAX_REVEAL_FRAMES);

    await expect(result).resolves.toBe(true);
    expect(isAborted).toHaveBeenCalled();
  });

  it("isolates a throwing reveal, logging it under the caller's context", async () => {
    const boom = new Error("renderer gone");
    const attempt = vi.fn(() => {
      throw boom;
    });

    const result = revealUntilStable("t-1", attempt, () => false, "[assistantReveal]");
    await pump(MAX_REVEAL_FRAMES);

    await expect(result).resolves.toBe(false);
    expect(attempt).toHaveBeenCalledTimes(1);
    // The MESSAGE, not the Error (#11776). `Error.message` is non-enumerable,
    // so logging the object itself serialised the whole context to
    // `{"error":{}}` — the one line that could explain a wedged terminal said
    // nothing at all in the diagnostics bundle.
    expect(logWarnMock).toHaveBeenCalledWith("[assistantReveal] reveal failed", {
      id: "t-1",
      error: "renderer gone",
    });
  });

  it("awaits an async reveal pass before counting it", async () => {
    const attempt = vi.fn(() => Promise.resolve(true));
    const result = revealUntilStable("t-1", attempt, () => false, "[test]");

    await pump(MAX_REVEAL_FRAMES);

    await expect(result).resolves.toBe(true);
    expect(attempt).toHaveBeenCalledTimes(REVEAL_CONFIRM_PAINTS);
  });
});
