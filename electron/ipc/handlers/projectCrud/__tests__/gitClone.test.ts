import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloneRepoProgressEvent } from "../../../../../shared/types/ipc/gitClone.js";

const n = (value: string) => value.replace(/\\/g, "/");

// --- Capture the registered handler ----------------------------------------
type CloneHandler = (
  ctx: { event: { sender: object } },
  options: unknown
) => Promise<{ clonedPath: string }>;

let capturedHandler: CloneHandler | null = null;
const sentEvents: CloneRepoProgressEvent[] = [];

vi.mock("../../../utils.js", () => ({
  typedHandle: vi.fn(() => () => {}),
  typedHandleWithContext: vi.fn((_channel: string, handler: CloneHandler) => {
    capturedHandler = handler;
    return () => {};
  }),
  sendToRenderer: vi.fn((_win: unknown, _channel: string, event: CloneRepoProgressEvent) => {
    sentEvents.push(event);
  }),
  broadcastToRenderer: vi.fn((_channel: string, event: CloneRepoProgressEvent) => {
    sentEvents.push(event);
  }),
}));

vi.mock("../../../channels.js", () => ({
  CHANNELS: {
    PROJECT_CLONE_REPO: "project:clone-repo",
    PROJECT_CLONE_CANCEL: "project:clone-cancel",
    PROJECT_CLONE_PROGRESS: "project:clone-progress",
  },
}));

vi.mock("../../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => ({ isDestroyed: () => false })),
}));

vi.mock("../../../../utils/errorTypes.js", () => ({
  AppError: class AppError extends Error {
    code: string;
    context: unknown;
    constructor(args: { code: string; message: string; context?: unknown; cause?: unknown }) {
      super(args.message);
      this.name = "AppError";
      this.code = args.code;
      this.context = args.context;
    }
  },
  // `gitClone.ts` now throws `GitOperationError` (extends GitError) for the
  // non-cancellation failure path. The handler reads `reason` + `op` and the
  // renderer duck-types `gitReason` across the IPC realm boundary; the mock
  // mirrors that shape so assertions like `name: "GitOperationError"` work.
  GitOperationError: class GitOperationError extends Error {
    reason: string;
    op?: string;
    rawMessage: string;
    context: unknown;
    constructor(
      reason: string,
      message: string,
      opts: { op?: string; cause?: unknown; context?: unknown } = {}
    ) {
      super(message);
      this.name = "GitOperationError";
      this.reason = reason;
      this.op = opts.op;
      this.rawMessage = message;
      this.context = opts.context;
    }
  },
}));

