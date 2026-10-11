import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      ipcMainMock.handlers.set(channel, handler);
    }),
    removeListener: vi.fn((channel: string) => {
      ipcMainMock.handlers.delete(channel);
    }),
  },
}));
interface FakeWindow {
  id: number;
  focused: boolean;
  isDestroyed: () => boolean;
  isFocused: () => boolean;
  on: (event: string, cb: () => void) => void;
  once: (event: string, cb: () => void) => void;
  removeListener: (event: string, cb: () => void) => void;
  fire: (event: string) => void;
}
function fakeWindow(id: number): FakeWindow {
  const listeners = new Map<string, Set<() => void>>();
  const win: FakeWindow = {
    id,
    focused: true,
    isDestroyed: () => false,
    isFocused: () => win.focused,
    on: (event, cb) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
    },
    once: (event, cb) => win.on(event, cb),
    removeListener: (event, cb) => listeners.get(event)?.delete(cb),
    fire: (event) => {
      for (const cb of [...(listeners.get(event) ?? [])]) cb();
    },
  };
  return win;
}
const registryMock = vi.hoisted(() => ({
  windows: new Map<number, unknown>(),
  projects: new Map<number, string>(),
  cached: new Set<number>(),
  scopeListeners: new Set<() => void>(),
}));
const dispatcherMock = vi.hoisted(() => ({
  sendListeners: new Map<string, (ctx: unknown, ...args: unknown[]) => void>(),
}));
vi.mock("../../dispatcher.js", () => ({
  getIpcDispatcher: () => ({
    registerSend: (channel: string, listener: (ctx: unknown, ...args: unknown[]) => void) => {
      dispatcherMock.sendListeners.set(channel, listener);
      return () => dispatcherMock.sendListeners.delete(channel);
    },
  }),
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn((wc: { id: number }) => registryMock.windows.get(wc.id) ?? null),
  getProjectForWebContents: vi.fn((id: number) => registryMock.projects.get(id) ?? null),
  isCachedViewWebContents: vi.fn((id: number) => registryMock.cached.has(id)),
  onRendererScopeChanged: vi.fn((listener: () => void) => {
    registryMock.scopeListeners.add(listener);
    return () => registryMock.scopeListeners.delete(listener);
  }),
}));

import { CHANNELS } from "../../channels.js";
import { registerPluginFocusedPanelHandlers } from "../pluginFocusedPanel.js";
import { notifyRemoteViewEndpointOpened, setHostSendRelay } from "../../hostSendRelay.js";
import { FocusedPanelTracker } from "../../../services/FocusedPanelTracker.js";

type Listener = () => void;

function sender(id: number) {
  const listeners = new Map<string, Listener>();
  return {
    id,
    isDestroyed: () => false,
    once: vi.fn((event: string, cb: Listener) => listeners.set(event, cb)),
    on: vi.fn((event: string, cb: Listener) => listeners.set(event, cb)),
    fire: (event: string) => listeners.get(event)?.(),
  };
}

