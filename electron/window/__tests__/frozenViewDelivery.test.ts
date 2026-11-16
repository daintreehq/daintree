import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

const cachedIds = vi.hoisted(() => new Set<number>());
vi.mock("../webContentsRegistry.js", () => ({
  isCachedViewWebContents: (id: number) => cachedIds.has(id),
}));

import { freezeWebContents, unfreezeWebContents } from "../../utils/webContentsLifecycle.js";
import { isFrozenCachedView, releaseHeldSends, sendLatestWins } from "../frozenViewDelivery.js";

let nextId = 1;

function makeView(opts: { freezeNeverSent?: boolean } = {}) {
  let destroyed = false;
  const send = vi.fn();
  const wc = {
    id: nextId++,
    isDestroyed: () => destroyed,
    send,
    debugger: {
      isAttached: () => true,
      attach: vi.fn(),
      sendCommand: vi.fn(async (method: string) => {
        if (opts.freezeNeverSent && method === "Page.enable") throw new Error("Target closed");
      }),
    },
  } as unknown as WebContents;
  return {
    wc,
    send,
    destroy: () => {
      destroyed = true;
    },
  };
}

async function frozenCachedView(opts: { freezeNeverSent?: boolean } = {}) {
  const view = makeView(opts);
  cachedIds.add(view.wc.id);
  await freezeWebContents(view.wc);
  return view;
}

describe("frozenViewDelivery (#17038)", () => {
  beforeEach(() => {
    cachedIds.clear();
  });

  it("sends at once to a view that is not frozen, cached or not", () => {
    const active = makeView();
    const cached = makeView();
    cachedIds.add(cached.wc.id);

    sendLatestWins(active.wc, "k", "chan", 1);
    sendLatestWins(cached.wc, "k", "chan", 2);

    expect(active.send).toHaveBeenCalledWith("chan", 1);
    expect(cached.send).toHaveBeenCalledWith("chan", 2);
  });

  it("never holds an active view, even one whose thaw has not landed", async () => {
    const view = makeView();
    await freezeWebContents(view.wc);

    expect(isFrozenCachedView(view.wc)).toBe(false);
    sendLatestWins(view.wc, "k", "chan", 1);

    expect(view.send).toHaveBeenCalledWith("chan", 1);
  });

  it("holds only the newest per key while frozen, and sends each once when the view thaws", async () => {
    const view = await frozenCachedView();

    for (let i = 0; i < 500; i++) sendLatestWins(view.wc, "fleet", "fleet:updated", { i });
    sendLatestWins(view.wc, "events:push:power", "events:push", { name: "power", level: 1 });
    sendLatestWins(view.wc, "events:push:other", "events:push", { name: "other" });
    sendLatestWins(view.wc, "events:push:power", "events:push", { name: "power", level: 2 });
    expect(view.send).not.toHaveBeenCalled();

    await unfreezeWebContents(view.wc);

    // In the order the newest values arrived.
    expect(view.send.mock.calls).toEqual([
      ["fleet:updated", { i: 499 }],
      ["events:push", { name: "other" }],
      ["events:push", { name: "power", level: 2 }],
    ]);

    // Nothing is held twice, and the thawed view is sent to directly.
    view.send.mockClear();
    releaseHeldSends(view.wc);
    sendLatestWins(view.wc, "fleet", "fleet:updated", { i: 500 });
    expect(view.send.mock.calls).toEqual([["fleet:updated", { i: 500 }]]);
  });

  it("sends what it held when the view is activated, before its thaw lands, and only once", async () => {
    const view = await frozenCachedView();
    sendLatestWins(view.wc, "bounds", "resize", { width: 1 });
    sendLatestWins(view.wc, "bounds", "resize", { width: 2 });

    cachedIds.delete(view.wc.id);
    releaseHeldSends(view.wc);
    expect(view.send.mock.calls).toEqual([["resize", { width: 2 }]]);

    await unfreezeWebContents(view.wc);
    expect(view.send).toHaveBeenCalledTimes(1);
  });

  it("sends what it held when a freeze that never went out is given up", async () => {
    const view = makeView({ freezeNeverSent: true });
    cachedIds.add(view.wc.id);
    const freezing = freezeWebContents(view.wc);
    sendLatestWins(view.wc, "stats", "stats:updated", { a: 1 });
    expect(view.send).not.toHaveBeenCalled();

    await freezing;

    expect(view.send.mock.calls).toEqual([["stats:updated", { a: 1 }]]);
  });

  it("keeps holding through a thaw that failed", async () => {
    const view = await frozenCachedView();
    sendLatestWins(view.wc, "stats", "stats:updated", { a: 1 });
    vi.mocked(view.wc.debugger.sendCommand).mockRejectedValueOnce(new Error("Target closed"));

    await unfreezeWebContents(view.wc);

    expect(view.send).not.toHaveBeenCalled();
    await unfreezeWebContents(view.wc);
    expect(view.send.mock.calls).toEqual([["stats:updated", { a: 1 }]]);
  });

  it("drops what it held for a view destroyed before it thaws", async () => {
    const view = await frozenCachedView();
    sendLatestWins(view.wc, "stats", "stats:updated", { a: 1 });
    view.destroy();

    releaseHeldSends(view.wc);
    sendLatestWins(view.wc, "stats", "stats:updated", { a: 2 });

    expect(view.send).not.toHaveBeenCalled();
  });

  it("still sends the other keys when one send throws", async () => {
    const view = await frozenCachedView();
    sendLatestWins(view.wc, "a", "chan-a", 1);
    sendLatestWins(view.wc, "b", "chan-b", 2);
    view.send.mockImplementationOnce(() => {
      throw new Error("disposed");
    });

    await unfreezeWebContents(view.wc);

    expect(view.send.mock.calls).toEqual([
      ["chan-a", 1],
      ["chan-b", 2],
    ]);
  });
});
