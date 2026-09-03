import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const waitForRateLimitSlotMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const checkRateLimitMock = vi.hoisted(() => vi.fn());

const getWindowForWebContentsMock = vi.hoisted(() => vi.fn());
// Mutable holder so a test can vary the sender view's resolved project id,
// which the context-aware IPC wrapper injects as ctx.projectId (#11387).
const ctxOverrides = vi.hoisted(() => ({ projectId: null as string | null }));
const generateWorktreePathMock = vi.hoisted(() => vi.fn());
const validatePathPatternMock = vi.hoisted(() =>
  vi.fn<(pattern: string) => { valid: boolean; error?: string }>(() => ({ valid: true }))
);
const validateBranchNameMock = vi.hoisted(() =>
  vi.fn<(name: string) => { valid: boolean; error?: string }>(() => ({ valid: true }))
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
  getProjectById: vi.fn<(id: string) => { id: string; path: string } | null>(() => ({
    id: "proj-1",
    path: "/repo",
  })),
}));
const gitServiceCacheMock = vi.hoisted(() => ({
  getGitService: vi.fn(() => ({
    findAvailableBranchName: vi.fn(async (s: string) => s),
    findAvailablePath: vi.fn((p: string) => p),
  })),
  delete: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: vi.fn().mockReturnValue(null) },
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: getWindowForWebContentsMock,
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
          senderWindow: getWindowForWebContentsMock(event?.sender),
          projectId: ctxOverrides.projectId,
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
      // Mirror the real ValidationError shape — sanitized, no Zod issues.
      const err = new Error(`IPC validation failed: ${channel}`);
      (err as Error & { name: string }).name = "ValidationError";
      throw err;
    }
    return (result as { success: true; data: unknown }).data;
  };
  return {
    checkRateLimit: checkRateLimitMock,
    waitForRateLimitSlot: waitForRateLimitSlotMock,
    waitForBurstRateLimitSlot: waitForRateLimitSlotMock,
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

vi.mock("../../../services/GitServiceCache.js", () => ({
  gitServiceCache: gitServiceCacheMock,
}));

vi.mock("../../../utils/worktreePattern.js", () => ({
  resolveWorktreePattern: resolveWorktreePatternMock,
}));

vi.mock("../../../../shared/utils/pathPattern.js", () => ({
  generateWorktreePath: generateWorktreePathMock,
  validatePathPattern: validatePathPatternMock,
  validateBranchName: validateBranchNameMock,
}));

vi.mock("../../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

import { registerWorktreeHandlers } from "../worktree/index.js";
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
    getAllStatesForProjectAsync: ReturnType<typeof vi.fn>;
    createWorktree: ReturnType<typeof vi.fn>;
    deleteWorktree: ReturnType<typeof vi.fn>;
    invalidatePulseCache: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    storeMock.get.mockImplementation(baseStoreGetImpl());
    waitForRateLimitSlotMock.mockResolvedValue(undefined);
    // vi.clearAllMocks resets the implementation; re-anchor the default so
    // every WORKTREE_CREATE call sees a passing branch validator unless the
    // specific test overrides it.
    validateBranchNameMock.mockImplementation(() => ({ valid: true }));
    // Restore the ProjectStore lookup default that clearAllMocks wiped, and
    // reset the injected sender project id to the unresolved sentinel.
    projectStoreMock.getProjectById.mockReturnValue({ id: "proj-1", path: "/repo" });
    ctxOverrides.projectId = null;

    worktreeService = {
      getAllStatesAsync: vi.fn().mockResolvedValue([]),
      getAllStatesForProjectAsync: vi.fn().mockResolvedValue([]),
      createWorktree: vi.fn().mockResolvedValue("wt-new"),
      deleteWorktree: vi.fn().mockResolvedValue(undefined),
      invalidatePulseCache: vi.fn(),
    };
    cleanup = registerWorktreeHandlers({
      worktreeService,
    } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    cleanup();
  });

  it("WORKTREE_GET_ALL routes by the sender view's project id, not the window or global current (#11387)", async () => {
    // A window-scoped read of the hydration prefetch can be answered by a
    // different project's host after a fast switch; route by the immutable
    // project id instead so the list is authoritative for the right project.
    // Use a sender project distinct from the global current-project default
    // ("proj-1") so a regression that consulted getCurrentProjectId would fail.
    ctxOverrides.projectId = "proj-sender";
    projectStoreMock.getProjectById.mockReturnValue({ id: "proj-sender", path: "/sender-repo" });
    worktreeService.getAllStatesForProjectAsync.mockResolvedValue([{ id: "wt-1" }]);

    const result = await getHandler(CHANNELS.WORKTREE_GET_ALL)(fakeEvent());

    expect(projectStoreMock.getProjectById).toHaveBeenCalledWith("proj-sender");
    expect(worktreeService.getAllStatesForProjectAsync).toHaveBeenCalledWith(
      "/sender-repo",
      "proj-sender"
    );
    expect(worktreeService.getAllStatesAsync).not.toHaveBeenCalled();
    expect(result).toEqual([{ id: "wt-1" }]);
  });

  it("WORKTREE_GET_ALL returns [] without contacting a host when the sender project id is null (#11387)", async () => {
    // The ~1.35s startup window before view registration completes sends a null
    // project id; [] is the established "unknown, keep saved state" sentinel
    // (#11234), never a throw that would spam hydration's fallback path.
    ctxOverrides.projectId = null;

    const result = await getHandler(CHANNELS.WORKTREE_GET_ALL)(fakeEvent());

    expect(result).toEqual([]);
    // Neither read path is consulted — not the project-scoped one, and not a
    // silent fall-back to the window-scoped one.
    expect(worktreeService.getAllStatesForProjectAsync).not.toHaveBeenCalled();
    expect(worktreeService.getAllStatesAsync).not.toHaveBeenCalled();
  });

  it("WORKTREE_GET_ALL returns [] when the sender project id is unknown to the store (#11387)", async () => {
    ctxOverrides.projectId = "ghost";
    projectStoreMock.getProjectById.mockReturnValue(null);

    const result = await getHandler(CHANNELS.WORKTREE_GET_ALL)(fakeEvent());

    expect(result).toEqual([]);
    expect(worktreeService.getAllStatesForProjectAsync).not.toHaveBeenCalled();
    expect(worktreeService.getAllStatesAsync).not.toHaveBeenCalled();
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
      baseStoreGetImpl({
        notificationSettings: { soundEnabled: true, uiFeedbackSoundEnabled: true },
      })
    );
    worktreeService.createWorktree.mockResolvedValue("wt-1");

    const result = await getHandler(CHANNELS.WORKTREE_CREATE)(fakeEvent(), {
      rootPath: "/repo",
      options: { baseBranch: "main", newBranch: "feat/x", path: "/repo/wt-x" },
    });

    expect(result).toBe("wt-1");
    // Sound is fire-and-forget via dynamic import — drain microtasks first
    await new Promise((resolve) => setImmediate(resolve));
    expect(soundMock.play).toHaveBeenCalledWith("worktree-create");
  });

  it("WORKTREE_CREATE rejects invalid branch names before reaching worktreeService (#7033)", async () => {
    validateBranchNameMock.mockReturnValueOnce({
      valid: false,
      error: "Branch name cannot be 'HEAD'",
    });

    await expect(
      getHandler(CHANNELS.WORKTREE_CREATE)(fakeEvent(), {
        rootPath: "/repo",
        options: { baseBranch: "main", newBranch: "HEAD", path: "/repo/wt-head" },
      })
    ).rejects.toThrow(/HEAD/);

    expect(worktreeService.createWorktree).not.toHaveBeenCalled();
  });

  it("WORKTREE_CREATE surfaces validator error message verbatim (#7033)", async () => {
    validateBranchNameMock.mockReturnValueOnce({
      valid: false,
      error: "Branch name cannot contain '@{'",
    });

    await expect(
      getHandler(CHANNELS.WORKTREE_CREATE)(fakeEvent(), {
        rootPath: "/repo",
        options: { baseBranch: "main", newBranch: "feat@{x", path: "/repo/wt-bad" },
      })
    ).rejects.toThrow(/@\{/);

    expect(worktreeService.createWorktree).not.toHaveBeenCalled();
  });

  it("WORKTREE_CREATE rejects malformed payloads before validating (#7033)", async () => {
    const handler = getHandler(CHANNELS.WORKTREE_CREATE);

    // Sanitized validation message: schema details, field paths, and user
    // input never appear in the renderer-facing message (#9154).
    await expect(handler(fakeEvent(), null)).rejects.toThrow(
      /IPC validation failed: worktree:create/
    );
    await expect(handler(fakeEvent(), {})).rejects.toThrow(
      /IPC validation failed: worktree:create/
    );
    await expect(handler(fakeEvent(), { rootPath: "/repo" })).rejects.toThrow(
      /IPC validation failed: worktree:create/
    );
    await expect(handler(fakeEvent(), { rootPath: "/repo", options: null })).rejects.toThrow(
      /IPC validation failed: worktree:create/
    );

    expect(validateBranchNameMock).not.toHaveBeenCalled();
    expect(worktreeService.createWorktree).not.toHaveBeenCalled();
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
    expect(gitServiceCacheMock.delete).toHaveBeenCalledWith("/repo/w1");
    expect(gitServiceCacheMock.delete).not.toHaveBeenCalledWith("/repo/w2");
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

    expect(gitServiceCacheMock.getGitService).not.toHaveBeenCalled();
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

  describe("WORKTREE_RETRY_PROJECT_LOAD (#8796)", () => {
    function eventWithSender(opts: { destroyed?: boolean } = {}): Electron.IpcMainInvokeEvent {
      return {
        sender: { id: 7, isDestroyed: () => opts.destroyed ?? false },
      } as unknown as Electron.IpcMainInvokeEvent;
    }

    function registerRetryHandlers(svc: {
      loadProject: ReturnType<typeof vi.fn>;
      attachDirectPort: ReturnType<typeof vi.fn>;
      getHostForProject: ReturnType<typeof vi.fn>;
      brokerPort: ReturnType<typeof vi.fn>;
    }) {
      cleanup();
      ipcHandlers.clear();
      getWindowForWebContentsMock.mockReturnValue({ id: 7 });
      cleanup = registerWorktreeHandlers({
        worktreeService: {
          loadProject: svc.loadProject,
          attachDirectPort: svc.attachDirectPort,
          getHostForProject: svc.getHostForProject,
        },
        worktreePortBroker: { brokerPort: svc.brokerPort },
      } as unknown as HandlerDependencies);
    }

    it("brokers the worktree port after a successful reload", async () => {
      const loadProject = vi.fn().mockResolvedValue(undefined);
      const attachDirectPort = vi.fn();
      const host = { hostId: "h1" };
      const getHostForProject = vi.fn().mockReturnValue(host);
      const brokerPort = vi.fn().mockReturnValue(true);
      registerRetryHandlers({ loadProject, attachDirectPort, getHostForProject, brokerPort });

      const event = eventWithSender();
      await getHandler(CHANNELS.WORKTREE_RETRY_PROJECT_LOAD)(event);

      expect(loadProject).toHaveBeenCalledWith("/repo", 7);
      expect(attachDirectPort).toHaveBeenCalledWith(7, event.sender);
      expect(brokerPort).toHaveBeenCalledWith(host, event.sender);
    });

    it("rejects when the reload succeeds but the worktree port can't be brokered", async () => {
      registerRetryHandlers({
        loadProject: vi.fn().mockResolvedValue(undefined),
        attachDirectPort: vi.fn(),
        getHostForProject: vi.fn().mockReturnValue({ hostId: "h1" }),
        brokerPort: vi.fn().mockReturnValue(false),
      });

      await expect(
        getHandler(CHANNELS.WORKTREE_RETRY_PROJECT_LOAD)(eventWithSender())
      ).rejects.toThrow(/couldn't connect to the worktree service/);
    });

    it("skips brokering when no workspace host is available, without throwing", async () => {
      const attachDirectPort = vi.fn();
      const brokerPort = vi.fn().mockReturnValue(true);
      registerRetryHandlers({
        loadProject: vi.fn().mockResolvedValue(undefined),
        attachDirectPort,
        getHostForProject: vi.fn().mockReturnValue(null),
        brokerPort,
      });

      await expect(
        getHandler(CHANNELS.WORKTREE_RETRY_PROJECT_LOAD)(eventWithSender())
      ).resolves.toBeUndefined();
      expect(attachDirectPort).toHaveBeenCalled();
      expect(brokerPort).not.toHaveBeenCalled();
    });

    it("does not attach or broker when the reload itself fails", async () => {
      const attachDirectPort = vi.fn();
      const brokerPort = vi.fn();
      registerRetryHandlers({
        loadProject: vi.fn().mockRejectedValue(new Error("project folder is gone")),
        attachDirectPort,
        getHostForProject: vi.fn().mockReturnValue({ hostId: "h1" }),
        brokerPort,
      });

      await expect(
        getHandler(CHANNELS.WORKTREE_RETRY_PROJECT_LOAD)(eventWithSender())
      ).rejects.toThrow(/project folder is gone/);
      expect(attachDirectPort).not.toHaveBeenCalled();
      expect(brokerPort).not.toHaveBeenCalled();
    });

    it("skips brokering when the sender webContents was destroyed", async () => {
      const attachDirectPort = vi.fn();
      const brokerPort = vi.fn();
      registerRetryHandlers({
        loadProject: vi.fn().mockResolvedValue(undefined),
        attachDirectPort,
        getHostForProject: vi.fn().mockReturnValue({ hostId: "h1" }),
        brokerPort,
      });

      await expect(
        getHandler(CHANNELS.WORKTREE_RETRY_PROJECT_LOAD)(eventWithSender({ destroyed: true }))
      ).resolves.toBeUndefined();
      expect(attachDirectPort).not.toHaveBeenCalled();
      expect(brokerPort).not.toHaveBeenCalled();
    });
  });
});
