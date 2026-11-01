import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  isViewHydrated,
  markViewHydrated,
  whenViewHydrated,
  _resetViewHydrationForTesting,
  _viewHydrationWaitersForTesting,
} from "../viewHydration.js";

let nextId = 1;

function fakeWebContents() {
  const wc = Object.assign(new EventEmitter(), { id: nextId++, destroyed: false });
  return Object.assign(wc, { isDestroyed: () => wc.destroyed });
}

beforeEach(() => {
  _resetViewHydrationForTesting();
});

describe("viewHydration", () => {
  it("latches per renderer until its document is replaced", () => {
    const wc = fakeWebContents();
    const other = fakeWebContents();
    markViewHydrated(wc as never);

    expect(isViewHydrated(wc.id)).toBe(true);
    expect(isViewHydrated(other.id)).toBe(false);

    wc.emit("did-navigate");
    expect(isViewHydrated(wc.id)).toBe(false);

    // The reloaded document reports hydration again on its own.
    markViewHydrated(wc as never);
    expect(isViewHydrated(wc.id)).toBe(true);
  });

  it("runs what waits on a renderer once it hydrates, or at once if it has", () => {
    const wc = fakeWebContents();
    const first = vi.fn();
    const cancelled = vi.fn();
    whenViewHydrated(wc as never, first);
    const cancel = whenViewHydrated(wc as never, cancelled);
    cancel();
    expect(first).not.toHaveBeenCalled();

    markViewHydrated(wc as never);
    expect(first).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
    expect(_viewHydrationWaitersForTesting()).toBe(0);

    const later = vi.fn();
    whenViewHydrated(wc as never, later);
    expect(later).toHaveBeenCalledTimes(1);

    // The reloaded document is waited on afresh.
    wc.emit("did-navigate");
    const afterReload = vi.fn();
    whenViewHydrated(wc as never, afterReload);
    expect(afterReload).not.toHaveBeenCalled();
    markViewHydrated(wc as never);
    expect(afterReload).toHaveBeenCalledTimes(1);
  });

  it("forgets a cancelled wait", () => {
    const wc = fakeWebContents();
    const cancel = whenViewHydrated(wc as never, () => {});
    expect(_viewHydrationWaitersForTesting()).toBe(1);
    cancel();
    expect(_viewHydrationWaitersForTesting()).toBe(0);
  });

  it("survives a main-frame navigation that never commits", () => {
    const wc = fakeWebContents();
    markViewHydrated(wc as never);

    wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    wc.emit("did-stop-loading");

    expect(isViewHydrated(wc.id)).toBe(true);
  });

  it("clears when the renderer dies or a main-frame error page commits", () => {
    const crashed = fakeWebContents();
    const failed = fakeWebContents();
    markViewHydrated(crashed as never);
    markViewHydrated(failed as never);

    crashed.emit("render-process-gone", {}, { reason: "crashed" });
    failed.emit("did-fail-provisional-load", {}, -2, "failed", "app://x", false);
    expect(isViewHydrated(failed.id)).toBe(true);
    failed.emit("did-fail-provisional-load", {}, -2, "failed", "app://x", true);

    expect(isViewHydrated(crashed.id)).toBe(false);
    expect(isViewHydrated(failed.id)).toBe(false);
  });

  it("clears on destroy and ignores an already-destroyed renderer", () => {
    const wc = fakeWebContents();
    markViewHydrated(wc as never);
    wc.emit("destroyed");
    expect(isViewHydrated(wc.id)).toBe(false);

    const gone = fakeWebContents();
    gone.destroyed = true;
    markViewHydrated(gone as never);
    expect(isViewHydrated(gone.id)).toBe(false);
  });

  it("watches each renderer once however often it reports", () => {
    const wc = fakeWebContents();
    markViewHydrated(wc as never);
    markViewHydrated(wc as never);
    markViewHydrated(wc as never);

    expect(wc.listenerCount("did-navigate")).toBe(1);
    expect(wc.listenerCount("destroyed")).toBe(1);
  });
});
