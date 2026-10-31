import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const utilsMock = vi.hoisted(() => {
  const registered = new Map<string, (...a: unknown[]) => unknown>();
  return {
    registered,
    ctx: null as unknown,
    typedHandle: vi.fn((channel: string, handler: (...a: unknown[]) => unknown) => {
      registered.set(channel, handler);
      return () => {};
    }),
    typedHandleWithContext: vi.fn((channel: string, handler: (...a: unknown[]) => unknown) => {
      registered.set(channel, (...a) => handler(utilsMock.ctx, ...a));
      return () => {};
    }),
  };
});

vi.mock("../../utils.js", () => ({
  typedHandle: utilsMock.typedHandle,
  typedHandleWithContext: utilsMock.typedHandleWithContext,
}));

vi.mock("../../../store.js", () => ({ store: { get: vi.fn(), set: vi.fn() } }));

const windowForSender = vi.hoisted(() => new Map<number, { id: number }>());
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn((wc: { id: number }) => windowForSender.get(wc.id) ?? null),
}));

import { registerSessionRestoreHandlers } from "../sessionRestore.js";
import { isViewHydrated, _resetViewHydrationForTesting } from "../../../window/viewHydration.js";
import type { HandlerDependencies } from "../../types.js";

const CHANNEL = "session-restore:view-hydrated";

function fakeSender(id: number) {
  const wc = Object.assign(new EventEmitter(), { id, destroyed: false });
  return Object.assign(wc, { isDestroyed: () => wc.destroyed });
}

describe("sessionRestore notifyViewHydrated", () => {
  const windowPvm = { signalViewHydrated: vi.fn() };
  const globalPvm = { signalViewHydrated: vi.fn() };

  beforeEach(() => {
    utilsMock.registered.clear();
    windowForSender.clear();
    windowPvm.signalViewHydrated.mockClear();
    globalPvm.signalViewHydrated.mockClear();
    _resetViewHydrationForTesting();
    registerSessionRestoreHandlers({
      windowRegistry: {
        getByWindowId: (id: number) =>
          id === 1 ? { services: { projectViewManager: windowPvm } } : undefined,
      },
      projectViewManager: globalPvm,
    } as unknown as HandlerDependencies);
  });

  it("latches hydration for the sending renderer only and settles its window's restore", async () => {
    const sender = fakeSender(41);
    const other = fakeSender(42);
    windowForSender.set(sender.id, { id: 1 });
    utilsMock.ctx = { webContentsId: sender.id, event: { sender } };

    await utilsMock.registered.get(CHANNEL)!();

    expect(isViewHydrated(sender.id)).toBe(true);
    expect(isViewHydrated(other.id)).toBe(false);
    expect(windowPvm.signalViewHydrated).toHaveBeenCalledWith(sender.id);
    expect(globalPvm.signalViewHydrated).not.toHaveBeenCalled();
  });

  it("latches nothing for a view attached over a link", async () => {
    utilsMock.ctx = { webContentsId: 43, event: null };

    await utilsMock.registered.get(CHANNEL)!();

    expect(isViewHydrated(43)).toBe(false);
    expect(windowPvm.signalViewHydrated).not.toHaveBeenCalled();
    expect(globalPvm.signalViewHydrated).not.toHaveBeenCalled();
  });
});
