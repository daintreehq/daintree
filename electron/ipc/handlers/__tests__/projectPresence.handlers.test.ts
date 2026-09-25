import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

// `buildIpcContext` resolves the sender's window through the registry.
const registryMock = vi.hoisted(() => ({
  getProjectForWebContents: vi.fn<(id: number) => string | null>(() => null),
  getWindowForWebContents: vi.fn<() => { id: number } | null>(() => null),
}));

const broadcastMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));
vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../window/webContentsRegistry.js")>();
  return { ...actual, ...registryMock };
});
vi.mock("../../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils.js")>();
  return { ...actual, broadcastToRenderer: broadcastMock };
});

import { CHANNELS } from "../../channels.js";
import {
  PROJECT_PRESENCE_BROADCAST_DELAY_MS,
  registerProjectPresenceHandlers,
} from "../projectPresence.js";
import { notifyProjectPresenceChanged } from "../../../window/projectPresenceChanges.js";
import type { HandlerDependencies } from "../../types.js";
import type { WindowContext, WindowRegistry } from "../../../window/WindowRegistry.js";
import type { ProjectPresenceSnapshot } from "../../../../shared/types/ipc/projectPresence.js";

function makeContext(
  windowId: number,
  active: string | null,
  cached: string[] = []
): WindowContext {
  const views = [active, ...cached]
    .filter((id): id is string => id !== null)
    .map((projectId) => ({ projectId, view: { webContents: { isDestroyed: () => false } } }));
  return {
    windowId,
    browserWindow: { isDestroyed: () => false },
    services: {
      projectViewManager: {
        getActiveProjectId: () => active,
        getAllViews: () => views,
      },
    },
  } as unknown as WindowContext;
}

function registryOf(contexts: WindowContext[]): WindowRegistry {
  return {
    all: () => contexts,
    getByWindowId: (id: number) => contexts.find((c) => c.windowId === id),
  } as unknown as WindowRegistry;
}

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getSnapshot(): Promise<ProjectPresenceSnapshot> {
  const fn = ipcHandlers.get("project-presence:get-snapshot");
  if (!fn) throw new Error("project-presence:get-snapshot not registered");
  const event = {
    sender: { id: 7 },
    senderFrame: { routingId: 1 },
  } as unknown as Electron.IpcMainInvokeEvent;
  return (fn as Handler)(event) as Promise<ProjectPresenceSnapshot>;
}

let cleanup: (() => void) | null = null;

function register(contexts: WindowContext[]): void {
  cleanup = registerProjectPresenceHandlers({
    windowRegistry: registryOf(contexts),
  } as HandlerDependencies);
}

beforeEach(() => {
  ipcHandlers.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.useRealTimers();
});

describe("project-presence:get-snapshot", () => {
  it("answers relative to the window that asked", async () => {
    registryMock.getWindowForWebContents.mockReturnValue({ id: 1 });
    register([makeContext(1, "a", ["b"]), makeContext(2, "c")]);

    const snapshot = await getSnapshot();

    expect(snapshot.thisWindow.map((e) => e.projectId)).toEqual(["a", "b"]);
    expect(snapshot.otherWindows).toEqual([{ projectId: "c", windowId: 2, state: "foreground" }]);
  });

  it("answers empty for a sender it can't place in a window, rather than guessing one", async () => {
    registryMock.getWindowForWebContents.mockReturnValue(null);
    register([makeContext(1, "a"), makeContext(2, "c")]);

    await expect(getSnapshot()).resolves.toEqual({ thisWindow: [], otherWindows: [] });
  });
});

describe("project-presence:changed", () => {
  it("coalesces a burst of changes into one payload-free broadcast", () => {
    vi.useFakeTimers();
    register([]);

    notifyProjectPresenceChanged();
    notifyProjectPresenceChanged();
    notifyProjectPresenceChanged();
    expect(broadcastMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(PROJECT_PRESENCE_BROADCAST_DELAY_MS);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith(CHANNELS.PROJECT_PRESENCE_CHANGED);
  });

  it("holds from the first change rather than restarting on each one", () => {
    vi.useFakeTimers();
    register([]);

    notifyProjectPresenceChanged();
    vi.advanceTimersByTime(PROJECT_PRESENCE_BROADCAST_DELAY_MS - 1);
    notifyProjectPresenceChanged();
    vi.advanceTimersByTime(1);

    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });

  it("broadcasts again for a change after the last one went out", () => {
    vi.useFakeTimers();
    register([]);

    notifyProjectPresenceChanged();
    vi.advanceTimersByTime(PROJECT_PRESENCE_BROADCAST_DELAY_MS);
    notifyProjectPresenceChanged();
    vi.advanceTimersByTime(PROJECT_PRESENCE_BROADCAST_DELAY_MS);

    expect(broadcastMock).toHaveBeenCalledTimes(2);
  });

  it("sends nothing after cleanup, including a broadcast already pending", () => {
    vi.useFakeTimers();
    register([]);

    notifyProjectPresenceChanged();
    cleanup?.();
    cleanup = null;
    vi.advanceTimersByTime(PROJECT_PRESENCE_BROADCAST_DELAY_MS);
    notifyProjectPresenceChanged();
    vi.advanceTimersByTime(PROJECT_PRESENCE_BROADCAST_DELAY_MS);

    expect(broadcastMock).not.toHaveBeenCalled();
    expect(ipcHandlers.has("project-presence:get-snapshot")).toBe(false);
  });
});
