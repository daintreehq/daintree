import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const existingProjectIds = vi.hoisted(() => new Set<string>());
const existingScratchIds = vi.hoisted(() => new Set<string>());
const projectStoreMock = vi.hoisted(() => ({
  getProjectById: vi.fn((id: string) => (existingProjectIds.has(id) ? { id } : undefined)),
  getCurrentProjectId: vi.fn<() => string | null>(() => null),
}));
const scratchStoreMock = vi.hoisted(() => ({
  getScratchById: vi.fn((id: string) => (existingScratchIds.has(id) ? { id } : null)),
}));

const scopedProjectMock = vi.hoisted(() =>
  vi.fn<() => { project: { id: string } | null; workspaceId: string | null } | null>(() => null)
);

// `buildIpcContext` reads the sender's raw view binding and its window from the
// registry. Overridden rather than replaced so nothing else in the module graph
// loses an export it imports.
const registryMock = vi.hoisted(() => ({
  getProjectForWebContents: vi.fn<(id: number) => string | null>(() => null),
  getWindowForWebContents: vi.fn<() => { id: number } | null>(() => null),
}));

// `buildIpcContext` resolves the sender's window through `BrowserWindow`; left
// unmocked it throws before the handler runs.
vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));
vi.mock("../../../services/ScratchStore.js", () => ({ scratchStore: scratchStoreMock }));
vi.mock("../../projectContext.js", () => ({
  resolveScopedProjectForIpcContext: scopedProjectMock,
}));
vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../window/webContentsRegistry.js")>();
  return { ...actual, ...registryMock };
});

import { registerProjectHistoryHandlers } from "../projectHistory.js";
import {
  getProjectHistory,
  disposeProjectHistory,
  resetProjectHistory,
} from "../../../services/ProjectHistoryService.js";
import type { HandlerDependencies } from "../../types.js";

const WINDOW_ID = 41;

// Real id shapes, because the handler routes existence checks on them: a
// scratch is a UUIDv4 and a project is 64 hex characters, and the two spaces
// are disjoint by construction.
const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const PROJECT_OLDER = "c".repeat(64);
const SCRATCH_ONE = "11111111-1111-4111-8111-111111111111";
const SCRATCH_TWO = "22222222-2222-4222-9222-222222222222";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function peek(): Promise<{ workspaceId: string } | null> {
  const fn = ipcHandlers.get("project-history:peek");
  if (!fn) throw new Error("project-history:peek not registered");
  const event = {
    sender: { id: 7 },
    senderFrame: { routingId: 1 },
  } as unknown as Electron.IpcMainInvokeEvent;
  return (fn as Handler)(event) as Promise<{ workspaceId: string } | null>;
}

/** Put the window in a project, the way a committed switch would. */
function inProject(id: string): void {
  existingProjectIds.add(id);
  scopedProjectMock.mockReturnValue({ project: { id }, workspaceId: id });
}

/**
 * Put the window in a scratch: a live workspace with no project row, which is
 * exactly the case `project` alone cannot describe.
 */
function inScratch(id: string): void {
  existingScratchIds.add(id);
  scopedProjectMock.mockReturnValue({ project: null, workspaceId: id });
}

/** A sender whose view has no workspace binding to resolve at all. */
function unbound(): void {
  scopedProjectMock.mockReturnValue({ project: null, workspaceId: null });
}

/**
 * A sender still displaying a project the scoped resolver refuses to name. It
 * blanks a closed row so hydration cannot resurrect a workspace the user closed
 * — but the view is on screen, and only the raw binding still says where.
 */
function inClosedProject(id: string): void {
  existingProjectIds.add(id);
  scopedProjectMock.mockReturnValue({ project: null, workspaceId: null });
  registryMock.getProjectForWebContents.mockReturnValue(id);
}

