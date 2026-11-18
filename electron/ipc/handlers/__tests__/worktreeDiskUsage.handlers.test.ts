import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProjectId: vi.fn<() => string | null>(() => null),
  getProjectById: vi.fn<(projectId: string) => { id: string; path: string } | null>(() => null),
}));

const viewProject = vi.hoisted(() => ({
  id: null as string | null,
  /** Per-view overrides of `id`, by webContents id. */
  byView: new Map<number, string>(),
}));

const measureMock = vi.hoisted(() =>
  vi.fn<
    (root: string, options: { exclude: readonly string[]; signal: AbortSignal }) => Promise<number>
  >()
);

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));
const indexSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../../services/DirectoryDiskUsage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../services/DirectoryDiskUsage.js")>();
  return {
    ...actual,
    measureDirectorySize: measureMock,
    indexNestedRoots: (...args: Parameters<typeof actual.indexNestedRoots>) => {
      indexSpy.calls += 1;
      return actual.indexNestedRoots(...args);
    },
  };
});
vi.mock("../../../window/webContentsRegistry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../window/webContentsRegistry.js")>()),
  getProjectForWebContents: (webContentsId: number) =>
    viewProject.byView.get(webContentsId) ?? viewProject.id,
  getWindowForWebContents: () => null,
}));
vi.mock("../../../window/windowRef.js", () => ({
  getProjectViewManager: vi.fn(() => null),
  setProjectViewManager: vi.fn(),
  getWindowRegistry: vi.fn(() => null),
  setWindowRegistry: vi.fn(),
  getMainWindow: vi.fn(() => null),
  setMainWindow: vi.fn(),
}));

import { CHANNELS } from "../../channels.js";
import { registerWorktreeDiskUsageHandlers } from "../worktreeDiskUsage.js";
import {
  DISK_USAGE_CONCURRENCY,
  WorktreeDiskUsageService,
} from "../../../services/WorktreeDiskUsageService.js";

const PROJECT = "a".repeat(64);

class FakeSender extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
  isDestroyed() {
    return false;
  }
}

const states = [
  { id: "main", path: "/repo" },
  { id: "nested", path: "/repo/.worktrees/feature" },
  { id: "sibling", path: "/repo-worktrees/other" },
];

const getAllStatesForProjectAsync = vi.fn(
  async (_projectPath: string, _projectId: string): Promise<{ id: string; path: string }[]> =>
    states
);

let cleanup: (() => void) | null = null;

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`${channel} was never registered`);
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

/** A size unique to each root, so a result shows which root was scanned. */
function sizeOf(root: string): number {
  return [...root].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 1_000_003, 7);
}

function measured(root: string) {
  return { status: "measured", bytes: sizeOf(root) };
}

function excludeEntries(): number {
  return measureMock.mock.calls.reduce((sum, [, options]) => sum + options.exclude.length, 0);
}

function excludeFor(root: string): readonly string[] | undefined {
  return measureMock.mock.calls.find(([r]) => r === root)?.[1].exclude;
}

async function invoke(channel: string, sender: FakeSender, payload: unknown): Promise<unknown> {
  const result = (await handler(channel)({ sender }, payload)) as {
    ok?: boolean;
    data?: unknown;
    error?: unknown;
  };
  if (result?.ok === false) throw new Error(JSON.stringify(result.error));
  return result?.ok ? result.data : result;
}

function register(projectIdForView: string | null = PROJECT): void {
  viewProject.id = projectIdForView;
  cleanup = registerWorktreeDiskUsageHandlers({
    worktreeService: { getAllStatesForProjectAsync },
  } as never);
}

