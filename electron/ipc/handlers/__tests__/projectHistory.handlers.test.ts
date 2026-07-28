import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const existingProjectIds = vi.hoisted(() => new Set<string>());
const projectStoreMock = vi.hoisted(() => ({
  getProjectById: vi.fn((id: string) => (existingProjectIds.has(id) ? { id } : undefined)),
  getCurrentProjectId: vi.fn<() => string | null>(() => null),
}));

const scopedProjectMock = vi.hoisted(() =>
  vi.fn<() => { project: { id: string } | null } | null>(() => null)
);

// `buildIpcContext` resolves the sender's window through `BrowserWindow`; left
// unmocked it throws before the handler runs.
vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));
vi.mock("../../projectContext.js", () => ({
  resolveScopedProjectForIpcContext: scopedProjectMock,
}));

import { registerProjectHistoryHandlers } from "../projectHistory.js";
import {
  getProjectHistory,
  disposeProjectHistory,
  resetProjectHistory,
} from "../../../services/ProjectHistoryService.js";
import type { HandlerDependencies } from "../../types.js";

const WINDOW_ID = 41;

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function peek(): Promise<{ projectId: string } | null> {
  const fn = ipcHandlers.get("project-history:peek");
  if (!fn) throw new Error("project-history:peek not registered");
  const event = {
    sender: { id: 7 },
    senderFrame: { routingId: 1 },
  } as unknown as Electron.IpcMainInvokeEvent;
  return (fn as Handler)(event) as Promise<{ projectId: string } | null>;
}

/** Put the window in a project, the way a committed switch would. */
function inProject(id: string): void {
  existingProjectIds.add(id);
  scopedProjectMock.mockReturnValue({ project: { id } });
}

/** Put the window in a scratch: a live window with no current project. */
function inScratch(): void {
  scopedProjectMock.mockReturnValue({ project: null });
}

describe("projectHistory IPC", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    existingProjectIds.clear();
    // Reset, not dispose: disposing tombstones the id, and the tombstone is
    // exactly what stops a closed window's history from recording again.
    resetProjectHistory(WINDOW_ID);
    projectStoreMock.getProjectById.mockImplementation((id: string) =>
      existingProjectIds.has(id) ? { id } : undefined
    );
    projectStoreMock.getCurrentProjectId.mockReturnValue(null);

    const deps = {
      mainWindow: { id: WINDOW_ID },
    } as unknown as HandlerDependencies;
    cleanup = registerProjectHistoryHandlers(deps);
  });

  afterEach(() => {
    cleanup();
    disposeProjectHistory(WINDOW_ID);
  });

  it("has nowhere to go from a window that has only ever seen one project", async () => {
    inProject("a");

    // Seeding must not invent a destination out of the project already showing.
    await expect(peek()).resolves.toBeNull();
  });

  it("answers with the project behind the one on screen", async () => {
    existingProjectIds.add("a");
    inProject("b");
    getProjectHistory(WINDOW_ID).record("a");

    await expect(peek()).resolves.toEqual({ projectId: "a" });
  });

  it("seeds from the window's own project rather than the global pointer", async () => {
    // A second window asking while a different window is the globally-current
    // one. The history already holds this window's own switch (a → b), so
    // seeding the global pointer instead would push "other" onto the head and
    // hand back "b" — the project the window is looking at right now.
    existingProjectIds.add("a");
    existingProjectIds.add("other");
    inProject("b");
    projectStoreMock.getCurrentProjectId.mockReturnValue("other");
    const history = getProjectHistory(WINDOW_ID);
    history.record("a");
    history.record("b");

    await expect(peek()).resolves.toEqual({ projectId: "a" });
  });

  it("returns to the project left behind when the window is in a scratch", async () => {
    existingProjectIds.add("a");
    getProjectHistory(WINDOW_ID).record("a");
    inScratch();

    // A scratch is not a project, so there is no head to step behind — the head
    // itself is where the user came from.
    await expect(peek()).resolves.toEqual({ projectId: "a" });
  });

  it("falls through to a surviving project when the one left behind is deleted", async () => {
    existingProjectIds.add("older");
    existingProjectIds.add("a");
    const history = getProjectHistory(WINDOW_ID);
    history.record("older");
    history.record("a");
    inScratch();

    existingProjectIds.delete("a");

    // Without pruning the head, every press would resolve to the deleted
    // project and silently do nothing while "older" sat right behind it.
    await expect(peek()).resolves.toEqual({ projectId: "older" });
  });

  it("reports nothing rather than a deleted project when none survive", async () => {
    existingProjectIds.add("a");
    getProjectHistory(WINDOW_ID).record("a");
    inScratch();
    existingProjectIds.delete("a");

    await expect(peek()).resolves.toBeNull();
  });
});
