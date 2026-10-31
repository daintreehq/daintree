import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

interface FakeWindow {
  id: number;
  focused: boolean;
  destroyed: boolean;
  isDestroyed: () => boolean;
  isFocused: () => boolean;
}

interface FakeView extends EventEmitter {
  id: number;
  destroyed: boolean;
  crashed: boolean;
  isDestroyed: () => boolean;
  isCrashed: () => boolean;
  send: Mock<(...args: unknown[]) => void>;
}

const state = vi.hoisted(() => ({
  shown: [] as unknown[],
  all: [] as unknown[],
  cached: new Set<number>(),
  windowOf: new Map<number, unknown>(),
  focusOrder: [] as unknown[],
  hasRegistry: true,
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: class {},
}));

vi.mock("../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn((wc: { id: number }) => state.windowOf.get(wc.id) ?? null),
  getProjectForWebContents: vi.fn(() => null),
  getAppWebContents: vi.fn(),
  getShownAppWebContents: vi.fn(() => state.shown),
  getAllAppWebContents: vi.fn(() => state.all),
  getWebContentsForProject: vi.fn(() => []),
  hasRegisteredProjectViews: vi.fn(() => false),
  getRegisteredProjectViews: vi.fn(() => []),
  isCachedViewWebContents: vi.fn((id: number) => state.cached.has(id)),
}));

vi.mock("../../window/windowRef.js", () => ({
  getWindowRegistry: vi.fn(() =>
    state.hasRegistry
      ? {
          focusOrder: () =>
            (state.focusOrder as FakeWindow[]).map((browserWindow) => ({ browserWindow })),
        }
      : null
  ),
  getProjectViewManager: vi.fn(() => null),
}));

import { sendToOneVisibleRenderer, setRemoteBoundViewFilter } from "../utils.js";
import { markViewHydrated, _resetViewHydrationForTesting } from "../../window/viewHydration.js";
import { getEndpointRegistry, _resetEndpointRegistryForTesting } from "../endpointRegistry.js";
import type { ClientEndpoint, HostFrame } from "../endpoint.js";

let nextId = 1;

function makeWindow(focused = false): FakeWindow {
  const win: FakeWindow = {
    id: nextId++,
    focused,
    destroyed: false,
    isDestroyed: () => win.destroyed,
    isFocused: () => win.focused,
  };
  return win;
}

function makeView(win: FakeWindow | null, opts: { hydrated?: boolean } = {}): FakeView {
  const view = Object.assign(new EventEmitter(), {
    id: nextId++,
    destroyed: false,
    crashed: false,
    send: vi.fn<(...args: unknown[]) => void>(),
  }) as FakeView;
  view.isDestroyed = () => view.destroyed;
  view.isCrashed = () => view.crashed;
  if (win) state.windowOf.set(view.id, win);
  if (opts.hydrated !== false) markViewHydrated(view as never);
  return view;
}

/** A window with its shown view, registered in focus history order of creation. */
function openWindow(opts: { focused?: boolean; hydrated?: boolean } = {}) {
  const win = makeWindow(opts.focused ?? false);
  const view = makeView(win, { hydrated: opts.hydrated });
  state.shown.push(view);
  state.all.push(view);
  state.focusOrder.push(win);
  return { win, view };
}

function closeWindow(entry: { win: FakeWindow; view: FakeView }) {
  entry.win.destroyed = true;
  entry.view.destroyed = true;
  entry.view.emit("destroyed");
  state.shown = state.shown.filter((v) => v !== entry.view);
  state.all = state.all.filter((v) => v !== entry.view);
  state.focusOrder = state.focusOrder.filter((w) => w !== entry.win);
}

function remoteEndpoint(handle: number): ClientEndpoint & { send: Mock<(f: HostFrame) => void> } {
  return {
    endpointId: `remote-view:${handle}`,
    clientId: "client-b",
    projectId: null,
    kind: "remote-view",
    handle,
    send: vi.fn<(frame: HostFrame) => void>(),
    request: vi.fn(),
    onClose: () => ({ dispose: () => undefined }),
    isClosed: () => false,
  };
}

