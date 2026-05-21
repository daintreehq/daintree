import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { EventEmitter } from "events";
import path from "node:path";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: {
    fromWebContents: vi.fn().mockReturnValue(null),
  },
}));

const broadcastToRendererMock = vi.hoisted(() => vi.fn());
const sendToRendererMock = vi.hoisted(() => vi.fn());

vi.mock("../../utils.js", () => ({
  broadcastToRenderer: broadcastToRendererMock,
  sendToRenderer: sendToRendererMock,
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
          senderWindow: null,
          projectId: null,
        };
        return (handler as (...a: unknown[]) => unknown)(ctx, ...args);
      }
    );
    return () => ipcMainMock.removeHandler(channel);
  },
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn().mockReturnValue(null),
}));

const createAuthenticatedGitMock = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/hardenedGit.js", () => ({
  createAuthenticatedGit: createAuthenticatedGitMock,
}));

const parseGitHubRepoUrlMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/github/index.js", () => ({
  parseGitHubRepoUrl: parseGitHubRepoUrlMock,
}));

const childProcessMock = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("child_process", () => childProcessMock);

const fsMock = vi.hoisted(() => ({
  promises: {
    stat: vi.fn(),
    access: vi.fn(),
    rm: vi.fn(),
  },
}));

vi.mock("fs", () => ({ default: fsMock, ...fsMock }));

import { CHANNELS } from "../../channels.js";
import { registerGitCloneHandlers } from "../projectCrud/gitClone.js";

function getInvokeHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(
    ([registered]) => registered === channel
  );
  if (!call) throw new Error(`No handler registered for channel: ${channel}`);
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

class FakeChildProcess extends EventEmitter {
  pid = 12345;
  stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
  stdout = new EventEmitter();
  kill = vi.fn();
  constructor() {
    super();
    this.stderr.setEncoding = vi.fn();
  }
}

type MakeChildOptions = {
  onSpawn?: (child: FakeChildProcess) => void;
  closeCode?: number | null;
  emitImmediately?: boolean;
};

function makeChild(opts: MakeChildOptions = {}) {
  const child = new FakeChildProcess();
  const { onSpawn, closeCode = 0, emitImmediately = true } = opts;
  if (emitImmediately) {
    // Defer to next tick so caller can attach listeners.
    queueMicrotask(() => {
      onSpawn?.(child);
      child.emit("close", closeCode);
    });
  } else {
    onSpawn?.(child);
  }
  return child;
}

function setAuthSuccess() {
  // execFile("gh", ["auth", "status"], opts, cb) — call cb with no error.
  childProcessMock.execFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
      queueMicrotask(() => cb(null));
      return new FakeChildProcess();
    }
  );
}

function setAuthFailure(err: Error = new Error("not authed")) {
  childProcessMock.execFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) => {
      queueMicrotask(() => cb(err));
      return new FakeChildProcess();
    }
  );
}

function setFsHappyPath() {
  fsMock.promises.stat.mockResolvedValue({ isDirectory: () => true });
  fsMock.promises.access.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  fsMock.promises.rm.mockResolvedValue(undefined);
}

function makeOptions(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://github.com/owner/repo",
    parentPath: "/abs/parent",
    folderName: "repo",
    shallowClone: false,
    ...overrides,
  };
}

function makeCtxEvent() {
  return { sender: { id: 1 } };
}

beforeEach(() => {
  vi.clearAllMocks();
  setFsHappyPath();
  parseGitHubRepoUrlMock.mockReturnValue({ owner: "owner", repo: "repo" });
  createAuthenticatedGitMock.mockReturnValue({
    clone: vi.fn().mockResolvedValue(undefined),
  });
});

