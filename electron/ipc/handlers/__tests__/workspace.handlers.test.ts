import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";

/**
 * The workspace discovery catalog seam (#12307).
 *
 * The join is what is under test — kind derivation, cross-window live-view
 * detection, ordering and the identity-only projection — so the cross-window
 * registry is the REAL module driven through the real `registerProjectView`,
 * and the namespace is registered through the real `defineIpcNamespace`. Only
 * the two store reads are stubbed, and their purity is covered separately by
 * `ProjectStore.getAllProjectIdentities` in `ProjectStore.test.ts`.
 */

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const webContentsById = vi.hoisted(() => new Map<number, unknown>());

const projectStoreMock = vi.hoisted(() => ({
  getAllProjectIdentities: vi.fn<() => Array<{ id: string; path: string; name: string }>>(() => []),
}));
const scratchStoreMock = vi.hoisted(() => ({
  getAllScratches: vi.fn<() => Array<Record<string, unknown>>>(() => []),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  WebContentsView: vi.fn(),
  webContents: {
    fromId: (id: number) => (webContentsById.get(id) as WebContents | undefined) ?? null,
  },
}));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));
vi.mock("../../../services/ScratchStore.js", () => ({ scratchStore: scratchStoreMock }));

import { registerWorkspaceHandlers } from "../workspace.js";
import {
  registerProjectView,
  unregisterProjectView,
  registerCachedViewWebContents,
  unregisterCachedViewWebContents,
  getRegisteredProjectViews,
} from "../../../window/webContentsRegistry.js";
import type { WorkspaceListEntry } from "../../../../shared/types/ipc/workspace.js";

// Real id shapes: projects are 64 lowercase hex, scratches are UUIDv4, and the
// two spaces are disjoint by construction (`shared/utils/workspaceIds.ts`).
const PROJECT_OPEN = "a".repeat(64);
const PROJECT_CLOSED = "b".repeat(64);
const PROJECT_CACHED = "c".repeat(64);
const SCRATCH_OPEN = "11111111-1111-4111-8111-111111111111";
const SCRATCH_CLOSED = "22222222-2222-4222-9222-222222222222";

type MockWebContents = EventEmitter & { id: number; isDestroyed: () => boolean };

let nextWebContentsId = 1;

function createWebContents(): MockWebContents {
  const wc = new EventEmitter() as MockWebContents;
  wc.id = nextWebContentsId++;
  wc.isDestroyed = () => false;
  webContentsById.set(wc.id, wc);
  return wc;
}

/** Register a live view for a workspace, the way a committed switch would. */
function openView(workspaceId: string): MockWebContents {
  const wc = createWebContents();
  registerProjectView(workspaceId, wc as unknown as WebContents);
  return wc;
}

/**
 * A view that has been DEACTIVATED but still holds a live renderer — what a
 * project backgrounded by a switch in its window looks like. It is the case a
 * foreground-only live check would miss, so the flag has to be built on
 * something that still counts it.
 */
function cacheView(workspaceId: string): MockWebContents {
  const wc = openView(workspaceId);
  registerCachedViewWebContents(wc as unknown as WebContents);
  return wc;
}

function list(): Promise<WorkspaceListEntry[]> {
  const fn = ipcHandlers.get("workspace:list");
  if (!fn) throw new Error("workspace:list not registered");
  const event = { sender: { id: 1 } } as unknown as Electron.IpcMainInvokeEvent;
  return (fn as (e: unknown, ...a: unknown[]) => Promise<WorkspaceListEntry[]>)(event);
}

function project(id: string, name: string, path: string) {
  return { id, path, name };
}

/** A full scratch row, so the projection is proven to drop the extra columns. */
function scratch(id: string, name: string, path: string) {
  return {
    id,
    path,
    name,
    createdAt: 1,
    lastOpened: 2,
    deletedAt: null,
    lastCompletionSeenAt: null,
    resumableAgentCount: null,
  };
}

