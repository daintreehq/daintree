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
const registryMock = vi.hoisted(() => ({
  windows: new Map<number, { id: number; isDestroyed: () => boolean }>(),
  projects: new Map<number, string>(),
  scopeListeners: new Set<() => void>(),
}));
vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn((wc: { id: number }) => registryMock.windows.get(wc.id) ?? null),
  getProjectForWebContents: vi.fn((id: number) => registryMock.projects.get(id) ?? null),
  onRendererScopeChanged: vi.fn((listener: () => void) => {
    registryMock.scopeListeners.add(listener);
    return () => registryMock.scopeListeners.delete(listener);
  }),
}));

import { CHANNELS } from "../../channels.js";
import { registerPluginFocusedPanelHandlers } from "../pluginFocusedPanel.js";
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

  beforeEach(() => {
    registryMock.windows.set(7, { id: 1, isDestroyed: () => false });
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
});
