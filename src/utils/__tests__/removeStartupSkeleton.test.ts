// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeStartupSkeleton } from "../removeStartupSkeleton";

describe("removeStartupSkeleton", () => {
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextId: number;

  beforeEach(() => {
    rafCallbacks = new Map();
    nextId = 1;

    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextId++;
      rafCallbacks.set(id, cb);
      return id;
    });

    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      rafCallbacks.delete(id);
    });
  });

  afterEach(() => {
    document.getElementById("startup-skeleton")?.remove();
    vi.unstubAllGlobals();
  });

  function addSkeleton(): HTMLDivElement {
    const el = document.createElement("div");
    el.id = "startup-skeleton";
    document.body.appendChild(el);
    return el;
  }

  function flushRaf() {
    const entries = [...rafCallbacks];
    rafCallbacks.clear();
    for (const [, cb] of entries) {
      cb(performance.now());
    }
  }

  it("removes the element after two RAF ticks", () => {
    const el = addSkeleton();
    removeStartupSkeleton();

    expect(document.getElementById("startup-skeleton")).toBe(el);

    flushRaf(); // first RAF
    expect(document.getElementById("startup-skeleton")).toBe(el);

    flushRaf(); // second RAF — element removed
    expect(document.getElementById("startup-skeleton")).toBeNull();
  });

  it("returns no-op cleanup and schedules no RAFs if element is absent", () => {
    const cleanup = removeStartupSkeleton();
    expect(cleanup).toBeTypeOf("function");
    expect(rafCallbacks.size).toBe(0);
    cleanup(); // should not throw
  });

  it("cleanup before first RAF cancels removal", () => {
    addSkeleton();
    const cleanup = removeStartupSkeleton();

    cleanup();
    flushRaf();
    flushRaf();

    expect(document.getElementById("startup-skeleton")).not.toBeNull();
  });

  it("cleanup after first RAF cancels inner removal", () => {
    addSkeleton();
    const cleanup = removeStartupSkeleton();

    flushRaf(); // outer RAF runs, inner is now scheduled
    cleanup(); // cancel the inner RAF
    flushRaf();

    expect(document.getElementById("startup-skeleton")).not.toBeNull();
  });

  it("tolerates repeated calls (Strict Mode safe)", () => {
    addSkeleton();
    const cleanup1 = removeStartupSkeleton();
    const cleanup2 = removeStartupSkeleton();

    cleanup1();
    flushRaf();
    flushRaf();

    expect(document.getElementById("startup-skeleton")).toBeNull();
    cleanup2(); // should not throw
  });
});