describe("worktreeDiskUsage handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    indexSpy.calls = 0;
    viewProject.byView.clear();
    // A fresh inventory per test: lookups are cached by inventory identity.
    const inventory = [...states];
    getAllStatesForProjectAsync.mockImplementation(async () => inventory);
    projectStoreMock.getProjectById.mockImplementation((id) =>
      id === PROJECT ? { id, path: "/repo" } : null
    );
    measureMock.mockImplementation(async (root) => sizeOf(root));
    register();
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("measures the worktree the sender's project lists, excluding only the roots nested in it", async () => {
    const sender = new FakeSender(1);
    const result = await invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, sender, {
      sessionId: "s1",
      worktreeId: "main",
    });
    expect(result).toEqual(measured("/repo"));
    expect(getAllStatesForProjectAsync).toHaveBeenCalledWith("/repo", PROJECT);
    const [root, options] = measureMock.mock.calls[0];
    expect(root).toBe("/repo");
    expect(options.exclude).toEqual(["/repo/.worktrees/feature"]);
  });

  it("prepares one lookup per inventory, and queued sibling scans retain no exclusions", async () => {
    const siblings = Array.from({ length: 200 }, (_, i) => ({
      id: `wt-${i}`,
      path: `/repo-worktrees/wt-${i}`,
    }));
    getAllStatesForProjectAsync.mockImplementation(async () => siblings);
    const enqueue = vi.spyOn(WorktreeDiskUsageService.prototype, "measure");
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    measureMock.mockImplementation(async (root) => {
      await gate;
      return sizeOf(root);
    });
    const sender = new FakeSender(1);
    const pending = Promise.all(
      siblings.map(({ id }) =>
        invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, sender, { sessionId: "s1", worktreeId: id })
      )
    );
    try {
      // Every request is queued behind the scans holding the slots.
      await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(200));
      expect(measureMock).toHaveBeenCalledTimes(DISK_USAGE_CONCURRENCY);
      expect(indexSpy.calls).toBe(1);
      expect(enqueue.mock.calls.reduce((sum, [, , exclude]) => sum + exclude.length, 0)).toBe(0);
    } finally {
      open();
    }
    expect(await pending).toEqual(siblings.map(({ path }) => measured(path)));
    expect(excludeEntries()).toBe(0);
  });

  it("gives each worktree of a nested layout only its nearest nested roots", async () => {
    const nested = [
      { id: "main", path: "/repo" },
      { id: "a", path: "/repo/.worktrees/a" },
      { id: "inner", path: "/repo/.worktrees/a/inner" },
      { id: "b", path: "/repo/.worktrees/b" },
      { id: "sibling", path: "/repo-worktrees/c" },
      // A repeated id is the worktree of its first listing, and only that is indexed.
      { id: "b", path: "/repo/duplicate-b" },
    ];
    getAllStatesForProjectAsync.mockImplementation(async () => nested);
    const sender = new FakeSender(1);
    const ids = ["main", "a", "inner", "b", "sibling"];
    const results = await Promise.all(
      ids.map((id) =>
        invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, sender, { sessionId: "s1", worktreeId: id })
      )
    );
    expect(results).toEqual(ids.map((id) => measured(nested.find((s) => s.id === id)!.path)));
    expect(indexSpy.calls).toBe(1);
    expect([...excludeFor("/repo")!].sort()).toEqual(["/repo/.worktrees/a", "/repo/.worktrees/b"]);
    expect(excludeFor("/repo/.worktrees/a")).toEqual(["/repo/.worktrees/a/inner"]);
    expect(excludeFor("/repo/.worktrees/a/inner")).toEqual([]);
    expect(excludeFor("/repo/.worktrees/b")).toEqual([]);
    expect(excludeFor("/repo-worktrees/c")).toEqual([]);
    expect(excludeEntries()).toBe(3);
  });

  it("builds a fresh lookup for a newer inventory, so a moved worktree is excluded where it now is", async () => {
    const sender = new FakeSender(1);
    const ask = (worktreeId: string) =>
      invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, sender, { sessionId: "s1", worktreeId });
    await ask("main");
    expect(excludeFor("/repo")).toEqual(["/repo/.worktrees/feature"]);

    const moved = [
      { id: "main", path: "/repo" },
      { id: "nested", path: "/repo-worktrees/feature" },
      { id: "sibling", path: "/repo/sub/other" },
    ];
    getAllStatesForProjectAsync.mockImplementation(async () => moved);
    measureMock.mockClear();
    expect(await ask("main")).toEqual(measured("/repo"));
    expect(await ask("nested")).toEqual(measured("/repo-worktrees/feature"));
    expect(indexSpy.calls).toBe(2);
    expect(excludeFor("/repo")).toEqual(["/repo/sub/other"]);

    // Another read with the same content is another inventory.
    getAllStatesForProjectAsync.mockImplementation(async () => moved.map((s) => ({ ...s })));
    expect(await ask("sibling")).toEqual(measured("/repo/sub/other"));
    expect(indexSpy.calls).toBe(3);
  });

  it("resolves overlapping requests against each view's own project inventory", async () => {
    const OTHER = "b".repeat(64);
    projectStoreMock.getProjectById.mockImplementation((id) =>
      id === PROJECT ? { id, path: "/repo" } : id === OTHER ? { id, path: "/other" } : null
    );
    // Both projects list a worktree with the same id at different places.
    const ownStates = [
      { id: "main", path: "/repo" },
      { id: "wt", path: "/repo/wt" },
    ];
    const otherStates = [
      { id: "main", path: "/other" },
      { id: "wt", path: "/other-worktrees/wt" },
    ];
    getAllStatesForProjectAsync.mockImplementation(async (_path, projectId) =>
      projectId === OTHER ? otherStates : ownStates
    );
    viewProject.byView.set(2, OTHER);
    const results = await Promise.all([
      invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, new FakeSender(1), {
        sessionId: "s1",
        worktreeId: "main",
      }),
      invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, new FakeSender(2), {
        sessionId: "s1",
        worktreeId: "main",
      }),
    ]);
    expect(results).toEqual([measured("/repo"), measured("/other")]);
    expect(getAllStatesForProjectAsync).toHaveBeenCalledWith("/repo", PROJECT);
    expect(getAllStatesForProjectAsync).toHaveBeenCalledWith("/other", OTHER);
    expect(indexSpy.calls).toBe(2);
    expect(excludeFor("/repo")).toEqual(["/repo/wt"]);
    expect(excludeFor("/other")).toEqual([]);

    // The first view switches to the other project: its next request reads that inventory.
    viewProject.byView.set(1, OTHER);
    expect(
      await invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, new FakeSender(1), {
        sessionId: "s2",
        worktreeId: "wt",
      })
    ).toEqual(measured("/other-worktrees/wt"));
    expect(getAllStatesForProjectAsync).toHaveBeenLastCalledWith("/other", OTHER);
  });

  it("a cancel while the inventory is still being read stops the request before any preparation", async () => {
    let deliver: (value: { id: string; path: string }[]) => void = () => {};
    let readStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => (readStarted = resolve));
    getAllStatesForProjectAsync.mockImplementation(() => {
      readStarted();
      return new Promise((resolve) => (deliver = resolve));
    });
    const sender = new FakeSender(1);
    const pending = invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, sender, {
      sessionId: "s1",
      worktreeId: "main",
    });
    await started;
    await invoke(CHANNELS.WORKTREE_DISK_USAGE_CANCEL, sender, { sessionId: "s1" });
    deliver([...states]);
    expect(await pending).toEqual({ status: "unknown" });
    expect(indexSpy.calls).toBe(0);
    expect(measureMock).not.toHaveBeenCalled();
  });

  it("answers unknown, without scanning, for a worktree its project doesn't list", async () => {
    const result = await invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, new FakeSender(1), {
      sessionId: "s1",
      worktreeId: "someone-elses",
    });
    expect(result).toEqual({ status: "unknown" });
    expect(measureMock).not.toHaveBeenCalled();
  });

  it("answers unknown for a view with no project", async () => {
    cleanup?.();
    register(null);
    const result = await invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, new FakeSender(1), {
      sessionId: "s1",
      worktreeId: "main",
    });
    expect(result).toEqual({ status: "unknown" });
    expect(getAllStatesForProjectAsync).not.toHaveBeenCalled();
  });

  it("rejects a malformed request", async () => {
    await expect(
      invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, new FakeSender(1), { sessionId: "s1" })
    ).rejects.toThrow();
    await expect(
      invoke(CHANNELS.WORKTREE_DISK_USAGE_CANCEL, new FakeSender(1), null)
    ).rejects.toThrow();
  });

  it("a cancel sent right behind a request stops it before it scans", async () => {
    const sender = new FakeSender(1);
    const pending = invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, sender, {
      sessionId: "s1",
      worktreeId: "main",
    });
    await invoke(CHANNELS.WORKTREE_DISK_USAGE_CANCEL, sender, { sessionId: "s1" });
    expect(await pending).toEqual({ status: "unknown" });
    expect(measureMock).not.toHaveBeenCalled();
  });

  it("stops a view's running scan when it navigates away, leaving other views' alone", async () => {
    let releaseA: (() => void) | null = null;
    const signals: AbortSignal[] = [];
    measureMock.mockImplementation(
      (_root, { signal }) =>
        new Promise((resolve) => {
          signals.push(signal);
          releaseA ??= () => resolve(1);
          signal.addEventListener("abort", () => resolve(1));
        })
    );
    const a = new FakeSender(1);
    const b = new FakeSender(2);
    const fromA = invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, a, {
      sessionId: "s1",
      worktreeId: "main",
    });
    void invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, b, {
      sessionId: "s1",
      worktreeId: "sibling",
    });
    await vi.waitFor(() => expect(signals).toHaveLength(2));

    a.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(await fromA).toEqual({ status: "unknown" });

    b.emit("render-process-gone");
    expect(signals[1].aborted).toBe(true);
  });
});