describe("workspace:list", () => {
  let cleanup: () => void;

  beforeEach(() => {
    // Drain the module-level registry between tests — it is real state that
    // would otherwise leak live views from one case into the next.
    for (const { webContents } of getRegisteredProjectViews()) {
      unregisterCachedViewWebContents(webContents.id);
      unregisterProjectView(webContents.id);
    }
    webContentsById.clear();
    ipcHandlers.clear();
    nextWebContentsId = 1;
    projectStoreMock.getAllProjectIdentities.mockReset().mockReturnValue([]);
    scratchStoreMock.getAllScratches.mockReset().mockReturnValue([]);
    cleanup = registerWorkspaceHandlers();
  });

  it("lists every known workspace, open or not, with identity fields only", async () => {
    projectStoreMock.getAllProjectIdentities.mockReturnValue([
      project(PROJECT_OPEN, "Open", "/repos/open"),
      project(PROJECT_CLOSED, "Closed", "/repos/closed"),
    ]);
    scratchStoreMock.getAllScratches.mockReturnValue([
      scratch(SCRATCH_CLOSED, "Scratch", "/scratches/one"),
    ]);
    openView(PROJECT_OPEN);

    const entries = await list();

    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual([
        "hasLiveView",
        "kind",
        "name",
        "path",
        "workspaceId",
      ]);
    }
    // A closed project is still a workspace a caller can bind to — listing only
    // the open ones is what the issue was filed about.
    expect(entries.map((e) => e.workspaceId)).toContain(PROJECT_CLOSED);
  });

  it("tags kind from the id shape, covering both stores", async () => {
    projectStoreMock.getAllProjectIdentities.mockReturnValue([
      project(PROJECT_OPEN, "Proj", "/repos/proj"),
    ]);
    scratchStoreMock.getAllScratches.mockReturnValue([
      scratch(SCRATCH_OPEN, "Scr", "/scratches/scr"),
    ]);

    const byId = new Map((await list()).map((e) => [e.workspaceId, e]));

    expect(byId.get(PROJECT_OPEN)?.kind).toBe("project");
    expect(byId.get(SCRATCH_OPEN)?.kind).toBe("scratch");
  });

  it("reports hasLiveView for views in any window, cached ones included", async () => {
    projectStoreMock.getAllProjectIdentities.mockReturnValue([
      project(PROJECT_OPEN, "Open", "/repos/open"),
      project(PROJECT_CACHED, "Cached", "/repos/cached"),
      project(PROJECT_CLOSED, "Closed", "/repos/closed"),
    ]);
    scratchStoreMock.getAllScratches.mockReturnValue([
      scratch(SCRATCH_OPEN, "Scratch", "/scratches/one"),
    ]);
    openView(PROJECT_OPEN);
    // Deactivated but still resident — a foreground-only union
    // (`collectActiveProjectIds`) reports this one closed, which is the bug
    // this flag has to avoid.
    cacheView(PROJECT_CACHED);
    // Scratches register through the same path as projects, so one lookup has
    // to cover both id spaces.
    openView(SCRATCH_OPEN);

    const byId = new Map((await list()).map((e) => [e.workspaceId, e.hasLiveView]));

    expect(byId.get(PROJECT_OPEN)).toBe(true);
    expect(byId.get(PROJECT_CACHED)).toBe(true);
    expect(byId.get(SCRATCH_OPEN)).toBe(true);
    expect(byId.get(PROJECT_CLOSED)).toBe(false);
  });

  it("keeps a workspace in the catalog once its view is destroyed", async () => {
    projectStoreMock.getAllProjectIdentities.mockReturnValue([
      project(PROJECT_OPEN, "Open", "/repos/open"),
    ]);
    const wc = openView(PROJECT_OPEN);
    expect((await list())[0].hasLiveView).toBe(true);

    // The real registry prunes the entry; membership is a catalog fact and must
    // survive — it is what separates a wrong id from a closed workspace.
    wc.isDestroyed = () => true;

    const [entry] = await list();
    expect(entry.workspaceId).toBe(PROJECT_OPEN);
    expect(entry.hasLiveView).toBe(false);
  });

  it("reports one row for a workspace holding two live views", async () => {
    projectStoreMock.getAllProjectIdentities.mockReturnValue([
      project(PROJECT_OPEN, "Open", "/repos/open"),
    ]);
    // Two live matches are ambiguous and get refused at binding time — the flag
    // says a view is open, it does not promise the route resolves.
    openView(PROJECT_OPEN);
    openView(PROJECT_OPEN);

    const entries = await list();
    expect(entries).toHaveLength(1);
    expect(entries[0].hasLiveView).toBe(true);
  });

  it("invents no catalog entry for a registered view with no stored row", async () => {
    openView(PROJECT_OPEN);
    expect(await list()).toEqual([]);
  });

  it("orders by workspace id regardless of store or registration order", async () => {
    projectStoreMock.getAllProjectIdentities.mockReturnValue([
      project(PROJECT_CACHED, "C", "/repos/c"),
      project(PROJECT_OPEN, "A", "/repos/a"),
      project(PROJECT_CLOSED, "B", "/repos/b"),
    ]);
    scratchStoreMock.getAllScratches.mockReturnValue([
      scratch(SCRATCH_CLOSED, "S2", "/scratches/two"),
      scratch(SCRATCH_OPEN, "S1", "/scratches/one"),
    ]);

    const ids = (await list()).map((e) => e.workspaceId);

    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual([
      SCRATCH_OPEN,
      SCRATCH_CLOSED,
      PROJECT_OPEN,
      PROJECT_CLOSED,
      PROJECT_CACHED,
    ]);
  });

  it("returns an empty catalog rather than failing when nothing is registered", async () => {
    await expect(list()).resolves.toEqual([]);
  });

  it("lists a project whose folder is gone rather than probing the filesystem", async () => {
    projectStoreMock.getAllProjectIdentities.mockReturnValue([
      project(PROJECT_CLOSED, "Deleted", "/repos/moved-away"),
    ]);

    // Discovery reports what is recorded. Probing would turn a catalog read
    // into a filesystem walk and would drop exactly the relocated projects the
    // tool exists to make addressable.
    const [entry] = await list();
    expect(entry.path).toBe("/repos/moved-away");
  });

  it("propagates a store failure instead of reporting an empty catalog", async () => {
    projectStoreMock.getAllProjectIdentities.mockImplementation(() => {
      throw new Error("db unavailable");
    });

    // An empty catalog is a real answer — "this id is wrong" is read off it —
    // so a failed read must never be able to impersonate one.
    await expect(list()).rejects.toThrow("db unavailable");
  });

  it("unregisters its channel on cleanup", () => {
    cleanup();
    expect(ipcHandlers.has("workspace:list")).toBe(false);
  });
});