describe("gitClone — gh repo clone fast path", () => {
  it("uses gh repo clone when URL is github.com and gh is authenticated", async () => {
    setAuthSuccess();
    let spawnedArgs: string[] | undefined;
    childProcessMock.spawn.mockImplementation((_cmd: string, args: string[]) => {
      spawnedArgs = args;
      return makeChild();
    });

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);
    const targetPath = path.join("/abs/parent", "repo");

    const result = await handler(makeCtxEvent(), makeOptions());

    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["repo", "clone", "owner/repo"]),
      expect.objectContaining({ cwd: "/abs/parent" })
    );
    expect(spawnedArgs?.slice(0, 4)).toEqual(["repo", "clone", "owner/repo", "repo"]);
    expect(createAuthenticatedGitMock).not.toHaveBeenCalled();
    expect(result).toEqual({ clonedPath: targetPath });

    cleanup();
  });

  it("falls back to simple-git when gh auth status fails", async () => {
    setAuthFailure();

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);

    await handler(makeCtxEvent(), makeOptions());

    expect(childProcessMock.spawn).not.toHaveBeenCalled();
    expect(createAuthenticatedGitMock).toHaveBeenCalledOnce();

    cleanup();
  });

  it("falls back to simple-git when gh is not on PATH (ENOENT)", async () => {
    const enoent = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    setAuthFailure(enoent);

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);

    await handler(makeCtxEvent(), makeOptions());

    expect(childProcessMock.spawn).not.toHaveBeenCalled();
    expect(createAuthenticatedGitMock).toHaveBeenCalledOnce();

    cleanup();
  });

  it("skips gh probe and uses simple-git for non-github.com URLs", async () => {
    parseGitHubRepoUrlMock.mockReturnValue(null);

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);

    await handler(makeCtxEvent(), makeOptions({ url: "https://gitlab.com/owner/repo" }));

    expect(childProcessMock.execFile).not.toHaveBeenCalled();
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
    expect(createAuthenticatedGitMock).toHaveBeenCalledOnce();

    cleanup();
  });

  it("appends -- --depth 1 to gh args when shallowClone is true", async () => {
    setAuthSuccess();
    let spawnedArgs: string[] | undefined;
    childProcessMock.spawn.mockImplementation((_cmd: string, args: string[]) => {
      spawnedArgs = args;
      return makeChild();
    });

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);

    await handler(makeCtxEvent(), makeOptions({ shallowClone: true }));

    expect(spawnedArgs).toEqual(["repo", "clone", "owner/repo", "repo", "--", "--depth", "1"]);

    cleanup();
  });

  it("emits progress for the four stage patterns on stderr", async () => {
    setAuthSuccess();

    childProcessMock.spawn.mockImplementation(() => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        child.stderr.emit(
          "data",
          "Counting objects:  50% (5/10)\rCounting objects: 100% (10/10), done.\n" +
            "Compressing objects:  75% (3/4)\rCompressing objects: 100% (4/4), done.\n" +
            "Receiving objects:  50% (5/10)\rReceiving objects: 100% (10/10), done.\n" +
            "Resolving deltas: 100% (3/3), done.\n"
        );
        child.emit("close", 0);
      });
      return child;
    });

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);

    await handler(makeCtxEvent(), makeOptions());

    const events = broadcastToRendererMock.mock.calls.map((c) => c[1] as { stage: string });
    const stages = events.map((e) => e.stage);
    expect(stages).toContain("counting");
    expect(stages).toContain("compressing");
    expect(stages).toContain("receiving");
    expect(stages).toContain("resolving");

    cleanup();
  });

  it("rejects with INTERNAL when gh repo clone exits non-zero (no simple-git fallback)", async () => {
    setAuthSuccess();
    childProcessMock.spawn.mockImplementation(() => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        child.stderr.emit("data", "fatal: repository not found\n");
        child.emit("close", 1);
      });
      return child;
    });

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);

    await expect(handler(makeCtxEvent(), makeOptions())).rejects.toMatchObject({
      name: "GitOperationError",
      op: "clone",
    });
    expect(createAuthenticatedGitMock).not.toHaveBeenCalled();

    cleanup();
  });

  it("aborts gh clone on cancel via taskkill on Windows and SIGTERM on Unix", async () => {
    setAuthSuccess();
    const realPlatform = process.platform;

    let capturedChild: FakeChildProcess | undefined;
    childProcessMock.spawn.mockImplementation(() => {
      const child = new FakeChildProcess();
      capturedChild = child;
      // Don't auto-close — we want the cancel path to drive the close.
      return child;
    });

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);
    const cancelHandler = getInvokeHandler(CHANNELS.PROJECT_CLONE_CANCEL);

    const clonePromise = handler(makeCtxEvent(), makeOptions());

    // Wait a tick so spawn has been called and the abort listener is wired.
    await new Promise((r) => setTimeout(r, 5));

    // Trigger cancel.
    await cancelHandler(makeCtxEvent());

    // Drive the close after kill.
    capturedChild?.emit("close", null);

    await expect(clonePromise).rejects.toMatchObject({ code: "CANCELLED" });

    if (realPlatform === "win32") {
      expect(childProcessMock.spawnSync).toHaveBeenCalledWith(
        "taskkill",
        expect.arrayContaining(["/F", "/T", "/PID"]),
        expect.objectContaining({ windowsHide: true })
      );
    }
    // The cleanup of partial dirs should not have been called (access returns ENOENT in happy path)
    cleanup();
  });

  it("cleans up partial clone directory on gh-path failure", async () => {
    setAuthSuccess();
    // First access (target exists check) rejects (ENOENT — proceed), second access
    // (partial-clone cleanup check) resolves (target exists — must be removed).
    let accessCallCount = 0;
    fsMock.promises.access.mockImplementation(() => {
      accessCallCount++;
      if (accessCallCount === 1) {
        return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      }
      return Promise.resolve(undefined);
    });

    childProcessMock.spawn.mockImplementation(() => makeChild({ closeCode: 128 }));

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);
    const targetPath = path.join("/abs/parent", "repo");

    await expect(handler(makeCtxEvent(), makeOptions())).rejects.toMatchObject({
      name: "GitOperationError",
      op: "clone",
    });

    expect(fsMock.promises.rm).toHaveBeenCalledWith(
      targetPath,
      expect.objectContaining({ recursive: true, force: true })
    );

    cleanup();
  });
});
