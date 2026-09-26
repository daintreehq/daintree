import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const { windowMock, appViews, gitMock } = vi.hoisted(() => ({
  windowMock: vi.fn<(wc: unknown) => unknown>(() => null),
  appViews: [] as Array<{
    id: number;
    isDestroyed: () => boolean;
    send: (...a: unknown[]) => void;
  }>,
  gitMock: { init: vi.fn(async () => undefined) },
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: windowMock,
  getProjectForWebContents: vi.fn(() => null),
  getAppWebContents: vi.fn((win: { wc: unknown }) => win.wc),
  getAllAppWebContents: vi.fn(() => appViews),
  getWebContentsForProject: vi.fn(() => []),
  hasRegisteredProjectViews: vi.fn(() => false),
  isCachedViewWebContents: vi.fn(() => false),
}));

vi.mock("../../../utils/hardenedGit.js", () => ({
  createHardenedGit: vi.fn(async () => gitMock),
}));

import { registerGitInitHandlers } from "../projectCrud/gitInit.js";
import { CHANNELS } from "../../channels.js";
import { getIpcDispatcher } from "../../dispatcher.js";
import { getEndpointRegistry, _resetEndpointRegistryForTesting } from "../../endpointRegistry.js";
import type { ClientEndpoint, HostFrame } from "../../endpoint.js";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const OPTIONS = { createGitignore: false, createInitialCommit: false };

function remoteEndpoint(handle: number) {
  const send = vi.fn<(frame: HostFrame) => void>();
  const endpoint: ClientEndpoint = {
    endpointId: `remote:${handle}`,
    clientId: `client-${handle}`,
    projectId: null,
    kind: "remote-view",
    handle,
    send,
    request: vi.fn(),
    onClose: () => ({ dispose: () => undefined }),
    isClosed: () => false,
  };
  return { endpoint, send };
}

function progressStatuses(calls: unknown[][]): string[] {
  return calls.map((call) => (call[1] as { status: string }).status);
}

describe("project:init-git-guided progress routing", () => {
  let directoryPath: string;
  let cleanup: () => void;

  beforeEach(async () => {
    ipcHandlers.clear();
    appViews.length = 0;
    windowMock.mockReset().mockReturnValue(null);
    _resetEndpointRegistryForTesting();
    directoryPath = await mkdtemp(path.join(os.tmpdir(), "daintree-gitinit-"));
    cleanup = registerGitInitHandlers();
  });

  afterEach(async () => {
    cleanup();
    getIpcDispatcher().setInvokeEnveloper(null);
    await rm(directoryPath, { recursive: true, force: true });
  });

  it("replies to the sending window", async () => {
    const view = { id: 5, isDestroyed: () => false, send: vi.fn() };
    const other = { id: 6, isDestroyed: () => false, send: vi.fn() };
    appViews.push(view, other);
    windowMock.mockReturnValue({ wc: view, isDestroyed: () => false });

    const handler = ipcHandlers.get(CHANNELS.PROJECT_INIT_GIT_GUIDED) as Handler;
    await handler({ sender: { id: 5 } }, { directoryPath, ...OPTIONS });

    expect(progressStatuses(view.send.mock.calls)).toEqual(["start", "success", "success"]);
    expect(other.send).not.toHaveBeenCalled();
  });

  it("still broadcasts for a local sender whose window can't be resolved", async () => {
    const view = { id: 5, isDestroyed: () => false, send: vi.fn() };
    appViews.push(view);

    const handler = ipcHandlers.get(CHANNELS.PROJECT_INIT_GIT_GUIDED) as Handler;
    await handler({ sender: { id: 5 } }, { directoryPath, ...OPTIONS });

    expect(view.send).toHaveBeenCalledTimes(3);
    expect(view.send.mock.calls[0]![0]).toBe(CHANNELS.PROJECT_INIT_GIT_PROGRESS);
  });

  it("sends a remote caller's progress to that caller alone", async () => {
    const localView = { id: 5, isDestroyed: () => false, send: vi.fn() };
    appViews.push(localView);
    const caller = remoteEndpoint(-1);
    const bystander = remoteEndpoint(-2);
    getEndpointRegistry().add(caller.endpoint);
    getEndpointRegistry().add(bystander.endpoint);
    getIpcDispatcher().setInvokeEnveloper(async (_channel, _args, call) =>
      wrapSuccess(await call())
    );

    const envelope = await getIpcDispatcher().invokeForEndpoint(
      {
        endpoint: caller.endpoint,
        client: { clientId: "client--1", clientName: "b", platform: "darwin", kind: "remote" },
      },
      CHANNELS.PROJECT_INIT_GIT_GUIDED,
      [{ directoryPath, ...OPTIONS }]
    );

    expect(envelope).toMatchObject({ ok: true, data: { outcome: "success" } });
    expect(caller.send).toHaveBeenCalledTimes(3);
    expect(
      caller.send.mock.calls.every(
        ([frame]) => frame.channel === CHANNELS.PROJECT_INIT_GIT_PROGRESS
      )
    ).toBe(true);
    expect(bystander.send).not.toHaveBeenCalled();
    expect(localView.send).not.toHaveBeenCalled();
  });
});