function sendCount(...views: FakeView[]): number {
  return views.reduce((n, v) => n + v.send.mock.calls.length, 0);
}

// Each test uses its own channel so the sticky target never leaks between tests.
let channelSeq = 0;
let channel = "";

beforeEach(() => {
  state.shown = [];
  state.all = [];
  state.cached.clear();
  state.windowOf.clear();
  state.focusOrder = [];
  state.hasRegistry = true;
  _resetViewHydrationForTesting();
  _resetEndpointRegistryForTesting();
  channel = `sound:trigger-${++channelSeq}`;
});

describe("sendToOneVisibleRenderer", () => {
  it("delivers to exactly one renderer with several windows open — the focused one", () => {
    const a = openWindow();
    const b = openWindow({ focused: true });
    const c = openWindow();

    expect(sendToOneVisibleRenderer(channel, { soundFile: "waiting.wav" })).toBe(true);

    expect(sendCount(a.view, b.view, c.view)).toBe(1);
    expect(b.view.send).toHaveBeenCalledWith(channel, { soundFile: "waiting.wav" });
  });

  it("still delivers when no window has focus, to the most recently focused one", () => {
    const older = openWindow();
    const recent = openWindow();
    state.focusOrder = [recent.win, older.win];

    sendToOneVisibleRenderer(channel, 1);

    expect(recent.view.send).toHaveBeenCalledTimes(1);
    expect(older.view.send).not.toHaveBeenCalled();
  });

  it("keeps the renderer that took the last push when focus moves to another window", () => {
    const a = openWindow({ focused: true });
    const b = openWindow();

    sendToOneVisibleRenderer(channel, 1);
    a.win.focused = false;
    b.win.focused = true;
    state.focusOrder = [b.win, a.win];
    sendToOneVisibleRenderer(channel, 2);
    sendToOneVisibleRenderer(channel, 3);

    expect(a.view.send.mock.calls).toEqual([
      [channel, 1],
      [channel, 2],
      [channel, 3],
    ]);
    expect(b.view.send).not.toHaveBeenCalled();
  });

  it("moves to another window when the one that played the last sound closes", () => {
    const a = openWindow({ focused: true });
    const b = openWindow();

    sendToOneVisibleRenderer(channel, 1);
    closeWindow(a);
    sendToOneVisibleRenderer(channel, 2);

    expect(a.view.send.mock.calls).toEqual([[channel, 1]]);
    expect(b.view.send.mock.calls).toEqual([[channel, 2]]);
  });

  it("drops the sticky target once its view is cached by a project switch", () => {
    const a = openWindow({ focused: true });
    const b = openWindow();
    sendToOneVisibleRenderer(channel, 1);

    // Window A switches project: its old view is cached, a new one is shown.
    state.cached.add(a.view.id);
    state.shown = state.shown.filter((v) => v !== a.view);
    const a2 = makeView(a.win);
    state.shown.unshift(a2);
    sendToOneVisibleRenderer(channel, 2);

    expect(a.view.send.mock.calls).toEqual([[channel, 1]]);
    expect(a2.send.mock.calls).toEqual([[channel, 2]]);
    expect(b.view.send).not.toHaveBeenCalled();
  });

  it("prefers a hydrated view over the focused one that is still booting", () => {
    const booting = openWindow({ focused: true, hydrated: false });
    const ready = openWindow();

    sendToOneVisibleRenderer(channel, 1);
    expect(ready.view.send).toHaveBeenCalledTimes(1);
    expect(booting.view.send).not.toHaveBeenCalled();

    // Once the booting view hydrates, the sticky ready view still keeps it.
    markViewHydrated(booting.view as never);
    sendToOneVisibleRenderer(channel, 2);
    expect(ready.view.send).toHaveBeenCalledTimes(2);
    expect(booting.view.send).not.toHaveBeenCalled();
  });

  it("does not let an unhydrated sticky target outrank a hydrated view", () => {
    const only = openWindow({ focused: true, hydrated: false });
    sendToOneVisibleRenderer(channel, 1);
    expect(only.view.send).toHaveBeenCalledTimes(1);

    const ready = openWindow();
    sendToOneVisibleRenderer(channel, 2);
    expect(ready.view.send.mock.calls).toEqual([[channel, 2]]);
    expect(only.view.send).toHaveBeenCalledTimes(1);
  });

  it("falls back to an unhydrated view rather than dropping the push", () => {
    const a = openWindow({ hydrated: false });
    const b = openWindow({ focused: true, hydrated: false });

    sendToOneVisibleRenderer(channel, 1);

    expect(sendCount(a.view, b.view)).toBe(1);
    expect(b.view.send).toHaveBeenCalledTimes(1);
  });

  it("forgets hydration when the view's document is replaced", () => {
    const reloaded = openWindow({ focused: true });
    const other = openWindow();

    reloaded.view.emit("did-navigate");
    sendToOneVisibleRenderer(channel, 1);

    expect(other.view.send).toHaveBeenCalledTimes(1);
    expect(reloaded.view.send).not.toHaveBeenCalled();
  });

  it("never picks a cached, crashed or withheld view", () => {
    const cached = openWindow({ focused: true });
    state.cached.add(cached.view.id);
    const crashed = openWindow();
    crashed.view.crashed = true;
    const withheld = openWindow();
    const ok = openWindow();
    const uninstall = setRemoteBoundViewFilter((id) => id !== withheld.view.id);

    sendToOneVisibleRenderer(channel, 1);
    uninstall();

    expect(sendCount(cached.view, crashed.view, withheld.view)).toBe(0);
    expect(ok.view.send).toHaveBeenCalledTimes(1);
  });

  it("falls through to the next renderer when a send throws, and sticks to that one", () => {
    const a = openWindow({ focused: true });
    const b = openWindow();
    a.view.send.mockImplementation(() => {
      throw new Error("disposed");
    });

    expect(sendToOneVisibleRenderer(channel, 1)).toBe(true);
    a.view.send.mockReset();
    sendToOneVisibleRenderer(channel, 2);

    expect(b.view.send.mock.calls).toEqual([
      [channel, 1],
      [channel, 2],
    ]);
    expect(a.view.send).not.toHaveBeenCalled();
  });

  it("uses one uncached renderer when no window has a registered shown view", () => {
    state.hasRegistry = false;
    const cached = makeView(null);
    const first = makeView(null);
    const second = makeView(null);
    state.cached.add(cached.id);
    state.all = [cached, first, second];

    sendToOneVisibleRenderer(channel, 1);

    expect(sendCount(cached, first, second)).toBe(1);
    expect(cached.send).not.toHaveBeenCalled();
  });

  it("keeps sticky targets separate per channel", () => {
    const a = openWindow({ focused: true });
    const b = openWindow();
    sendToOneVisibleRenderer(channel, 1);

    a.win.focused = false;
    b.win.focused = true;
    const otherChannel = `${channel}-other`;
    sendToOneVisibleRenderer(otherChannel, 2);

    expect(b.view.send.mock.calls).toEqual([[otherChannel, 2]]);
  });

  it("sends to every remote endpoint alongside the one local renderer", () => {
    const a = openWindow({ focused: true });
    const b = openWindow();
    const r1 = remoteEndpoint(101);
    const r2 = remoteEndpoint(102);
    getEndpointRegistry().add(r1);
    getEndpointRegistry().add(r2);

    sendToOneVisibleRenderer(channel, { soundFile: "ping.wav" });

    expect(sendCount(a.view, b.view)).toBe(1);
    const frame = { type: "event", channel, args: [{ soundFile: "ping.wav" }] };
    expect(r1.send).toHaveBeenCalledWith(frame);
    expect(r2.send).toHaveBeenCalledWith(frame);
  });

  it("returns false with no eligible local renderer, but still reaches remote endpoints", () => {
    const cached = openWindow({ focused: true });
    state.cached.add(cached.view.id);
    const remote = remoteEndpoint(201);
    getEndpointRegistry().add(remote);

    expect(sendToOneVisibleRenderer(channel, 1)).toBe(false);

    expect(cached.view.send).not.toHaveBeenCalled();
    expect(remote.send).toHaveBeenCalledTimes(1);
  });
});
