import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { onWebContentsDestroyed } from "../webContentsDestroyed.js";

let nextId = 1;

function fakeWebContents(id = nextId++) {
  let destroyed = false;
  const wc = Object.assign(new EventEmitter(), {
    id,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      wc.emit("destroyed");
    },
  });
  return wc;
}

function watch(wc: EventEmitter, callback: () => void) {
  return onWebContentsDestroyed(wc as never, callback);
}

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("onWebContentsDestroyed", () => {
  it("shares one destroyed listener between every watcher of a view", () => {
    const wc = fakeWebContents();
    const a = vi.fn();
    const b = vi.fn();
    watch(wc, a);
    watch(wc, b);
    watch(wc, a);

    expect(wc.listenerCount("destroyed")).toBe(1);
    wc.destroy();
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledOnce();
    expect(wc.listenerCount("destroyed")).toBe(0);
  });

  it("removes the listener with the last watcher, and adds a fresh one after", () => {
    const wc = fakeWebContents();
    const a = vi.fn();
    const b = vi.fn();
    const unwatchA = watch(wc, a);
    const unwatchB = watch(wc, b);

    unwatchA();
    unwatchA();
    expect(wc.listenerCount("destroyed")).toBe(1);
    unwatchB();
    expect(wc.listenerCount("destroyed")).toBe(0);

    const c = vi.fn();
    watch(wc, c);
    expect(wc.listenerCount("destroyed")).toBe(1);
    wc.destroy();
    expect(c).toHaveBeenCalledOnce();
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("runs every watcher even when one throws", () => {
    const wc = fakeWebContents();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const after = vi.fn();
    watch(wc, () => {
      throw new Error("boom");
    });
    watch(wc, after);

    wc.destroy();

    expect(after).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("still runs a watcher that an earlier one unwatched mid-teardown, as an emitter would", () => {
    const wc = fakeWebContents();
    const second = vi.fn();
    let unwatchSecond = () => {};
    watch(wc, () => unwatchSecond());
    unwatchSecond = watch(wc, second);

    wc.destroy();

    expect(second).toHaveBeenCalledOnce();
  });

  it("runs a watcher added during teardown on the next microtask, without a dead listener", async () => {
    const wc = fakeWebContents();
    const late = vi.fn();
    const cancelled = vi.fn();
    watch(wc, () => {
      watch(wc, late);
      watch(wc, cancelled)();
    });

    // Emitted while the view still reports itself alive, so only the teardown
    // already under way marks it.
    wc.emit("destroyed");
    expect(late).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(late).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
    expect(wc.listenerCount("destroyed")).toBe(0);
  });

  it("runs a watcher of a view already destroyed on the next microtask, unless it unwatches first", async () => {
    const wc = fakeWebContents();
    wc.destroy();
    const runs = vi.fn();
    const cancelled = vi.fn();

    watch(wc, runs);
    watch(wc, cancelled)();
    await Promise.resolve();

    expect(runs).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
    expect(wc.listenerCount("destroyed")).toBe(0);
  });

  it("keeps a new WebContents under a reused id apart from the old one's watchers", () => {
    for (const order of ["old destroyed", "old unwatched", "new destroyed first"] as const) {
      const id = nextId++;
      const oldWc = fakeWebContents(id);
      const oldWatcher = vi.fn();
      const unwatchOld = watch(oldWc, oldWatcher);
      const newWc = fakeWebContents(id);
      const newWatcher = vi.fn();
      watch(newWc, newWatcher);

      if (order === "new destroyed first") {
        newWc.destroy();
        oldWc.destroy();
        expect(newWatcher).toHaveBeenCalledOnce();
        expect(oldWatcher).toHaveBeenCalledOnce();
        continue;
      }

      if (order === "old destroyed") oldWc.destroy();
      unwatchOld();
      // The replacement still has its watcher: a later watch shares its listener.
      watch(newWc, () => {});
      expect(newWc.listenerCount("destroyed")).toBe(1);

      newWc.destroy();
      expect(newWatcher).toHaveBeenCalledOnce();
      expect(oldWatcher).toHaveBeenCalledTimes(order === "old destroyed" ? 1 : 0);
    }
  });

  it("keeps a view at the listener limit under it however many watch it", async () => {
    const wc = fakeWebContents();
    for (let i = 0; i < 9; i++) wc.once("destroyed", () => {});
    const warn = vi.fn();
    process.on("warning", warn);
    try {
      // A host view's endpoint, preview capability, relays and local IPC
      // endpoint, plus plugin requests waiting on it.
      for (let i = 0; i < 20; i++) watch(wc, () => {});
      expect(wc.listenerCount("destroyed")).toBe(10);
      // Node delivers MaxListenersExceededWarning on a later tick.
      await nextTick();
    } finally {
      process.off("warning", warn);
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
