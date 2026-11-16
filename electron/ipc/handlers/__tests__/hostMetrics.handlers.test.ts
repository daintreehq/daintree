import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));
vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../window/webContentsRegistry.js")>()),
  getProjectForWebContents: () => null,
  getWindowForWebContents: () => null,
}));
vi.mock("../../../window/windowRef.js", () => ({
  getProjectViewManager: vi.fn(() => null),
  setProjectViewManager: vi.fn(),
  getWindowRegistry: vi.fn(() => null),
  setWindowRegistry: vi.fn(),
  getMainWindow: vi.fn(() => null),
  setMainWindow: vi.fn(),
}));

import { CHANNELS } from "../../channels.js";
import {
  _resetHostFiguresDemandForTesting,
  areHostFiguresFollowed,
} from "../../../services/hostFiguresDemand.js";
import { hostMetricsNamespace, registerHostMetricsHandlers } from "../hostMetrics.js";

class FakeSender extends EventEmitter {
  destroyed = false;
  constructor(readonly id: number) {
    super();
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }
  /** Every listener the lease put on this view. */
  watching(): number {
    return (
      this.listenerCount("did-navigate") +
      this.listenerCount("did-fail-provisional-load") +
      this.listenerCount("render-process-gone") +
      this.listenerCount("destroyed")
    );
  }
}

let unregister: (() => void) | null = null;

/** What a view's `hostMetrics.setFollowing` reaches: the registered handler, validation and all. */
async function follow(sender: FakeSender, payload: unknown): Promise<void> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(
    ([channel]) => channel === CHANNELS.HOST_METRICS_SET_FOLLOWING
  );
  if (!call) throw new Error("setFollowing was never registered");
  const handler = call[1] as (...args: unknown[]) => Promise<unknown>;
  const result = (await handler({ sender }, payload)) as { ok?: boolean; error?: unknown };
  if (result?.ok === false) throw new Error(JSON.stringify(result.error));
}

beforeEach(() => {
  vi.clearAllMocks();
  unregister = registerHostMetricsHandlers();
});

afterEach(() => {
  unregister?.();
  unregister = null;
  _resetHostFiguresDemandForTesting();
});

describe("hostMetrics setFollowing", () => {
  it("counts each view once, until its release", async () => {
    const a = new FakeSender(1);
    const b = new FakeSender(2);
    await follow(a, { following: true });
    await follow(a, { following: true });
    await follow(b, { following: true });
    expect(areHostFiguresFollowed()).toBe(true);

    await follow(a, { following: false });
    expect(areHostFiguresFollowed()).toBe(true);
    expect(a.watching()).toBe(0);
    await follow(b, { following: false });
    expect(areHostFiguresFollowed()).toBe(false);
    expect(b.watching()).toBe(0);
  });

  it("refuses anything but an explicit boolean, leaving demand as it was", async () => {
    const view = new FakeSender(3);
    await follow(view, { following: true });
    for (const payload of [{ following: "no" }, {}, { following: false, webContentsId: 9 }]) {
      await expect(follow(view, payload)).rejects.toThrow();
    }
    expect(areHostFiguresFollowed()).toBe(true);
  });

  it.each([
    ["is replaced by a reload", (s: FakeSender) => s.emit("did-navigate")],
    [
      "commits an error page",
      (s: FakeSender) => s.emit("did-fail-provisional-load", {}, -105, "", "app://x", true),
    ],
    ["crashes", (s: FakeSender) => s.emit("render-process-gone")],
    ["closes", (s: FakeSender) => s.destroy()],
  ] as const)("lets a view go when its document %s without releasing", async (_how, leave) => {
    const view = new FakeSender(4);
    await follow(view, { following: true });
    leave(view);
    await Promise.resolve();
    expect(areHostFiguresFollowed()).toBe(false);
    expect(view.watching()).toBe(0);
  });

  it("keeps a view whose navigation never commits, or whose subframe fails", async () => {
    const view = new FakeSender(5);
    await follow(view, { following: true });
    // A navigation the window's will-navigate guard cancels starts and ends with no commit.
    view.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    view.emit("did-stop-loading");
    view.emit("did-fail-provisional-load", {}, -3, "", "https://x", false);
    expect(areHostFiguresFollowed()).toBe(true);
  });

  it("ignores a caller that isn't one of this machine's views", async () => {
    const op = hostMetricsNamespace.ops.setFollowing as unknown as {
      handler(ctx: unknown, payload: unknown): Promise<void>;
    };
    await op.handler({ event: null }, { following: true });
    expect(areHostFiguresFollowed()).toBe(false);
  });

  it("drops every view's demand when the handlers go", async () => {
    const a = new FakeSender(6);
    const b = new FakeSender(7);
    await follow(a, { following: true });
    await follow(b, { following: true });
    unregister!();
    unregister = null;
    expect(areHostFiguresFollowed()).toBe(false);
    expect(a.watching()).toBe(0);
    expect(b.watching()).toBe(0);
  });
});
