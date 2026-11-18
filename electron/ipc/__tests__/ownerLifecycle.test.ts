import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createOwnerWatcher } from "../ownerLifecycle.js";
import type { IpcContext } from "../types.js";

let nextSenderId = 1;

class FakeSender extends EventEmitter {
  readonly id = nextSenderId++;
  isDestroyed() {
    return false;
  }
}

function localContext(sender: FakeSender): IpcContext {
  return { event: { sender }, webContentsId: sender.id } as unknown as IpcContext;
}

function remoteContext() {
  const closers = new Set<() => void>();
  const ctx = {
    event: null,
    webContentsId: -1,
    endpoint: {
      onClose: (cb: () => void) => {
        closers.add(cb);
        return { dispose: () => closers.delete(cb) };
      },
    },
  } as unknown as IpcContext;
  return { ctx, close: () => [...closers].forEach((cb) => cb()), listeners: () => closers.size };
}

describe("createOwnerWatcher", () => {
  it("stops the owner on a main-frame navigation, but not a same-document or subframe one", () => {
    const stop = vi.fn();
    const sender = new FakeSender();
    createOwnerWatcher(stop).watch(localContext(sender), "owner-1");

    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    sender.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    expect(stop).not.toHaveBeenCalled();

    sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(stop).toHaveBeenCalledWith("owner-1");
  });

  it("stops the owner when the renderer is lost, and keeps watching for the next loss", () => {
    const stop = vi.fn();
    const sender = new FakeSender();
    createOwnerWatcher(stop).watch(localContext(sender), "owner-1");

    sender.emit("render-process-gone");
    sender.emit("render-process-gone");
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("stops the owner and drops every listener when the view is destroyed", () => {
    const stop = vi.fn();
    const sender = new FakeSender();
    const watcher = createOwnerWatcher(stop);
    watcher.watch(localContext(sender), "owner-1");

    sender.emit("destroyed");
    expect(stop).toHaveBeenCalledWith("owner-1");
    expect(sender.listenerCount("did-start-navigation")).toBe(0);
    expect(sender.listenerCount("render-process-gone")).toBe(0);

    // The owner is free to be watched again under a new view.
    const next = new FakeSender();
    watcher.watch(localContext(next), "owner-1");
    expect(next.listenerCount("render-process-gone")).toBe(1);
  });

  it("watches an owner once, however many requests it sends", () => {
    const sender = new FakeSender();
    const watcher = createOwnerWatcher(vi.fn());
    watcher.watch(localContext(sender), "owner-1");
    watcher.watch(localContext(sender), "owner-1");
    expect(sender.listenerCount("render-process-gone")).toBe(1);
    expect(sender.listenerCount("destroyed")).toBe(1);
  });

  it("stops a remote owner when its endpoint closes", () => {
    const stop = vi.fn();
    const remote = remoteContext();
    createOwnerWatcher(stop).watch(remote.ctx, "remote-owner");

    remote.close();
    expect(stop).toHaveBeenCalledWith("remote-owner");
  });

  it("dispose detaches every watch without stopping anything", () => {
    const stop = vi.fn();
    const sender = new FakeSender();
    const remote = remoteContext();
    const watcher = createOwnerWatcher(stop);
    watcher.watch(localContext(sender), "owner-1");
    watcher.watch(remote.ctx, "remote-owner");

    watcher.dispose();

    expect(sender.listenerCount("did-start-navigation")).toBe(0);
    expect(sender.listenerCount("render-process-gone")).toBe(0);
    expect(sender.listenerCount("destroyed")).toBe(0);
    expect(remote.listeners()).toBe(0);
    sender.emit("render-process-gone");
    expect(stop).not.toHaveBeenCalled();
  });
});
