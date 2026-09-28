import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
const broadcastToRendererMock = vi.hoisted(() => vi.fn());
const sendToRendererMock = vi.hoisted(() => vi.fn());
const sendToRendererContextMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn().mockReturnValue(null) },
}));

vi.mock("../../utils.js", () => ({
  broadcastToRenderer: broadcastToRendererMock,
  broadcastToProjectRenderers: vi.fn(),
  sendToRenderer: sendToRendererMock,
  sendToRendererContext: sendToRendererContextMock,
  typedHandle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    handlers.set(channel, handler);
    return () => handlers.delete(channel);
  },
  typedHandleWithContext: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    handlers.set(channel, handler);
    return () => handlers.delete(channel);
  },
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn().mockReturnValue(null),
}));

const createAuthenticatedGitMock = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/hardenedGit.js", () => ({
  createAuthenticatedGit: createAuthenticatedGitMock,
}));

vi.mock("../../../services/forgeProviderRegistry.js", () => ({
  getActiveProvider: vi.fn().mockReturnValue(undefined),
  getForgeProviderImpl: vi.fn().mockReturnValue(undefined),
}));

vi.mock("child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn(), execFile: vi.fn() }));

const fsMock = vi.hoisted(() => ({
  promises: { stat: vi.fn(), access: vi.fn(), rm: vi.fn() },
}));
vi.mock("fs", () => ({ default: fsMock, ...fsMock }));

import { CHANNELS } from "../../channels.js";
import { registerGitCloneHandlers } from "../projectCrud/gitClone.js";
import {
  OperationRegistry,
  _resetOperationRegistryForTest,
} from "../../../services/operations/index.js";
import type { OperationsEvent } from "../../../../shared/types/ipc/operations.js";

interface PendingClone {
  folder: string;
  signal: AbortSignal;
  progress: (e: { stage: string; progress: number }) => void;
  resolve: () => void;
}

let pending: PendingClone[];
let events: OperationsEvent[];
let registry: OperationRegistry;

function localCtx(projectId = "project-a") {
  return {
    event: { sender: { id: 1 } },
    webContentsId: 1,
    senderWindow: null,
    projectId,
    endpoint: { kind: "local-view", isClosed: () => false },
  };
}

function remoteCtx() {
  return {
    event: null,
    webContentsId: -3,
    senderWindow: null,
    projectId: "project-a",
    endpoint: { kind: "remote-view", isClosed: () => false, send: vi.fn() },
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://github.com/owner/repo",
    parentPath: "/abs/parent",
    folderName: "repo",
    ...overrides,
  };
}

const clone = (ctx: unknown, opts: unknown) =>
  handlers.get(CHANNELS.PROJECT_CLONE_REPO)!(ctx, opts) as Promise<{ clonedPath: string }>;
const cancel = (ctx: unknown, payload?: unknown) =>
  handlers.get(CHANNELS.PROJECT_CLONE_CANCEL)!(ctx, payload);

/**
 * The handler reaches git through a dynamic `fs` import; wait for the clones to
 * start. Tests that need two live clones start them one after the other:
 * concurrent dynamic imports of a mocked module can resolve to the real one.
 */
async function started(count: number) {
  await vi.waitFor(() => expect(pending).toHaveLength(count));
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  pending = [];
  events = [];
  registry = new OperationRegistry({ emit: (_projectId, event) => events.push(event) });
  _resetOperationRegistryForTest(registry);
  fsMock.promises.stat.mockResolvedValue({ isDirectory: () => true });
  fsMock.promises.access.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  fsMock.promises.rm.mockResolvedValue(undefined);
  createAuthenticatedGitMock.mockImplementation(
    (_dir: string, opts: { signal: AbortSignal; progress: PendingClone["progress"] }) => ({
      clone: (_url: string, folder: string) =>
        new Promise<void>((resolve, reject) => {
          pending.push({ folder, signal: opts.signal, progress: opts.progress, resolve });
          opts.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
        }),
    })
  );
  registerGitCloneHandlers();
});

