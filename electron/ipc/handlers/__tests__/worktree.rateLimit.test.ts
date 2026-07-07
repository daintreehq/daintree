import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const waitForRateLimitSlotMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const waitForBurstRateLimitSlotMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const checkRateLimitMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: {
    fromWebContents: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("../../utils.js", () => {
  const typedHandle = (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  };
  const typedHandleWithContext = (channel: string, handler: unknown) => {
    ipcMainMock.handle(
      channel,
      (event: { sender?: { id?: number } } | null | undefined, ...args: unknown[]) => {
        const ctx = {
          event: event as unknown,
          webContentsId: event?.sender?.id ?? 0,
          senderWindow: null,
          projectId: null,
        };
        return (handler as (...a: unknown[]) => unknown)(ctx, ...args);
      }
    );
    return () => ipcMainMock.removeHandler(channel);
  };
  const parseOrThrow = (
    channel: string,
    schema: { safeParse: (input: unknown) => { success: boolean } },
    input: unknown
  ) => {
    const result = schema.safeParse(input);
    if (!result.success) {
      const err = new Error(`IPC validation failed: ${channel}`);
      (err as Error & { name: string }).name = "ValidationError";
      throw err;
    }
    return (result as { success: true; data: unknown }).data;
  };
  return {
    checkRateLimit: checkRateLimitMock,
    waitForRateLimitSlot: waitForRateLimitSlotMock,
    waitForBurstRateLimitSlot: waitForBurstRateLimitSlotMock,
    typedHandle,
    typedHandleWithContext,
    typedHandleValidated: (
      channel: string,
      schema: { safeParse: (input: unknown) => { success: boolean } },
      handler: unknown
    ) =>
      typedHandle(channel, async (...args: unknown[]) => {
        const parsed = parseOrThrow(channel, schema, args[0]);
        return (handler as (payload: unknown) => unknown)(parsed);
      }),
    typedHandleWithContextValidated: (
      channel: string,
      schema: { safeParse: (input: unknown) => { success: boolean } },
      handler: unknown
    ) =>
      typedHandleWithContext(channel, async (ctx: unknown, ...args: unknown[]) => {
        const parsed = parseOrThrow(channel, schema, args[0]);
        return (handler as (ctx: unknown, payload: unknown) => unknown)(ctx, parsed);
      }),
  };
});

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProject: vi.fn(() => ({ id: "proj-1", path: "/test/project" })),
    getCurrentProjectId: vi.fn(() => "proj-1"),
  },
}));

vi.mock("../../../services/FileSearchService.js", () => ({
  fileSearchService: { invalidate: vi.fn() },
}));

vi.mock("../../../services/GitServiceCache.js", () => ({
  gitServiceCache: {
    getGitService: vi.fn(() => ({
      findAvailableBranchName: vi.fn().mockResolvedValue("task-123"),
      findAvailablePath: vi.fn(() => "/test/worktrees/task-123"),
    })),
  },
}));

vi.mock("../../../utils/worktreePattern.js", () => ({
  resolveWorktreePattern: vi.fn().mockResolvedValue("../worktrees/{branch}"),
}));

vi.mock("../../../../shared/utils/pathPattern.js", () => ({
  generateWorktreePath: vi.fn(() => "/test/worktrees/task-123"),
  validatePathPattern: vi.fn(() => ({ valid: true })),
  validateBranchName: vi.fn(() => ({ valid: true })),
}));

vi.mock("../../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../../../store.js", () => ({
  store: { get: vi.fn(() => ({})), set: vi.fn() },
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn().mockReturnValue(null),
}));

vi.mock("../../../services/SoundService.js", () => ({
  soundService: { play: vi.fn() },
}));

import { CHANNELS } from "../../channels.js";
import { registerWorktreeHandlers } from "../worktree/index.js";

function getInvokeHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(
    ([registered]) => registered === channel
  );
  if (!call) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

describe("worktree rate limiting", () => {
  const mockWorktreeService = {
    createWorktree: vi.fn().mockResolvedValue("wt-1"),
    deleteWorktree: vi.fn().mockResolvedValue(undefined),
    getAllStatesAsync: vi
      .fn()
      .mockResolvedValue([{ id: "main", branch: "main", isMainWorktree: true }]),
    getMonitorAsync: vi.fn().mockResolvedValue(null),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    registerWorktreeHandlers({
      mainWindow: {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: vi.fn() },
      },
      ptyClient: { hasTerminal: vi.fn(() => false), write: vi.fn() },
      worktreeService: mockWorktreeService,
    } as never);
  });

  describe("worktree:create", () => {
    it("calls waitForBurstRateLimitSlot with dedicated key, interval, and burst allowance", async () => {
      const handler = getInvokeHandler(CHANNELS.WORKTREE_CREATE);
      await handler({} as never, {
        rootPath: "/test/project",
        options: { baseBranch: "main", newBranch: "feat-1", path: "/test/worktrees/feat-1" },
      });

      expect(waitForBurstRateLimitSlotMock).toHaveBeenCalledWith("worktreeCreate", 1_000, 30);
      expect(mockWorktreeService.createWorktree).toHaveBeenCalled();
    });

    it("rejects without calling createWorktree when rate limit slot rejects", async () => {
      waitForBurstRateLimitSlotMock.mockRejectedValueOnce(new Error("Spawn queue full"));
      const handler = getInvokeHandler(CHANNELS.WORKTREE_CREATE);

      await expect(
        handler({} as never, {
          rootPath: "/test/project",
          options: { baseBranch: "main", newBranch: "feat-1", path: "/test/worktrees/feat-1" },
        })
      ).rejects.toThrow("Spawn queue full");

      expect(mockWorktreeService.createWorktree).not.toHaveBeenCalled();
    });

    it("coalesces identical concurrent create requests before consuming a second rate-limit slot", async () => {
      let resolveCreate!: (worktreeId: string) => void;
      mockWorktreeService.createWorktree.mockReturnValueOnce(
        new Promise<string>((resolve) => {
          resolveCreate = resolve;
        })
      );
      const handler = getInvokeHandler(CHANNELS.WORKTREE_CREATE);
      const payload = {
        rootPath: "/test/project",
        options: { baseBranch: "main", newBranch: "feat-1", path: "/test/worktrees/feat-1" },
      };

      const first = handler({} as never, payload);
      const second = handler({} as never, payload);
      await Promise.resolve();

      expect(waitForBurstRateLimitSlotMock).toHaveBeenCalledTimes(1);
      expect(mockWorktreeService.createWorktree).toHaveBeenCalledTimes(1);

      resolveCreate("wt-1");
      await expect(Promise.all([first, second])).resolves.toEqual(["wt-1", "wt-1"]);
    });
  });

  describe("other handlers still use checkRateLimit", () => {
    it("worktree:delete uses checkRateLimit, not waitForRateLimitSlot", async () => {
      const handler = getInvokeHandler(CHANNELS.WORKTREE_DELETE);
      await expect(handler({} as never, { worktreeId: "wt-1" })).resolves.not.toThrow();

      expect(checkRateLimitMock).toHaveBeenCalledWith(CHANNELS.WORKTREE_DELETE, 10, 10_000);
      expect(waitForRateLimitSlotMock).not.toHaveBeenCalled();
    });
  });
});
