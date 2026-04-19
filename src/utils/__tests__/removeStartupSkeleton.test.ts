// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("removeStartupSkeleton", () => {
  let rafQueue: FrameRequestCallback[];
  let notifyFirstInteractive: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    rafQueue = [];
    notifyFirstInteractive = vi.fn(() => Promise.resolve());

    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });

    (
      window as unknown as { electron: { app: { notifyFirstInteractive: () => Promise<void> } } }
    ).electron = {
      app: { notifyFirstInteractive: notifyFirstInteractive as unknown as () => Promise<void> },
    };

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    document.getElementById("startup-skeleton")?.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete (window as unknown as { electron?: unknown }).electron;
  });

  function addSkeleton(): HTMLDivElement {
    const el = document.createElement("div");
    el.id = "startup-skeleton";
    document.body.appendChild(el);
    return el;
  }

  function flushRaf() {
    const batch = rafQueue.splice(0);
    for (const cb of batch) cb(performance.now());
  }

  it("adds fade-out class after two RAF ticks and removes element after timeout", async () => {
    const { removeStartupSkeleton } = await import("../removeStartupSkeleton");
    const el = addSkeleton();
    removeStartupSkeleton();

    expect(el.classList.contains("fade-out")).toBe(false);
    expect(notifyFirstInteractive).not.toHaveBeenCalled();

    flushRaf(); // outer RAF — schedules inner
    expect(el.classList.contains("fade-out")).toBe(false);
    expect(notifyFirstInteractive).not.toHaveBeenCalled();

    flushRaf(); // inner RAF — fires signal, adds fade-out, schedules setTimeout
    expect(el.classList.contains("fade-out")).toBe(true);
    expect(el.getAttribute("aria-busy")).toBe("false");
    expect(notifyFirstInteractive).toHaveBeenCalledTimes(1);
    expect(document.getElementById("startup-skeleton")).toBe(el);

    vi.advanceTimersByTime(250);
    expect(document.getElementById("startup-skeleton")).toBeNull();
  });

  it("signals first-interactive even when skeleton is absent", async () => {
    const { removeStartupSkeleton } = await import("../removeStartupSkeleton");
    removeStartupSkeleton();
    expect(rafQueue.length).toBe(0);
    expect(notifyFirstInteractive).toHaveBeenCalledTimes(1);
  });

  it("only notifies first-interactive once across repeated calls", async () => {
    const { removeStartupSkeleton } = await import("../removeStartupSkeleton");
    addSkeleton();
    removeStartupSkeleton();
    removeStartupSkeleton();

    flushRaf(); // both outer RAFs run
    flushRaf(); // both inner RAFs run

    expect(notifyFirstInteractive).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(250);
    expect(document.getElementById("startup-skeleton")).toBeNull();

    removeStartupSkeleton(); // no-op, should not throw
    expect(notifyFirstInteractive).toHaveBeenCalledTimes(1);
  });

  it("swallows errors from the IPC bridge", async () => {
    const throwing = vi.fn(() => {
      throw new Error("bridge unavailable");
    });
    (
      window as unknown as { electron: { app: { notifyFirstInteractive: () => Promise<void> } } }
    ).electron = {
      app: { notifyFirstInteractive: throwing as unknown as () => Promise<void> },
    };
    const { removeStartupSkeleton } = await import("../removeStartupSkeleton");
    expect(() => removeStartupSkeleton()).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
  });
});