describe("clone as an operation", () => {
  it("joins a retry with the same opId instead of cloning twice", async () => {
    const first = clone(localCtx(), options({ opId: "op-1" }));
    const second = clone(remoteCtx(), options({ opId: "op-1" }));
    await started(1);

    expect(createAuthenticatedGitMock).toHaveBeenCalledTimes(1);
    pending[0].resolve();

    const target = path.join("/abs/parent", "repo");
    await expect(first).resolves.toEqual({ clonedPath: target });
    await expect(second).resolves.toEqual({ clonedPath: target });

    // A retry after settlement answers from the record, still without a clone.
    await expect(clone(localCtx(), options({ opId: "op-1" }))).resolves.toEqual({
      clonedPath: target,
    });
    expect(createAuthenticatedGitMock).toHaveBeenCalledTimes(1);
    expect(registry.status("op-1")).toMatchObject({
      status: "succeeded",
      result: { clonedPath: target },
    });
  });

  it("joins a second client cloning the same remote into the same destination", async () => {
    const first = clone(localCtx(), options({ opId: "op-a" }));
    const second = clone(
      remoteCtx(),
      options({ opId: "op-b", url: "https://github.com/owner/repo.git/" })
    );
    await started(1);

    expect(createAuthenticatedGitMock).toHaveBeenCalledTimes(1);
    pending[0].resolve();
    await Promise.all([first, second]);
    expect(registry.status("op-b")).toMatchObject({ status: "succeeded" });
  });

  it("starts an unnamed clone as it always did", async () => {
    const first = clone(localCtx(), options());
    await started(1);
    const second = clone(localCtx(), options());
    await started(2);

    expect(createAuthenticatedGitMock).toHaveBeenCalledTimes(2);
    pending.forEach((p) => p.resolve());
    await Promise.all([first, second]);
  });

  it("stamps the opId on clone progress and on the operation's progress events", async () => {
    const run = clone(localCtx(), options({ opId: "op-progress" }));
    await started(1);
    pending[0].progress({ stage: "receiving objects", progress: 40 });
    pending[0].resolve();
    await run;

    const cloneEvents = broadcastToRendererMock.mock.calls
      .filter(([channel]) => channel === CHANNELS.PROJECT_CLONE_PROGRESS)
      .map(([, event]) => event);
    expect(cloneEvents).toContainEqual(
      expect.objectContaining({ opId: "op-progress", stage: "receiving objects", progress: 40 })
    );
    expect(events).toContainEqual({
      type: "progress",
      progress: expect.objectContaining({
        opId: "op-progress",
        kind: "git-clone",
        stage: "receiving objects",
        fraction: 0.4,
      }),
    });
    expect(events.at(-1)).toMatchObject({
      type: "settled",
      record: { opId: "op-progress", outcome: { status: "succeeded" } },
    });
  });

  it("answers a remote caller through its endpoint, never a global broadcast", async () => {
    const ctx = remoteCtx();
    const run = clone(ctx, options({ opId: "op-remote" }));
    await started(1);
    pending[0].progress({ stage: "receiving objects", progress: 10 });
    pending[0].resolve();
    await run;

    expect(sendToRendererContextMock).toHaveBeenCalledWith(
      ctx,
      CHANNELS.PROJECT_CLONE_PROGRESS,
      expect.objectContaining({ opId: "op-remote", stage: "receiving objects" })
    );
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("cancels only the named clone", async () => {
    const a = clone(localCtx(), options({ opId: "op-a", folderName: "a" }));
    await started(1);
    const b = clone(localCtx(), options({ opId: "op-b", folderName: "b" }));
    await started(2);

    await cancel(localCtx(), { opId: "op-a" });
    await expect(a).rejects.toMatchObject({ code: "CANCELLED" });

    const other = pending.find((p) => p.folder === "b")!;
    expect(other.signal.aborted).toBe(false);
    expect(registry.status("op-b").status).toBe("running");
    other.resolve();
    await expect(b).resolves.toEqual({ clonedPath: path.join("/abs/parent", "b") });
    expect(registry.status("op-a").status).toBe("cancelled");
  });

  it("cancels through the operation registry too", async () => {
    const a = clone(localCtx(), options({ opId: "op-reg" }));
    await started(1);
    expect(registry.cancel("op-reg")).toBe(true);
    await expect(a).rejects.toMatchObject({ code: "CANCELLED" });
    expect(registry.status("op-reg").status).toBe("cancelled");
  });

  it("cancels every clone when no opId is named", async () => {
    const a = clone(localCtx(), options({ folderName: "a" }));
    await started(1);
    const b = clone(localCtx(), options({ opId: "op-b", folderName: "b" }));
    await started(2);

    await cancel(localCtx());
    await expect(a).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(b).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("lets a joined caller cancel the shared clone by its own id", async () => {
    const first = clone(localCtx(), options({ opId: "op-a" }));
    await started(1);
    const joined = clone(remoteCtx(), options({ opId: "op-b" }));

    await cancel(remoteCtx(), { opId: "op-b" });
    await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(joined).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("refuses to join a running clone that asked for a different depth", async () => {
    const first = clone(localCtx(), options({ opId: "op-a" }));
    await started(1);
    await expect(
      clone(remoteCtx(), options({ opId: "op-b", shallowClone: true }))
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(registry.status("op-b")).toEqual({ status: "unknown" });

    pending[0].resolve();
    await first;
    expect(createAuthenticatedGitMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed opId before any work", async () => {
    await expect(clone(localCtx(), options({ opId: "bad id!" }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(fsMock.promises.stat).not.toHaveBeenCalled();
    expect(registry.list()).toEqual([]);
  });
});

describe("an unnamed clone takes the path it always did", () => {
  it("records and publishes nothing, and its progress carries no opId", async () => {
    const run = clone(localCtx(), options());
    await started(1);
    pending[0].progress({ stage: "receiving objects", progress: 40 });
    pending[0].resolve();
    await run;

    expect(registry.list()).toEqual([]);
    expect(events).toEqual([]);
    const cloneEvents = broadcastToRendererMock.mock.calls
      .filter(([channel]) => channel === CHANNELS.PROJECT_CLONE_PROGRESS)
      .map(([, event]) => event as Record<string, unknown>);
    expect(cloneEvents.length).toBeGreaterThan(0);
    for (const event of cloneEvents) expect(event).not.toHaveProperty("opId");
  });

  it("is cancelled by a Stop pressed while the pre-flight checks are still running", async () => {
    let releaseStat!: () => void;
    fsMock.promises.stat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStat = () => resolve({ isDirectory: () => true });
        })
    );
    const run = clone(localCtx(), options());
    await vi.waitFor(() => expect(fsMock.promises.stat).toHaveBeenCalled());

    await cancel(localCtx());
    releaseStat();

    await expect(run).rejects.toMatchObject({ code: "CANCELLED" });
    expect(createAuthenticatedGitMock).not.toHaveBeenCalled();
    expect(fsMock.promises.rm).not.toHaveBeenCalled();
  });

  it("is cancelled through the registry during pre-flight when it was named", async () => {
    let releaseStat!: () => void;
    fsMock.promises.stat.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseStat = () => resolve({ isDirectory: () => true });
        })
    );
    const run = clone(remoteCtx(), options({ opId: "op-pre" }));
    await vi.waitFor(() => expect(fsMock.promises.stat).toHaveBeenCalled());

    await cancel(remoteCtx(), { opId: "op-pre" });
    releaseStat();

    await expect(run).rejects.toMatchObject({ code: "CANCELLED" });
    expect(createAuthenticatedGitMock).not.toHaveBeenCalled();
    expect(registry.status("op-pre").status).toBe("cancelled");
  });
});

describe("clone cancel", () => {
  async function twoClones() {
    const a = clone(localCtx(), options({ opId: "op-a", folderName: "a" }));
    await started(1);
    const b = clone(localCtx("project-b"), options({ opId: "op-b", folderName: "b" }));
    await started(2);
    return { a, b };
  }

  async function finish(runs: { a: Promise<unknown>; b: Promise<unknown> }) {
    expect(pending.every((p) => !p.signal.aborted)).toBe(true);
    pending.forEach((p) => p.resolve());
    await Promise.all([runs.a, runs.b]);
  }

  it.each([["bad id!"], [""], [42], [null]])(
    "rejects a malformed opId %j instead of cancelling every clone",
    async (opId) => {
      const runs = await twoClones();
      await expect(cancel(localCtx(), { opId })).rejects.toMatchObject({ code: "VALIDATION" });
      await finish(runs);
    }
  );

  it("never lets a remote caller cancel every clone", async () => {
    const runs = await twoClones();
    await expect(cancel(remoteCtx())).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(cancel(remoteCtx(), {})).rejects.toMatchObject({ code: "VALIDATION" });
    await finish(runs);
  });

  it("lets a remote caller cancel only its own project's clone", async () => {
    const runs = await twoClones();
    // op-b belongs to project-b; the remote caller is bound to project-a.
    await cancel(remoteCtx(), { opId: "op-b" });
    expect(pending.find((p) => p.folder === "b")!.signal.aborted).toBe(false);

    await cancel(remoteCtx(), { opId: "op-a" });
    await expect(runs.a).rejects.toMatchObject({ code: "CANCELLED" });
    pending.find((p) => p.folder === "b")!.resolve();
    await expect(runs.b).resolves.toBeDefined();
  });
});
