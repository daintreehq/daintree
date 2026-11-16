import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

const { hostMetricsNamespace, registerHostMetricsHandlers } = await import("../hostMetrics.js");
const { _resetHostFiguresDemandForTesting, areHostFiguresFollowed } =
  await import("../../../services/hostFiguresDemand.js");

type Handler = (...args: unknown[]) => Promise<unknown>;
const ops = hostMetricsNamespace.ops as unknown as Record<
  string,
  { handler: Handler; schema?: z.ZodTypeAny }
>;

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
}

function follow(sender: FakeSender | null, following: boolean): Promise<unknown> {
  return ops.setFollowing!.handler({ event: sender ? { sender } : null }, { following });
}

let unregister: (() => void) | null = null;

afterEach(() => {
  unregister?.();
  unregister = null;
  _resetHostFiguresDemandForTesting();
});

describe("hostMetrics setFollowing", () => {
  it("counts each view once, until its release", async () => {
    unregister = registerHostMetricsHandlers();
    const a = new FakeSender(1);
    const b = new FakeSender(2);
    await follow(a, true);
    await follow(a, true);
    await follow(b, true);
    expect(areHostFiguresFollowed()).toBe(true);

    await follow(a, false);
    expect(areHostFiguresFollowed()).toBe(true);
    await follow(b, false);
    expect(areHostFiguresFollowed()).toBe(false);
    expect(a.listenerCount("did-start-navigation")).toBe(0);
    expect(a.listenerCount("render-process-gone")).toBe(0);
    expect(a.listenerCount("destroyed")).toBe(0);
  });

  it.each([
    [
      "navigates",
      (s: FakeSender) =>
        s.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false }),
    ],
    ["crashes", (s: FakeSender) => s.emit("render-process-gone")],
    ["closes", (s: FakeSender) => s.destroy()],
  ] as const)("lets a view go when it %s without releasing", async (_how, leave) => {
    unregister = registerHostMetricsHandlers();
    const view = new FakeSender(3);
    await follow(view, true);
    leave(view);
    await Promise.resolve();
    expect(areHostFiguresFollowed()).toBe(false);
    expect(view.listenerCount("did-start-navigation")).toBe(0);
  });

  it("keeps following across an in-page navigation or a subframe's", async () => {
    unregister = registerHostMetricsHandlers();
    const view = new FakeSender(4);
    await follow(view, true);
    view.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    view.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    expect(areHostFiguresFollowed()).toBe(true);
  });

  it("ignores a caller that isn't one of this machine's views", async () => {
    await follow(null, true);
    expect(areHostFiguresFollowed()).toBe(false);
  });

  it("drops every view's demand when the handlers go", async () => {
    unregister = registerHostMetricsHandlers();
    const view = new FakeSender(5);
    await follow(view, true);
    unregister();
    unregister = null;
    expect(areHostFiguresFollowed()).toBe(false);
    expect(view.listenerCount("render-process-gone")).toBe(0);
  });

  it("accepts only an explicit boolean", () => {
    const schema = ops.setFollowing!.schema!;
    expect(schema.safeParse({ following: true }).success).toBe(true);
    expect(schema.safeParse({ following: "yes" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ following: true, webContentsId: 7 }).success).toBe(false);
  });
});
