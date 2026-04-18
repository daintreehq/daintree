import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const waitForRateLimitSlotMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const checkRateLimitMock = vi.hoisted(() => vi.fn());

const getWindowForWebContentsMock = vi.hoisted(() => vi.fn());
const generateWorktreePathMock = vi.hoisted(() => vi.fn());
const validatePathPatternMock = vi.hoisted(() =>
  vi.fn<(pattern: string) => { valid: boolean; error?: string }>(() => ({ valid: true }))
);
const resolveWorktreePatternMock = vi.hoisted(() => vi.fn().mockResolvedValue("../wt/{branch}"));

const storeMock = vi.hoisted(() => ({
  get: vi.fn<(key: string, fallback?: unknown) => unknown>(),
  set: vi.fn(),
}));

const fileSearchMock = vi.hoisted(() => ({ invalidate: vi.fn() }));
const soundMock = vi.hoisted(() => ({ play: vi.fn() }));
const projectStoreMock = vi.hoisted(() => ({
  getCurrentProjectId: vi.fn<() => string | null>(() => "proj-1"),
  getCurrentProject: vi.fn(() => ({ id: "proj-1", path: "/repo" })),
}));
const taskWorktreeMock = vi.hoisted(() => ({
  getGitService: vi.fn(() => ({
    findAvailableBranchName: vi.fn(async (s: string) => s),
    findAvailablePath: vi.fn((p: string) => p),
  })),
  getWorktreeIdsForTask: vi.fn<(projectId: string, taskId: string) => string[]>(() => []),
  removeTaskWorktreeMapping:
    vi.fn<(projectId: string, taskId: string, worktreeId: string) => void>(),
  addTaskWorktreeMapping: vi.fn<(projectId: string, taskId: string, worktreeId: string) => void>(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: vi.fn().mockReturnValue(null) },
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: getWindowForWebContentsMock,
}));

vi.mock("../../utils.js", () => ({
  checkRateLimit: checkRateLimitMock,
  waitForRateLimitSlot: waitForRateLimitSlotMock,
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
  typedHandleWithContext: (channel: string, handler: unknown) => {
    ipcMainMock.handle(
      channel,
      (event: { sender?: { id?: number } } | null | undefined, ...args: unknown[]) => {
        const ctx = {
          event: event as unknown,
          webContentsId: event?.sender?.id ?? 0,
          senderWindow: getWindowForWebContentsMock(event?.sender),
          projectId: null,
        };
        return (handler as (...a: unknown[]) => unknown)(ctx, ...args);
      }
    );
    return () => ipcMainMock.removeHandler(channel);
  },
}));

vi.mock("../../../store.js", () => ({ store: storeMock }));

vi.mock("../../../services/FileSearchService.js", () => ({
  fileSearchService: fileSearchMock,
}));

vi.mock("../../../services/SoundService.js", () => ({
  soundService: soundMock,
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

vi.mock("../../../services/TaskWorktreeService.js", () => ({
  taskWorktreeService: taskWorktreeMock,
}));

vi.mock("../../../utils/worktreePattern.js", () => ({
  resolveWorktreePattern: resolveWorktreePatternMock,
}));

vi.mock("../../../../shared/utils/pathPattern.js", () => ({
  generateWorktreePath: generateWorktreePathMock,
  validatePathPattern: validatePathPatternMock,
}));

vi.mock("../../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

import { registerWorktreeHandlers } from "../worktree.js";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn as Handler;
}

function fakeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} as Electron.WebContents } as Electron.IpcMainInvokeEvent;
}

function baseStoreGetImpl(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    notificationSettings: { uiFeedbackSoundEnabled: false },
    worktreeIssueMap: {},
  };
  const data = { ...defaults, ...overrides };
  return (key: string, fallback?: unknown) => {
    if (key in data) return data[key];
    return fallback;
  };
}

