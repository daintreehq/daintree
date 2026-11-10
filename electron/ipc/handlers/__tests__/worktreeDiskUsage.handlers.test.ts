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
vi.mock("../../../services/DirectoryDiskUsage.js", () => ({ measureDirectorySize: measureMock }));
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

const getAllStatesForProjectAsync = vi.fn(async () => states);

let cleanup: (() => void) | null = null;

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`${channel} was never registered`);
  return call[1] as (...args: unknown[]) => Promise<unknown>;
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

  it("measures the worktree the sender's project lists, leaving every other root to exclusion", async () => {
    const sender = new FakeSender(1);
    const result = await invoke(CHANNELS.WORKTREE_DISK_USAGE_MEASURE, sender, {
      sessionId: "s1",
      worktreeId: "main",
    });
    expect(result).toEqual({ status: "measured", bytes: 2048 });
    expect(getAllStatesForProjectAsync).toHaveBeenCalledWith("/repo", PROJECT);
    const [root, options] = measureMock.mock.calls[0];
    expect(root).toBe("/repo");
    expect(options.exclude).toEqual(["/repo/.worktrees/feature", "/repo-worktrees/other"]);
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