vi.mock("../../../../../shared/utils/gitOperationErrors.js", () => ({
  classifyGitError: () => "unknown",
  extractGitErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

// No provider matches → the handler skips the forge clone capability and
// takes the simple-git path these tests exercise.
vi.mock("../../../../services/forgeProviderRegistry.js", () => ({
  getActiveProvider: () => undefined,
  getForgeProviderImpl: () => undefined,
}));

vi.mock("../../../../../shared/utils/errorMessage.js", () => ({
  formatErrorMessage: (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback,
}));

vi.mock("../../../../../shared/utils/folderName.js", () => ({
  validateFolderName: () => null,
}));

// --- Controllable git + fs + child_process ---------------------------------
let capturedProgress: ((e: { stage: string; progress: number }) => void) | undefined;
let capturedExtraConfig: string[] | undefined;
let capturedSpawnAfter:
  ((data: unknown, ctx: { spawned?: { pid?: number } }) => unknown) | undefined;
let cloneImpl: () => Promise<unknown> = async () => undefined;

const createAuthenticatedGitMock = vi.fn(
  (_dir: string, opts: { progress?: typeof capturedProgress; extraConfig?: string[] }) => {
    capturedProgress = opts.progress;
    capturedExtraConfig = opts.extraConfig;
    return {
      _plugins: {
        append: vi.fn((_type: string, action: typeof capturedSpawnAfter) => {
          capturedSpawnAfter = action;
          return () => {};
        }),
      },
      clone: vi.fn(() => cloneImpl()),
    };
  }
);

vi.mock("../../../../utils/hardenedGit.js", () => ({
  createAuthenticatedGit: (...args: unknown[]) =>
    (createAuthenticatedGitMock as unknown as (...a: unknown[]) => unknown)(...args),
}));

// `spawnSync` is the Windows `taskkill` in `killCloneProcessTree`; it's the
// only child_process export the handler still uses.
const spawnSyncMock = vi.fn();
vi.mock("child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

const statMock = vi.fn();
const accessMock = vi.fn();
const rmMock = vi.fn();
vi.mock("fs", () => ({
  promises: {
    stat: (...a: unknown[]) => statMock(...a),
    access: (...a: unknown[]) => accessMock(...a),
    rm: (...a: unknown[]) => rmMock(...a),
  },
}));

import { registerGitCloneHandlers } from "../gitClone.js";

const VALID_OPTIONS = {
  url: "https://github.com/user/repo.git",
  parentPath: "/tmp/parent",
  folderName: "repo",
  shallowClone: false,
};

const ctx = { event: { sender: {} } };

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

const realPlatform = process.platform;

describe("registerGitCloneHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sentEvents.length = 0;
    capturedHandler = null;
    capturedProgress = undefined;
    capturedExtraConfig = undefined;
    capturedSpawnAfter = undefined;
    cloneImpl = async () => undefined;
    statMock.mockResolvedValue({ isDirectory: () => true });
    // First access() = pre-clone "already exists" check (reject → not there).
    // Second access() = post-failure "partial exists" check (resolve → there).
    accessMock.mockRejectedValueOnce(new Error("ENOENT")).mockResolvedValueOnce(undefined);
    rmMock.mockResolvedValue(undefined);
    registerGitCloneHandlers();
  });

  afterEach(() => {
    setPlatform(realPlatform);
  });

  it("passes the bundle-URI mitigation to createAuthenticatedGit", async () => {
    cloneImpl = async () => undefined;
    accessMock.mockReset();
    accessMock.mockRejectedValue(new Error("ENOENT"));
    await capturedHandler!(ctx, VALID_OPTIONS);
    expect(createAuthenticatedGitMock).toHaveBeenCalledTimes(1);
    expect(capturedExtraConfig).toContain("transfer.bundleURI=false");
  });

  it("sentence-cases git progress labels while keeping the lowercase stage", async () => {
    cloneImpl = async () => {
      capturedProgress?.({ stage: "receiving objects", progress: 42 });
      return undefined;
    };
    accessMock.mockReset();
    accessMock.mockRejectedValue(new Error("ENOENT"));

    await capturedHandler!(ctx, VALID_OPTIONS);

    const progressEvent = sentEvents.find((e) => e.stage === "receiving objects");
    expect(progressEvent).toBeDefined();
    expect(progressEvent!.message).toBe("Receiving objects: 42%");
  });

  it("kills the git process tree on Windows before cleanup after a failure", async () => {
    setPlatform("win32");
    cloneImpl = async () => {
      capturedSpawnAfter?.(undefined, { spawned: { pid: 4242 } });
      throw new Error("network boom");
    };

    await expect(capturedHandler!(ctx, VALID_OPTIONS)).rejects.toMatchObject({
      name: "GitOperationError",
      op: "clone",
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "4242"],
      expect.objectContaining({ windowsHide: true, timeout: 3000 })
    );
    // The kill must run *before* the partial-clone removal, otherwise the
    // orphaned git children still hold the .git/ file locks rm needs.
    expect(spawnSyncMock.mock.invocationCallOrder[0]).toBeLessThan(
      rmMock.mock.invocationCallOrder[0]
    );
  });

  it("emits cleanup-failed but still throws CANCELLED when an aborted clone can't be cleaned", async () => {
    cloneImpl = async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    };
    rmMock.mockRejectedValue(new Error("EBUSY"));

    await expect(capturedHandler!(ctx, VALID_OPTIONS)).rejects.toMatchObject({
      code: "CANCELLED",
    });

    expect(sentEvents.some((e) => e.stage === "cleanup-failed")).toBe(true);
    expect(sentEvents.some((e) => e.stage === "cancelled")).toBe(true);
    expect(sentEvents.some((e) => e.stage === "error")).toBe(false);
  });

  it("does not invoke taskkill on non-Windows platforms", async () => {
    setPlatform("darwin");
    cloneImpl = async () => {
      capturedSpawnAfter?.(undefined, { spawned: { pid: 4242 } });
      throw new Error("network boom");
    };

    await expect(capturedHandler!(ctx, VALID_OPTIONS)).rejects.toBeTruthy();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("emits a cleanup-failed progress event when partial cleanup fails", async () => {
    cloneImpl = async () => {
      throw new Error("network boom");
    };
    rmMock.mockRejectedValue(new Error("EBUSY"));

    await expect(capturedHandler!(ctx, VALID_OPTIONS)).rejects.toBeTruthy();

    const cleanup = sentEvents.find((e) => e.stage === "cleanup-failed");
    expect(cleanup).toBeDefined();
    expect(n(cleanup!.message)).toContain("/tmp/parent/repo");
  });

  it("does not emit cleanup-failed when partial cleanup succeeds", async () => {
    cloneImpl = async () => {
      throw new Error("network boom");
    };
    rmMock.mockResolvedValue(undefined);

    await expect(capturedHandler!(ctx, VALID_OPTIONS)).rejects.toBeTruthy();
    expect(sentEvents.some((e) => e.stage === "cleanup-failed")).toBe(false);
  });
});