describe("plugin:report-focused-panel", () => {
  let tracker: FocusedPanelTracker;
  let cleanup: () => void;
  let win: FakeWindow;

  beforeEach(() => {
    win = fakeWindow(1);
    registryMock.windows.set(7, win);
    registryMock.projects.set(7, "project-a");
    tracker = new FocusedPanelTracker({
      workspaceOf: (id) => registryMock.projects.get(id) ?? null,
    });
    tracker.setFocusedWindow(1);
    cleanup = registerPluginFocusedPanelHandlers(tracker);
  });
  afterEach(() => {
    cleanup();
    registryMock.windows.clear();
    registryMock.projects.clear();
    registryMock.cached.clear();
  });

  const send = (s: ReturnType<typeof sender>, payload: unknown, frame?: unknown) =>
    ipcMainMock.handlers.get(CHANNELS.PLUGIN_REPORT_FOCUSED_PANEL)!(
      { sender: s, senderFrame: frame },
      payload
    );

  it("attributes the report to the sender's window and project, not the payload", () => {
    send(sender(7), { kind: "diff", worktreeId: "w", workspaceId: "project-b" });
    expect(tracker.getCurrent()).toEqual({
      panel: { kind: "diff", agent: false, worktreeId: "w" },
      workspaceId: "project-a",
    });
  });

  it("re-attributes a report made before its view joined a project", () => {
    registryMock.projects.delete(7);
    send(sender(7), { kind: "terminal" });
    expect(tracker.getCurrent().workspaceId).toBeNull();

    registryMock.projects.set(7, "project-a");
    for (const listener of registryMock.scopeListeners) listener();
    expect(tracker.getCurrent().workspaceId).toBe("project-a");
  });

  it("ignores subframes and senders with no window", () => {
    send(sender(7), { kind: "diff" }, { parent: {} });
    send(sender(99), { kind: "browser" });
    expect(tracker.getCurrent().panel.kind).toBeNull();
  });

  it("drops a sender's report when it is destroyed or its renderer crashes", () => {
    const s = sender(7);
    send(s, { kind: "file" });
    s.fire("render-process-gone");
    expect(tracker.getCurrent().panel.kind).toBeNull();

    send(s, { kind: "file" });
    s.fire("destroyed");
    expect(tracker.getCurrent().panel.kind).toBeNull();
    // Listeners are attached once per sender, not once per report.
    expect(s.once).toHaveBeenCalledTimes(1);
  });

  it("stops listening once unregistered", () => {
    cleanup();
    expect(ipcMainMock.handlers.has(CHANNELS.PLUGIN_REPORT_FOCUSED_PANEL)).toBe(false);
    expect(registryMock.scopeListeners.size).toBe(0);
    cleanup = () => {};
  });

  describe("a view bound to a remote host", () => {
    let relayed: Array<{ sender: number; args: unknown[] }>;
    let offRelay: () => void;

    beforeEach(() => {
      relayed = [];
      offRelay = setHostSendRelay((sender, channel, args) => {
        if (sender !== 7) return false;
        expect(channel).toBe(CHANNELS.PLUGIN_REPORT_FOCUSED_PANEL);
        relayed.push({ sender, args });
        return true;
      });
    });
    afterEach(() => offRelay());

    it("goes to its host with this machine's focus, and never to the local tracker", () => {
      send(sender(7), { kind: "terminal", agent: true });
      expect(relayed).toEqual([{ sender: 7, args: [{ kind: "terminal", agent: true }, true] }]);
      expect(tracker.getCurrent().panel.kind).toBeNull();
    });

    it("tells the host when its window or view loses and regains focus", () => {
      const s = sender(7);
      send(s, { kind: "diff" });
      win.focused = false;
      win.fire("blur");
      expect(relayed.at(-1)!.args[1]).toBe(false);
      win.focused = true;
      win.fire("focus");
      expect(relayed.at(-1)!.args[1]).toBe(true);
      registryMock.cached.add(7);
      s.fire("blur");
      expect(relayed.at(-1)!.args[1]).toBe(false);
      // An unchanged answer is not re-sent.
      const count = relayed.length;
      win.fire("blur");
      expect(relayed).toHaveLength(count);
    });

    it("re-sends its last report when its endpoint reattaches, even with nothing changed", () => {
      send(sender(7), { kind: "diff" });
      const count = relayed.length;
      notifyRemoteViewEndpointOpened(7);
      expect(relayed).toHaveLength(count + 1);
      expect(relayed.at(-1)).toEqual({ sender: 7, args: [{ kind: "diff" }, true] });
      notifyRemoteViewEndpointOpened(99);
      expect(relayed).toHaveLength(count + 1);
    });

    it("clears its host's report when the renderer crashes, until it reports again", () => {
      const s = sender(7);
      send(s, { kind: "terminal" });
      s.fire("render-process-gone");
      expect(relayed.at(-1)).toEqual({ sender: 7, args: [null, false] });
      // Re-sent on the next endpoint, in case the link was down for the first.
      notifyRemoteViewEndpointOpened(7);
      expect(relayed.at(-1)).toEqual({ sender: 7, args: [null, false] });
      // A reloaded page that reports again is relayed as usual from then on.
      send(s, { kind: "diff" });
      notifyRemoteViewEndpointOpened(7);
      expect(relayed.at(-1)).toEqual({ sender: 7, args: [{ kind: "diff" }, true] });
    });

    it("falls back to the local tracker once the view is no longer bound", () => {
      send(sender(8), { kind: "file" });
      registryMock.windows.set(8, win);
      send(sender(8), { kind: "file" });
      expect(tracker.getCurrent().panel.kind).toBe("file");
    });
  });

  describe("on the host, a remote view's relay", () => {
    function endpoint(handle: number, projectId: string | null) {
      const closers: Array<() => void> = [];
      return {
        kind: "remote-view" as const,
        handle,
        projectId,
        isClosed: () => false,
        onClose: (cb: () => void) => {
          closers.push(cb);
          return { dispose: () => {} };
        },
        close: () => closers.forEach((cb) => cb()),
      };
    }
    const relay = (ep: ReturnType<typeof endpoint>, payload: unknown, focused: unknown) =>
      dispatcherMock.sendListeners.get(CHANNELS.PLUGIN_REPORT_FOCUSED_PANEL)!(
        { endpoint: ep },
        payload,
        focused
      );

    it("counts while its Shell says it is focused, attributed to the endpoint's project", () => {
      const ep = endpoint(-3, "project-r");
      relay(ep, { kind: "terminal", workspaceId: "spoofed" }, true);
      expect(tracker.getCurrent()).toEqual({
        panel: { kind: "terminal", agent: false, worktreeId: null },
        workspaceId: "project-r",
      });
      relay(ep, { kind: "terminal" }, false);
      expect(tracker.getCurrent().panel.kind).toBeNull();
    });

    it("yields to this machine's screen once a local view acts, and is forgotten on close", () => {
      const ep = endpoint(-3, "project-r");
      relay(ep, { kind: "terminal" }, true);
      send(sender(7), { kind: "diff" });
      expect(tracker.getCurrent().workspaceId).toBe("project-a");
      relay(ep, { kind: "browser" }, true);
      expect(tracker.getCurrent().panel.kind).toBe("browser");
      ep.close();
      expect(tracker.getCurrent().panel.kind).toBe("diff");
    });

    it("ignores a local endpoint on the link path", () => {
      dispatcherMock.sendListeners.get(CHANNELS.PLUGIN_REPORT_FOCUSED_PANEL)!(
        { endpoint: { kind: "local-view", handle: 7 } },
        { kind: "terminal" },
        true
      );
      expect(tracker.getCurrent().panel.kind).toBeNull();
    });
  });
});
