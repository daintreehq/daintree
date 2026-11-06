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
  /** Window id → the webContents id of the outgoing view its cold switch holds. */
  bridgeOf: new Map<number, number>(),
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
          getByWindowId: (windowId: number) => ({
            services: {
              projectViewManager: {
                getOutgoingBridgeProjectId: () => {
                  const wcId = state.bridgeOf.get(windowId);
                  return wcId === undefined ? null : `project-of-${wcId}`;
                },
                getProjectIdForWebContents: (wcId: number) => `project-of-${wcId}`,
              },
            },
          }),
        }
      : null
  ),
  getProjectViewManager: vi.fn(() => null),
}));

import { sendToOneVisibleRenderer, setRemoteBoundViewFilter } from "../utils.js";
import { markViewHydrated, _resetViewHydrationForTesting } from "../../window/viewHydration.js";
import { getEndpointRegistry, _resetEndpointRegistryForTesting } from "../endpointRegistry.js";
import type { ClientEndpoint, EndpointGroup, HostFrame } from "../endpoint.js";

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

/**
 * Cold switch: the window now points at an incoming view that hasn't loaded,
 * and holds the outgoing one on screen — hydrated, uncached, still registered.
 */
function coldSwitch(entry: { win: FakeWindow; view: FakeView }): FakeView {
  const incoming = makeView(entry.win, { hydrated: false });
  state.shown = state.shown.map((v) => (v === entry.view ? incoming : v));
  state.all.push(incoming);
  state.bridgeOf.set(entry.win.id, entry.view.id);
  return incoming;
}

/** A background restore: registered and uncached, but never a window's shown view. */
function backgroundRestore(win: FakeWindow): FakeView {
  const view = makeView(win);
  state.all.push(view);
  return view;
}

function remoteEndpoint(
  handle: number,
  group?: EndpointGroup
): ClientEndpoint & { send: Mock<(f: HostFrame) => void> } {
  return {
    ...(group ? { group } : {}),
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
  state.bridgeOf.clear();
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

  it("sends once to each remote Shell's session, whatever its view count (#15902)", () => {
    const a = openWindow({ focused: true });
    const studio = { sendToAll: vi.fn<(frame: HostFrame) => void>() };
    const laptop = { sendToAll: vi.fn<(frame: HostFrame) => void>() };
    const views = [
      remoteEndpoint(301, studio),
      remoteEndpoint(302, studio),
      remoteEndpoint(303, laptop),
    ];
    const loose = remoteEndpoint(304);
    for (const endpoint of [...views, loose]) getEndpointRegistry().add(endpoint);

    expect(sendToOneVisibleRenderer(channel, 1)).toBe(true);

    const frame = { type: "event", channel, args: [1] };
    expect(a.view.send.mock.calls).toEqual([[channel, 1]]);
    expect(studio.sendToAll.mock.calls).toEqual([[frame]]);
    expect(laptop.sendToAll.mock.calls).toEqual([[frame]]);
    expect(loose.send.mock.calls).toEqual([[frame]]);
    for (const view of views) expect(view.send).not.toHaveBeenCalled();
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
  it("keeps playing in the outgoing view while a cold switch's incoming view loads", () => {
    const a = openWindow({ focused: true });
    const incoming = coldSwitch(a);

    sendToOneVisibleRenderer(channel, 1);

    expect(a.view.send.mock.calls).toEqual([[channel, 1]]);
    expect(incoming.send).not.toHaveBeenCalled();
  });

  it("prefers another window's shown view over a view on its way out", () => {
    const a = openWindow({ focused: true });
    const b = openWindow();
    sendToOneVisibleRenderer(channel, 1);
    expect(a.view.send).toHaveBeenCalledTimes(1);

    const incoming = coldSwitch(a);
    sendToOneVisibleRenderer(channel, 2);

    expect(b.view.send.mock.calls).toEqual([[channel, 2]]);
    expect(sendCount(a.view, incoming)).toBe(1);
  });

  it("skips a destroyed view still listed ahead of a live one", () => {
    const dead = openWindow({ focused: true, hydrated: false });
    const live = openWindow({ hydrated: false });
    // Electron throws reading a destroyed webContents' properties.
    const deadId = dead.view.id;
    Object.defineProperty(dead.view, "id", {
      get: () => {
        if (dead.view.destroyed) throw new Error("Object has been destroyed");
        return deadId;
      },
    });
    dead.view.destroyed = true;

    expect(sendToOneVisibleRenderer(channel, 1)).toBe(true);

    expect(dead.view.send).not.toHaveBeenCalled();
    expect(live.view.send).toHaveBeenCalledTimes(1);
  });

  it("forgets the sticky target when no renderer takes the push", () => {
    const a = openWindow({ focused: true });
    const b = openWindow();
    sendToOneVisibleRenderer(channel, 1);
    expect(a.view.send).toHaveBeenCalledTimes(1);

    const fail = () => {
      throw new Error("disposed");
    };
    a.view.send.mockImplementation(fail);
    b.view.send.mockImplementation(fail);
    const remote = remoteEndpoint(301);
    getEndpointRegistry().add(remote);
    expect(sendToOneVisibleRenderer(channel, 2)).toBe(false);
    expect(remote.send).toHaveBeenCalledTimes(1);

    a.view.send.mockReset();
    b.view.send.mockReset();
    a.win.focused = false;
    b.win.focused = true;
    sendToOneVisibleRenderer(channel, 3);

    expect(b.view.send.mock.calls).toEqual([[channel, 3]]);
    expect(a.view.send).not.toHaveBeenCalled();
  });
  it("never picks a background restore, even hydrated, over a booting shown view", () => {
    const a = openWindow({ focused: true, hydrated: false });
    const restoring = backgroundRestore(a.win);

    sendToOneVisibleRenderer(channel, 1);

    expect(a.view.send).toHaveBeenCalledTimes(1);
    expect(restoring.send).not.toHaveBeenCalled();
  });

  it("prefers a cold switch's outgoing view over a background restore in the focused window", () => {
    const a = openWindow({ focused: true });
    const incoming = coldSwitch(a);
    const restoring = backgroundRestore(a.win);
    // Listed ahead of the outgoing view, so only the bridge rule keeps it out.
    state.all = [restoring, ...state.all.filter((v) => v !== restoring)];

    sendToOneVisibleRenderer(channel, 1);

    expect(a.view.send).toHaveBeenCalledTimes(1);
    expect(sendCount(incoming, restoring)).toBe(0);
  });
  it("leaves a background restore out when the only shown view has crashed", () => {
    const a = openWindow({ focused: true });
    a.view.crashed = true;
    const restoring = backgroundRestore(a.win);
    const remote = remoteEndpoint(401);
    getEndpointRegistry().add(remote);

    expect(sendToOneVisibleRenderer(channel, 1)).toBe(false);

    expect(sendCount(a.view, restoring)).toBe(0);
    expect(remote.send).toHaveBeenCalledTimes(1);
  });
});
