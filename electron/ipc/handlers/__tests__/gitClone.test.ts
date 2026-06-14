import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
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

const getActiveProviderMock = vi.hoisted(() => vi.fn());
const getForgeProviderImplMock = vi.hoisted(() => vi.fn());
vi.mock("../../../services/forgeProviderRegistry.js", () => ({
  getActiveProvider: getActiveProviderMock,
  getForgeProviderImpl: getForgeProviderImplMock,
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
import type { CloneCapability } from "../../../../shared/types/forge.js";

function getInvokeHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(
    ([registered]) => registered === channel
  );
  if (!call) throw new Error(`No handler registered for channel: ${channel}`);
  return call[1] as (...args: unknown[]) => Promise<unknown>;
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

function setProvider(clone: CloneCapability | undefined) {
  getActiveProviderMock.mockReturnValue({
    pluginId: "daintree.github",
    contribution: { id: "github", name: "GitHub", matches: ["github.com"] },
  });
  getForgeProviderImplMock.mockReturnValue(clone ? { clone } : {});
}

const TARGET_PATH = path.join("/abs/parent", "repo");

beforeEach(() => {
  vi.clearAllMocks();
  setFsHappyPath();
  getActiveProviderMock.mockReturnValue(undefined);
  getForgeProviderImplMock.mockReturnValue(undefined);
  createAuthenticatedGitMock.mockReturnValue({
    clone: vi.fn().mockResolvedValue(undefined),
  });
});

describe("gitClone — forge provider clone path", () => {
  it("uses the provider's cloneRepository when probeAuth reports authenticated", async () => {
    const cloneRepository = vi.fn().mockResolvedValue(undefined);
    setProvider({
      probeAuth: vi.fn().mockResolvedValue({ authenticated: true }),
      cloneRepository,
    });

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);

    const result = await handler(makeCtxEvent(), makeOptions());

    expect(getForgeProviderImplMock).toHaveBeenCalledWith("daintree.github.github");
    expect(cloneRepository).toHaveBeenCalledWith(
      "https://github.com/owner/repo",
      TARGET_PATH,
      expect.objectContaining({
        shallow: false,
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function),
      })
    );
    expect(createAuthenticatedGitMock).not.toHaveBeenCalled();
    expect(result).toEqual({ clonedPath: TARGET_PATH });

    cleanup();
  });

  it("forwards shallowClone to the capability as shallow: true", async () => {
    const cloneRepository = vi.fn().mockResolvedValue(undefined);
    setProvider({
      probeAuth: vi.fn().mockResolvedValue({ authenticated: true }),
      cloneRepository,
    });

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);

    await handler(makeCtxEvent(), makeOptions({ shallowClone: true }));

    expect(cloneRepository).toHaveBeenCalledWith(
      expect.any(String),
      TARGET_PATH,
      expect.objectContaining({ shallow: true })
    );

    cleanup();
  });

  it("relays capability progress callbacks as clone-progress events", async () => {
    setProvider({
      probeAuth: vi.fn().mockResolvedValue({ authenticated: true }),
      cloneRepository: vi.fn(
        async (_url: string, _dir: string, opts: { onProgress?: (...a: unknown[]) => void }) => {
          opts.onProgress?.("receiving", 42, "receiving: 42%");
        }
      ),
    });

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);

    await handler(makeCtxEvent(), makeOptions());

    const events = broadcastToRendererMock.mock.calls.map(
      (c) => c[1] as { stage: string; progress: number }
    );
    expect(events).toContainEqual(
      expect.objectContaining({ stage: "receiving", progress: 42, message: "receiving: 42%" })
    );

    cleanup();
  });

  it("falls back to simple-git when probeAuth reports unauthenticated", async () => {
    const cloneRepository = vi.fn();
    setProvider({
      probeAuth: vi.fn().mockResolvedValue({ authenticated: false, reason: "not signed in" }),
      cloneRepository,
    });

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);

    await handler(makeCtxEvent(), makeOptions());

    expect(cloneRepository).not.toHaveBeenCalled();
    expect(createAuthenticatedGitMock).toHaveBeenCalledOnce();

    cleanup();
  });

  it("falls back to simple-git when probeAuth rejects", async () => {
    setProvider({
      probeAuth: vi.fn().mockRejectedValue(new Error("probe blew up")),
      cloneRepository: vi.fn(),
    });

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);

    await handler(makeCtxEvent(), makeOptions());

    expect(createAuthenticatedGitMock).toHaveBeenCalledOnce();

    cleanup();
  });

  it("uses simple-git directly when no provider matches the URL", async () => {
    getActiveProviderMock.mockReturnValue(undefined);

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);

    await handler(makeCtxEvent(), makeOptions({ url: "https://gitlab.com/owner/repo" }));

    expect(getForgeProviderImplMock).not.toHaveBeenCalled();
    expect(createAuthenticatedGitMock).toHaveBeenCalledOnce();

    cleanup();
  });

  it("uses simple-git when the matching provider has no clone capability", async () => {
    setProvider(undefined);

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);

    await handler(makeCtxEvent(), makeOptions());

    expect(createAuthenticatedGitMock).toHaveBeenCalledOnce();

    cleanup();
  });

  it("clones the authenticated URL via simple-git when only getAuthenticatedCloneUrl exists", async () => {
    setProvider({
      probeAuth: vi.fn().mockResolvedValue({ authenticated: true }),
      getAuthenticatedCloneUrl: vi
        .fn()
        .mockResolvedValue("https://x-access-token:TOKEN@github.com/owner/repo"),
    });
    const gitCloneMock = vi.fn().mockResolvedValue(undefined);
    createAuthenticatedGitMock.mockReturnValue({ clone: gitCloneMock });

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);

    await handler(makeCtxEvent(), makeOptions());

    expect(gitCloneMock).toHaveBeenCalledWith(
      "https://x-access-token:TOKEN@github.com/owner/repo",
      "repo",
      []
    );

    cleanup();
  });

  it("clones the original URL when getAuthenticatedCloneUrl returns null", async () => {
    setProvider({
      probeAuth: vi.fn().mockResolvedValue({ authenticated: true }),
      getAuthenticatedCloneUrl: vi.fn().mockResolvedValue(null),
    });
    const gitCloneMock = vi.fn().mockResolvedValue(undefined);
    createAuthenticatedGitMock.mockReturnValue({ clone: gitCloneMock });

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);

    await handler(makeCtxEvent(), makeOptions());

    expect(gitCloneMock).toHaveBeenCalledWith("https://github.com/owner/repo", "repo", []);

    cleanup();
  });

  it("rejects without a simple-git fallback when cloneRepository fails", async () => {
    setProvider({
      probeAuth: vi.fn().mockResolvedValue({ authenticated: true }),
      cloneRepository: vi.fn().mockRejectedValue(new Error("gh repo clone exited with code 1")),
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

  it("cleans up the partial clone directory on capability-path failure", async () => {
    setProvider({
      probeAuth: vi.fn().mockResolvedValue({ authenticated: true }),
      cloneRepository: vi.fn().mockRejectedValue(new Error("boom")),
    });
    // First access (target exists check) rejects (ENOENT — proceed), second
    // access (partial-clone cleanup check) resolves (target exists — remove).
    let accessCallCount = 0;
    fsMock.promises.access.mockImplementation(() => {
      accessCallCount++;
      if (accessCallCount === 1) {
        return Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      }
      return Promise.resolve(undefined);
    });

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);

    await expect(handler(makeCtxEvent(), makeOptions())).rejects.toMatchObject({
      name: "GitOperationError",
      op: "clone",
    });

    expect(fsMock.promises.rm).toHaveBeenCalledWith(
      TARGET_PATH,
      expect.objectContaining({ recursive: true, force: true })
    );

    cleanup();
  });

  it("rejects with CANCELLED when the clone is cancelled mid-capability-clone", async () => {
    let observedSignal: AbortSignal | undefined;
    setProvider({
      probeAuth: vi.fn().mockResolvedValue({ authenticated: true }),
      cloneRepository: vi.fn(
        (_url: string, _dir: string, opts: { signal?: AbortSignal }) =>
          new Promise<void>((_, reject) => {
            observedSignal = opts.signal;
            opts.signal?.addEventListener("abort", () => reject(new Error("Clone cancelled")), {
              once: true,
            });
          })
      ),
    });

    const cleanup = registerGitCloneHandlers();
    const handler = getInvokeHandler(CHANNELS.PROJECT_CLONE_REPO);
    const cancelHandler = getInvokeHandler(CHANNELS.PROJECT_CLONE_CANCEL);

    const clonePromise = handler(makeCtxEvent(), makeOptions());

    // Wait a tick so the capability has been invoked and the signal captured.
    await new Promise((r) => setTimeout(r, 5));
    expect(observedSignal).toBeDefined();

    await cancelHandler(makeCtxEvent());

    await expect(clonePromise).rejects.toMatchObject({ code: "CANCELLED" });

    cleanup();
  });
});
