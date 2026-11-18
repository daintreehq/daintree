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

const viewProject = vi.hoisted(() => ({ id: null as string | null }));

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
  getProjectForWebContents: () => viewProject.id,
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
  async (_projectPath: string, _projectId: string): Promise<{ id: string; path: string }[]> => states
);

let cleanup: (() => void) | null = null;

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`${channel} was never registered`);
  return call[1] as (...args: unknown[]) => Promise<unknown>;
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
    indexSpy.calls = 0;
    // A fresh inventory per test: lookups are cached by inventory identity.
    const inventory = [...states];
    getAllStatesForProjectAsync.mockImplementation(async () => inventory);
    projectStoreMock.getProjectById.mockImplementation((id) =>
      id === PROJECT ? { id, path: "/repo" } : null
    );
    measureMock.mockResolvedValue(2048);
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
    expect(result).toEqual({ status: "measured", bytes: 2048 });
    expect(getAllStatesForProjectAsync).toHaveBeenCalledWith("/repo", PROJECT);
    const [root, options] = measureMock.mock.calls[0];
    expect(root).toBe("/repo");
    expect(options.exclude).toEqual(["/repo/.worktrees/feature"]);
  });

  it("prepares one lookup per inventory, and siblings retain no exclusions", async () => {
    const siblings = Array.from({ length: 200 }, (_, i) => ({
      id: `wt-${i}`,
      path: `/repo-worktrees/wt-${i}`,
    }));
    getAllStatesForProjectAsync.mockImplementation(async () => siblings);
    const sender = new FakeSender(1);
    const results = await Promise.all(
      siblings.map(({ id }) =>
        invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, sender, { sessionId: "s1", worktreeId: id })
      )
    );
    expect(results.every((r) => (r as { status: string }).status === "measured")).toBe(true);
    expect(measureMock).toHaveBeenCalledTimes(200);
    expect(indexSpy.calls).toBe(1);
    expect(excludeEntries()).toBe(0);
  });

  it("gives each worktree of a nested layout only its nearest nested roots", async () => {
    const nested = [
      { id: "main", path: "/repo" },
      { id: "a", path: "/repo/.worktrees/a" },
      { id: "inner", path: "/repo/.worktrees/a/inner" },
      { id: "b", path: "/repo/.worktrees/b" },
      { id: "sibling", path: "/repo-worktrees/c" },
    ];
    getAllStatesForProjectAsync.mockImplementation(async () => nested);
    const sender = new FakeSender(1);
    await Promise.all(
      nested.map(({ id }) =>
        invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, sender, { sessionId: "s1", worktreeId: id })
      )
    );
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
    await invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, sender, {
      sessionId: "s1",
      worktreeId: "main",
    });
    expect(excludeFor("/repo")).toEqual(["/repo/.worktrees/feature"]);

    getAllStatesForProjectAsync.mockImplementation(async () => [
      { id: "main", path: "/repo" },
      { id: "nested", path: "/repo-worktrees/feature" },
      { id: "sibling", path: "/repo/sub/other" },
    ]);
    measureMock.mockClear();
    await invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, sender, {
      sessionId: "s2",
      worktreeId: "main",
    });
    expect(indexSpy.calls).toBe(2);
    expect(excludeFor("/repo")).toEqual(["/repo/sub/other"]);
  });

  it("resolves ids against the requesting view's own project inventory", async () => {
    const OTHER = "b".repeat(64);
    projectStoreMock.getProjectById.mockImplementation((id) =>
      id === PROJECT ? { id, path: "/repo" } : id === OTHER ? { id, path: "/other" } : null
    );
    const otherStates = [{ id: "theirs", path: "/other" }];
    const ownStates = [...states];
    getAllStatesForProjectAsync.mockImplementation(async (_path, projectId) =>
      projectId === OTHER ? otherStates : ownStates
    );
    await invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, new FakeSender(1), {
      sessionId: "s1",
      worktreeId: "main",
    });
    cleanup?.();
    register(OTHER);
    expect(
      await invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, new FakeSender(2), {
        sessionId: "s1",
        worktreeId: "main",
      })
    ).toEqual({ status: "unknown" });
    expect(
      await invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, new FakeSender(2), {
        sessionId: "s1",
        worktreeId: "theirs",
      })
    ).toEqual({ status: "measured", bytes: 2048 });
    expect(getAllStatesForProjectAsync).toHaveBeenLastCalledWith("/other", OTHER);
    expect(indexSpy.calls).toBe(2);
    expect(excludeFor("/other")).toEqual([]);
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