describe("projectHistory IPC", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    existingProjectIds.clear();
    existingScratchIds.clear();
    // Reset, not dispose: disposing tombstones the id, and the tombstone is
    // exactly what stops a closed window's history from recording again.
    resetProjectHistory(WINDOW_ID);
    projectStoreMock.getProjectById.mockImplementation((id: string) =>
      existingProjectIds.has(id) ? { id } : undefined
    );
    scratchStoreMock.getScratchById.mockImplementation((id: string) =>
      existingScratchIds.has(id) ? { id } : null
    );
    projectStoreMock.getCurrentProjectId.mockReturnValue(null);
    // `clearAllMocks` clears calls, not queued return values.
    registryMock.getProjectForWebContents.mockReturnValue(null);
    registryMock.getWindowForWebContents.mockReturnValue(null);

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
    inProject(PROJECT_A);

    // Seeding must not invent a destination out of the project already showing.
    await expect(peek()).resolves.toBeNull();
  });

  it("answers with the project behind the one on screen", async () => {
    existingProjectIds.add(PROJECT_A);
    inProject(PROJECT_B);
    getProjectHistory(WINDOW_ID).record(PROJECT_A);

    await expect(peek()).resolves.toEqual({ workspaceId: PROJECT_A });
  });

  it("seeds from the window's own project rather than the global pointer", async () => {
    // A second window asking while a different window is the globally-current
    // one. The history already holds this window's own switch (a → b), so
    // seeding the global pointer instead would push "other" onto the head and
    // hand back "b" — the project the window is looking at right now.
    const otherProjectId = "d".repeat(64);
    existingProjectIds.add(PROJECT_A);
    existingProjectIds.add(otherProjectId);
    inProject(PROJECT_B);
    projectStoreMock.getCurrentProjectId.mockReturnValue(otherProjectId);
    const history = getProjectHistory(WINDOW_ID);
    history.record(PROJECT_A);
    history.record(PROJECT_B);

    await expect(peek()).resolves.toEqual({ workspaceId: PROJECT_A });
  });

  it("steps behind the scratch the window is in rather than treating it as nowhere", async () => {
    existingProjectIds.add(PROJECT_A);
    const history = getProjectHistory(WINDOW_ID);
    history.record(PROJECT_A);
    history.record(SCRATCH_ONE);
    inScratch(SCRATCH_ONE);

    await expect(peek()).resolves.toEqual({ workspaceId: PROJECT_A });
  });

  it("returns to the scratch left behind when the window is in a project", async () => {
    // The bug this whole change exists for: the scratch is the entry directly
    // behind the project, and a project-only existence check pruned it away
    // before the toggle ever saw it.
    existingScratchIds.add(SCRATCH_ONE);
    inProject(PROJECT_A);
    const history = getProjectHistory(WINDOW_ID);
    history.record(SCRATCH_ONE);
    history.record(PROJECT_A);

    await expect(peek()).resolves.toEqual({ workspaceId: SCRATCH_ONE });
  });

  it("toggles between two scratches", async () => {
    existingScratchIds.add(SCRATCH_ONE);
    const history = getProjectHistory(WINDOW_ID);
    history.record(SCRATCH_ONE);
    history.record(SCRATCH_TWO);
    inScratch(SCRATCH_TWO);

    await expect(peek()).resolves.toEqual({ workspaceId: SCRATCH_ONE });
  });

  it("seeds a live scratch that some other route left off the head", async () => {
    // Nothing recorded the scratch — an older build, or a route that never
    // reached a writer. Seeding has to put it back at the head, or the entry
    // behind it would be handed out as the destination the window is already in.
    existingProjectIds.add(PROJECT_A);
    getProjectHistory(WINDOW_ID).record(PROJECT_A);
    inScratch(SCRATCH_ONE);

    await expect(peek()).resolves.toEqual({ workspaceId: PROJECT_A });
    expect(getProjectHistory(WINDOW_ID).snapshot().entries).toEqual([SCRATCH_ONE, PROJECT_A]);
  });

  it("falls through to a surviving workspace when the scratch left behind is deleted", async () => {
    existingProjectIds.add(PROJECT_OLDER);
    existingScratchIds.add(SCRATCH_ONE);
    const history = getProjectHistory(WINDOW_ID);
    history.record(PROJECT_OLDER);
    history.record(SCRATCH_ONE);
    inProject(PROJECT_A);
    history.record(PROJECT_A);

    existingScratchIds.delete(SCRATCH_ONE);

    // A deleted scratch has to strand the toggle no more than a deleted project
    // does — the next survivor is promoted into its place.
    await expect(peek()).resolves.toEqual({ workspaceId: PROJECT_OLDER });
  });

  it("falls through to a surviving project when the one left behind is deleted", async () => {
    existingProjectIds.add(PROJECT_OLDER);
    existingProjectIds.add(PROJECT_A);
    const history = getProjectHistory(WINDOW_ID);
    history.record(PROJECT_OLDER);
    history.record(PROJECT_A);
    inScratch(SCRATCH_ONE);
    history.record(SCRATCH_ONE);

    existingProjectIds.delete(PROJECT_A);

    // Without pruning, every press would resolve to the deleted project and
    // silently do nothing while "older" sat right behind it.
    await expect(peek()).resolves.toEqual({ workspaceId: PROJECT_OLDER });
  });

  it("hands an unbound sender the head rather than stepping behind it", async () => {
    // No binding to seed from, so the head is the most recent place the window
    // is known to have been. Stepping behind it here would skip the only entry
    // there is.
    existingProjectIds.add(PROJECT_A);
    getProjectHistory(WINDOW_ID).record(PROJECT_A);
    unbound();

    await expect(peek()).resolves.toEqual({ workspaceId: PROJECT_A });
  });

  it("hands back the entry behind a current workspace that was deleted out from under it", async () => {
    existingProjectIds.add(PROJECT_A);
    existingScratchIds.add(SCRATCH_ONE);
    const history = getProjectHistory(WINDOW_ID);
    history.record(PROJECT_A);
    history.record(SCRATCH_ONE);
    inScratch(SCRATCH_ONE);

    existingScratchIds.delete(SCRATCH_ONE);

    await expect(peek()).resolves.toEqual({ workspaceId: PROJECT_A });
  });

  it("reports nothing rather than a deleted workspace when none survive", async () => {
    existingProjectIds.add(PROJECT_A);
    getProjectHistory(WINDOW_ID).record(PROJECT_A);
    inScratch(SCRATCH_ONE);
    existingProjectIds.delete(PROJECT_A);
    existingScratchIds.delete(SCRATCH_ONE);

    await expect(peek()).resolves.toBeNull();
  });

  it("keeps a closed project's own view from being handed back to itself", async () => {
    // The scoped resolver blanks a closed row, which used to make the window
    // look like it was nowhere — and "nowhere" hands back the head, which is
    // the closed project still on screen. The key then did nothing at all.
    existingProjectIds.add(PROJECT_B);
    const history = getProjectHistory(WINDOW_ID);
    history.record(PROJECT_B);
    history.record(PROJECT_A);
    inClosedProject(PROJECT_A);

    await expect(peek()).resolves.toEqual({ workspaceId: PROJECT_B });
  });

  it("falls back to the global pointer only when there is no view scoping at all", async () => {
    // The legacy single-renderer path: no ProjectViewManager anywhere, so the
    // scoped resolver has nothing to answer with and the global pointer is the
    // only thing that names a workspace.
    existingProjectIds.add(PROJECT_A);
    existingProjectIds.add(PROJECT_B);
    getProjectHistory(WINDOW_ID).record(PROJECT_A);
    scopedProjectMock.mockReturnValue(null);
    projectStoreMock.getCurrentProjectId.mockReturnValue(PROJECT_B);

    await expect(peek()).resolves.toEqual({ workspaceId: PROJECT_A });
  });

  it("reads the sending window's history, not the main window's", async () => {
    // Windows navigate independently. Answering from the main window's list
    // would send a second window back somewhere it has never been.
    const SENDER_WINDOW_ID = 42;
    existingProjectIds.add(PROJECT_A);
    existingProjectIds.add(PROJECT_B);
    resetProjectHistory(SENDER_WINDOW_ID);
    getProjectHistory(WINDOW_ID).record(PROJECT_OLDER);
    getProjectHistory(SENDER_WINDOW_ID).record(PROJECT_A);
    registryMock.getWindowForWebContents.mockReturnValue({ id: SENDER_WINDOW_ID });
    inProject(PROJECT_B);

    await expect(peek()).resolves.toEqual({ workspaceId: PROJECT_A });
    // And the seed landed in the sender's list, leaving the main window's alone.
    expect(getProjectHistory(WINDOW_ID).snapshot().entries).toEqual([PROJECT_OLDER]);
    disposeProjectHistory(SENDER_WINDOW_ID);
  });

  it("resolves each workspace against the store that owns its id shape", async () => {
    existingProjectIds.add(PROJECT_A);
    existingScratchIds.add(SCRATCH_ONE);
    const history = getProjectHistory(WINDOW_ID);
    history.record(PROJECT_A);
    history.record(SCRATCH_ONE);
    inScratch(SCRATCH_ONE);

    await peek();

    // A scratch lookup on a project id would hit the database for an answer it
    // can never find, and asking the project store about a scratch would report
    // a live scratch as deleted.
    expect(scratchStoreMock.getScratchById).not.toHaveBeenCalledWith(PROJECT_A);
    expect(projectStoreMock.getProjectById).not.toHaveBeenCalledWith(SCRATCH_ONE);
  });

  it("looks each workspace up once however many times the request prunes", async () => {
    // A dead entry in the middle makes `prune` take both passes — `every` finds
    // the gap, then `filter` re-tests every entry — which is where a plain
    // predicate would put a second database read behind each survivor.
    existingProjectIds.add(PROJECT_A);
    existingScratchIds.add(SCRATCH_ONE);
    const history = getProjectHistory(WINDOW_ID);
    history.record(PROJECT_A);
    history.record(SCRATCH_TWO);
    history.record(SCRATCH_ONE);
    inScratch(SCRATCH_ONE);

    await expect(peek()).resolves.toEqual({ workspaceId: PROJECT_A });

    const lookups = (id: string) =>
      [
        ...scratchStoreMock.getScratchById.mock.calls,
        ...projectStoreMock.getProjectById.mock.calls,
      ].filter(([called]) => called === id).length;

    // Repeating a lookup would also let a workspace deleted mid-request be
    // present for the seed and absent for the peek.
    expect(lookups(SCRATCH_ONE)).toBe(1);
    expect(lookups(SCRATCH_TWO)).toBe(1);
    expect(lookups(PROJECT_A)).toBe(1);
  });
});
