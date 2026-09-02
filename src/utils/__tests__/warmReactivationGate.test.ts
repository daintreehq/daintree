import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notifyWarmReactivationComplete } from "../warmReactivationGate";

describe("notifyWarmReactivationComplete", () => {
  const rafQueue: FrameRequestCallback[] = [];
  let notifyWarmViewPainted: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    rafQueue.length = 0;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
      rafQueue.push(cb);
      return rafQueue.length;
    }) as typeof globalThis.requestAnimationFrame;

    notifyWarmViewPainted = vi.fn(() => Promise.resolve());
    (globalThis as unknown as { window: unknown }).window = {
      electron: { app: { notifyWarmViewPainted } },
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  function flushFrame(): void {
    const cb = rafQueue.shift();
    if (cb) cb(0);
  }

  it("fires the IPC synchronously without waiting for an animation frame", () => {
    // The view is undrawn behind the anti-flash bridge, where frames arrive at
    // ~2 Hz, so a frame-deferred signal would run the gate into its hard timeout.
    notifyWarmReactivationComplete();
    expect(notifyWarmViewPainted).toHaveBeenCalledTimes(1);
    expect(rafQueue).toHaveLength(0);
  });

  it("swallows a rejected IPC promise without throwing", () => {
    notifyWarmViewPainted.mockReturnValue(Promise.reject(new Error("bridge down")));
    expect(() => notifyWarmReactivationComplete()).not.toThrow();
  });

  it("fires synchronously when requestAnimationFrame is unavailable", () => {
    (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = undefined;
    notifyWarmReactivationComplete();
    expect(notifyWarmViewPainted).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the preload bridge is absent", () => {
    (globalThis as unknown as { window: unknown }).window = {};
    expect(() => {
      notifyWarmReactivationComplete();
      flushFrame();
      flushFrame();
    }).not.toThrow();
  });
});
