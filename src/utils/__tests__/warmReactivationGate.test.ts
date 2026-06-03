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

  it("fires the IPC only after two animation frames, not one", () => {
    notifyWarmReactivationComplete();
    expect(notifyWarmViewPainted).not.toHaveBeenCalled();

    flushFrame();
    expect(notifyWarmViewPainted).not.toHaveBeenCalled();

    flushFrame();
    expect(notifyWarmViewPainted).toHaveBeenCalledTimes(1);
  });

  it("swallows a rejected IPC promise without throwing", () => {
    notifyWarmViewPainted.mockReturnValue(Promise.reject(new Error("bridge down")));
    notifyWarmReactivationComplete();
    expect(() => {
      flushFrame();
      flushFrame();
    }).not.toThrow();
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