describe("worktree IPC adversarial", () => {
  let cleanup: () => void;
  let worktreeService: {
    getAllStatesAsync: ReturnType<typeof vi.fn>;
    createWorktree: ReturnType<typeof vi.fn>;
    deleteWorktree: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    storeMock.get.mockImplementation(baseStoreGetImpl());
    waitForRateLimitSlotMock.mockResolvedValue(undefined);

    worktreeService = {
      getAllStatesAsync: vi.fn().mockResolvedValue([]),
      createWorktree: vi.fn().mockResolvedValue("wt-new"),
      deleteWorktree: vi.fn().mockResolvedValue(undefined),
    };
    cleanup = registerWorktreeHandlers({
      worktreeService,
    } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("WORKTREE_GET_ALL forwards sender window id to getAllStatesAsync", async () => {
    getWindowForWebContentsMock.mockReturnValue({ id: 42 });
    worktreeService.getAllStatesAsync.mockResolvedValue([{ id: "wt-1" }]);

    const result = await getHandler(CHANNELS.WORKTREE_GET_ALL)(fakeEvent());

    expect(worktreeService.getAllStatesAsync).toHaveBeenCalledWith(42);
    expect(result).toEqual([{ id: "wt-1" }]);
  });

  it("WORKTREE_GET_ALL returns empty array when worktreeService is absent", async () => {
    cleanup();
    ipcHandlers.clear();
    cleanup = registerWorktreeHandlers({} as HandlerDependencies);

    const result = await getHandler(CHANNELS.WORKTREE_GET_ALL)(fakeEvent());
    expect(result).toEqual([]);
  });

  it("WORKTREE_CREATE still resolves when fileSearchService.invalidate throws", async () => {
    fileSearchMock.invalidate.mockImplementationOnce(() => {
      throw new Error("fs cache unreachable");
    });
    storeMock.get.mockImplementation(
      baseStoreGetImpl({ notificationSettings: { uiFeedbackSoundEnabled: true } })
    );
    worktreeService.createWorktree.mockResolvedValue("wt-1");

    const result = await getHandler(CHANNELS.WORKTREE_CREATE)(fakeEvent(), {
      rootPath: "/repo",
      options: { baseBranch: "main", newBranch: "feat/x", path: "/repo/wt-x" },
    });

    expect(result).toBe("wt-1");
    expect(soundMock.play).toHaveBeenCalledWith("worktree-create");
  });

  it("WORKTREE_DELETE invalidates the exact worktree path and prunes only matching issue mapping", async () => {
    getWindowForWebContentsMock.mockReturnValue({ id: 5 });
    worktreeService.getAllStatesAsync.mockResolvedValue([
      { id: "wt-1", path: "/repo/w1" },
      { id: "wt-2", path: "/repo/w2" },
    ]);
    storeMock.get.mockImplementation(
      baseStoreGetImpl({
        worktreeIssueMap: {
          "wt-1": { issueNumber: 1 },
          "wt-2": { issueNumber: 2 },
        },
      })
    );

    await getHandler(CHANNELS.WORKTREE_DELETE)(fakeEvent(), {
      worktreeId: "wt-1",
      force: true,
      deleteBranch: false,
    });

    expect(worktreeService.deleteWorktree).toHaveBeenCalledWith("wt-1", true, false);
    expect(fileSearchMock.invalidate).toHaveBeenCalledWith("/repo/w1");
    expect(fileSearchMock.invalidate).not.toHaveBeenCalledWith("/repo/w2");
    expect(storeMock.set).toHaveBeenCalledWith("worktreeIssueMap", {
      "wt-2": { issueNumber: 2 },
    });
  });

  it("WORKTREE_DELETE rejects malformed payloads before invoking worktreeService", async () => {
    const handler = getHandler(CHANNELS.WORKTREE_DELETE);

    await expect(handler(fakeEvent(), null)).rejects.toThrow(/Invalid payload/);
    await expect(handler(fakeEvent(), { worktreeId: "" })).rejects.toThrow(/Invalid worktree ID/);
    await expect(handler(fakeEvent(), { worktreeId: "wt-1", force: "yes" })).rejects.toThrow(
      /Invalid force/
    );
    await expect(handler(fakeEvent(), { worktreeId: "wt-1", deleteBranch: 1 })).rejects.toThrow(
      /Invalid deleteBranch/
    );

    expect(worktreeService.deleteWorktree).not.toHaveBeenCalled();
  });

  it("WORKTREE_GET_DEFAULT_PATH rejects corrupt stored patterns before touching git", async () => {
    validatePathPatternMock.mockReturnValue({ valid: false, error: "missing {branch}" });

    await expect(
      getHandler(CHANNELS.WORKTREE_GET_DEFAULT_PATH)(fakeEvent(), {
        rootPath: "/repo",
        branchName: "feat/x",
      })
    ).rejects.toThrow(/Invalid stored pattern: missing \{branch\}/);

    expect(taskWorktreeMock.getGitService).not.toHaveBeenCalled();
  });

  it("WORKTREE_GET_DEFAULT_PATH rejects empty rootPath/branchName without calling resolve", async () => {
    const handler = getHandler(CHANNELS.WORKTREE_GET_DEFAULT_PATH);

    await expect(handler(fakeEvent(), { rootPath: "   ", branchName: "feat/x" })).rejects.toThrow(
      /Invalid rootPath/
    );
    await expect(handler(fakeEvent(), { rootPath: "/repo", branchName: "" })).rejects.toThrow(
      /Invalid branchName/
    );

    expect(resolveWorktreePatternMock).not.toHaveBeenCalled();
  });

  it("WORKTREE_CLEANUP_TASK skips main worktree, treats not-found as success, aggregates real failures", async () => {
    taskWorktreeMock.getWorktreeIdsForTask.mockReturnValue(["wt-main", "wt-missing", "wt-bad"]);
    worktreeService.getAllStatesAsync.mockResolvedValue([
      { id: "wt-main", path: "/repo/main", isMainWorktree: true },
      { id: "wt-missing", path: "/repo/missing" },
      { id: "wt-bad", path: "/repo/bad" },
    ]);
    worktreeService.deleteWorktree
      .mockImplementationOnce(async (id: string) => {
        if (id === "wt-missing") throw new Error("worktree does not exist");
      })
      .mockImplementationOnce(async (id: string) => {
        if (id === "wt-bad") throw new Error("EPERM: permission denied");
      });

    await expect(
      getHandler(CHANNELS.WORKTREE_CLEANUP_TASK)(fakeEvent(), "task-42")
    ).rejects.toThrow(/wt-bad: EPERM/);

    const removedArgs = taskWorktreeMock.removeTaskWorktreeMapping.mock.calls.map(
      (call) => call[2]
    );
    expect(removedArgs).toContain("wt-main");
    expect(removedArgs).toContain("wt-missing");
    expect(removedArgs).not.toContain("wt-bad");
  });

  it("WORKTREE_CLEANUP_TASK is idempotent when the task has no mapped worktrees", async () => {
    taskWorktreeMock.getWorktreeIdsForTask.mockReturnValue([]);

    await expect(
      getHandler(CHANNELS.WORKTREE_CLEANUP_TASK)(fakeEvent(), "task-none")
    ).resolves.toBeUndefined();

    expect(worktreeService.deleteWorktree).not.toHaveBeenCalled();
    expect(taskWorktreeMock.removeTaskWorktreeMapping).not.toHaveBeenCalled();
  });

  it("WORKTREE_CLEANUP_TASK still deletes when pre-check getAllStatesAsync rejects", async () => {
    taskWorktreeMock.getWorktreeIdsForTask.mockReturnValue(["wt-1"]);
    worktreeService.getAllStatesAsync.mockRejectedValue(new Error("IPC transport error"));
    worktreeService.deleteWorktree.mockResolvedValue(undefined);

    await getHandler(CHANNELS.WORKTREE_CLEANUP_TASK)(fakeEvent(), "task-resilient");

    expect(worktreeService.deleteWorktree).toHaveBeenCalledWith("wt-1", true, true);
    expect(taskWorktreeMock.removeTaskWorktreeMapping).toHaveBeenCalledWith(
      "proj-1",
      "task-resilient",
      "wt-1"
    );
  });

  it("WORKTREE_CLEANUP_TASK requires an active project", async () => {
    projectStoreMock.getCurrentProjectId.mockReturnValueOnce(null);

    await expect(getHandler(CHANNELS.WORKTREE_CLEANUP_TASK)(fakeEvent(), "task-1")).rejects.toThrow(
      /No active project/
    );

    expect(worktreeService.deleteWorktree).not.toHaveBeenCalled();
  });
});
