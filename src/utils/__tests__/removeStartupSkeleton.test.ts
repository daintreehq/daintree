// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeStartupSkeleton } from "../removeStartupSkeleton";

describe("removeStartupSkeleton", () => {
  let rafQueue: FrameRequestCallback[];

  beforeEach(() => {
    rafQueue = [];

    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    document.getElementById("startup-skeleton")?.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

  it("adds fade-out class after two RAF ticks and removes element after timeout", () => {
    const el = addSkeleton();
    removeStartupSkeleton();

    expect(el.classList.contains("fade-out")).toBe(false);

    flushRaf(); // outer RAF — schedules inner
    expect(el.classList.contains("fade-out")).toBe(false);

    flushRaf(); // inner RAF — adds fade-out, schedules setTimeout
    expect(el.classList.contains("fade-out")).toBe(true);
    expect(el.getAttribute("aria-busy")).toBe("false");
    expect(document.getElementById("startup-skeleton")).toBe(el);

    vi.advanceTimersByTime(250);
    expect(document.getElementById("startup-skeleton")).toBeNull();
  });

  it("does nothing if element is absent", () => {
    removeStartupSkeleton();
    expect(rafQueue.length).toBe(0);
  });

  it("tolerates repeated calls", () => {
    addSkeleton();
    removeStartupSkeleton();
    removeStartupSkeleton();

    flushRaf(); // both outer RAFs run
    flushRaf(); // both inner RAFs run

    vi.advanceTimersByTime(250);
    expect(document.getElementById("startup-skeleton")).toBeNull();

    removeStartupSkeleton(); // no-op, should not throw
  });
});
