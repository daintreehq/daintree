/**
 * A remote view is bound to one project, and a terminal id is not a
 * capability: the fleet snapshot hands every view every run's id. The input
 * path must refuse a remote caller any terminal its project doesn't own, using
 * main's own ownership record, while local views keep today's path untouched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { wrapSuccess } from "../../../../../shared/utils/ipcErrorSerialization.js";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: () => [] },
  webContents: { fromId: vi.fn(() => null) },
}));

vi.mock("../../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getProjectForWebContents: vi.fn(() => "project-a"),
  getAppWebContents: vi.fn(() => null),
  getAllAppWebContents: vi.fn(() => []),
  getWebContentsForProject: vi.fn(() => []),
  hasRegisteredProjectViews: vi.fn(() => true),
  isCachedViewWebContents: vi.fn(() => false),
}));

vi.mock("../../../../window/portDistribution.js", () => ({
  distributeTerminalWorkerPortToView: vi.fn(() => ({ token: "port-token" })),
  releaseTerminalWorkerPort: vi.fn(),
}));

vi.mock("../../../../services/events.js", () => ({
  events: { emit: vi.fn(), on: vi.fn(() => vi.fn()), off: vi.fn() },
}));

import { CHANNELS } from "../../../channels.js";
import { registerTerminalIOHandlers } from "../io.js";
import { _resetIpcGuardForTesting, markIpcSecurityReady } from "../../../ipcGuard.js";
import type { HandlerDependencies } from "../../../types.js";
import { getIpcDispatcher } from "../../../dispatcher.js";
import type { ClientEndpoint } from "../../../endpoint.js";
import type { IpcEnvelope } from "../../../../../shared/types/ipc/errors.js";

const OWNERS = new Map<string, string>([
  ["term-a", "project-a"],
  ["term-b", "project-b"],
]);

const ptyClient = {
  write: vi.fn(),
  sendKey: vi.fn(),
  batchDoubleEscape: vi.fn(),
  broadcastWrite: vi.fn(),
  submit: vi.fn(),
  resize: vi.fn(),
  setActivityTier: vi.fn(),
  acknowledgeData: vi.fn(),
  transitionState: vi.fn(),
  updateObservedTitle: vi.fn(),
  updateTitle: vi.fn(),
  updateWorktreeId: vi.fn(),
  forceResume: vi.fn(),
  getTerminalProjectId: vi.fn((id: string) => OWNERS.get(id) ?? null),
  getTerminalAsync: vi.fn((id: string) =>
    Promise.resolve(OWNERS.has(id) ? { id, projectId: OWNERS.get(id), hasPty: true } : null)
  ),
};

const endpoint: ClientEndpoint = {
  endpointId: "remote:-3",
  clientId: "client-b",
  projectId: "project-a",
  kind: "remote-view",
  handle: -3,
  send: vi.fn(),
  request: vi.fn(),
  onClose: () => ({ dispose: () => undefined }),
  isClosed: () => false,
};

const invocation = {
  endpoint,
  client: { clientId: "client-b", clientName: "b", platform: "darwin", kind: "remote" },
} as const;

function remoteSend(channel: string, ...args: unknown[]): void {
  getIpcDispatcher().sendForEndpoint(invocation, channel, args);
}

function remoteInvoke(channel: string, ...args: unknown[]): Promise<IpcEnvelope> {
  return getIpcDispatcher().invokeForEndpoint(invocation, channel, args);
}

function localSend(channel: string, ...args: unknown[]): void {
  const call = ipcMainMock.on.mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error(`${channel} was never registered`);
  (call[1] as (event: unknown, ...rest: unknown[]) => void)({ sender: { id: 1 } }, ...args);
}

describe("terminal input from a remote view", () => {
  let dispose: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcGuardForTesting();
    markIpcSecurityReady();
    getIpcDispatcher().setInvokeEnveloper(async (_channel, _args, call) => {
      try {
        return wrapSuccess(await call());
      } catch (error) {
        const { code, message } = error as { code?: string; message: string };
        return { ok: false, error: { code, message } } as unknown as IpcEnvelope;
      }
    });
    dispose = registerTerminalIOHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
    getIpcDispatcher().setInvokeEnveloper(null);
  });

  it("writes to a terminal the endpoint's own project owns", async () => {
    remoteSend(CHANNELS.TERMINAL_INPUT, "term-a", "ls\r");
    await vi.waitFor(() => expect(ptyClient.write).toHaveBeenCalledWith("term-a", "ls\r"));
  });

  it.each([
    ["a foreign project's terminal", "term-b"],
    ["a terminal main does not track", "term-unknown"],
  ])("refuses every input channel for %s", async (_label, id) => {
    remoteSend(CHANNELS.TERMINAL_INPUT, id, "rm -rf ~\r");
    remoteSend(CHANNELS.TERMINAL_SEND_KEY, id, "enter");
    remoteSend(CHANNELS.TERMINAL_RESIZE, { id, cols: 80, rows: 24 });
    remoteSend(CHANNELS.TERMINAL_SET_ACTIVITY_TIER, { id, tier: "active" });
    remoteSend(CHANNELS.TERMINAL_ACKNOWLEDGE_DATA, { id, length: 10 });
    remoteSend(CHANNELS.TERMINAL_AGENT_TITLE_STATE, { id, state: "working" });
    remoteSend(CHANNELS.TERMINAL_UPDATE_OBSERVED_TITLE, { id, title: "claude" });
    remoteSend(CHANNELS.TERMINAL_UPDATE_TITLE, { id, title: "x", titleMode: "user" });
    remoteSend(CHANNELS.TERMINAL_UPDATE_WORKTREE_ID, { id, worktreeId: "/repo" });
    // A marker send on an owned id proves the sends above were delivered.
    remoteSend(CHANNELS.TERMINAL_INPUT, "term-a", "marker");
    await vi.waitFor(() => expect(ptyClient.write).toHaveBeenCalledWith("term-a", "marker"));

    expect(ptyClient.write).toHaveBeenCalledTimes(1);
    for (const fn of [
      ptyClient.sendKey,
      ptyClient.resize,
      ptyClient.setActivityTier,
      ptyClient.acknowledgeData,
      ptyClient.transitionState,
      ptyClient.updateObservedTitle,
      ptyClient.updateTitle,
      ptyClient.updateWorktreeId,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("drops foreign ids from a fan-out and keeps the owned ones", async () => {
    remoteSend(CHANNELS.TERMINAL_BROADCAST_WRITE, ["term-a", "term-b"], "y");
    remoteSend(CHANNELS.TERMINAL_BATCH_DOUBLE_ESCAPE, ["term-b", "term-a", "term-unknown"]);
    await vi.waitFor(() => expect(ptyClient.batchDoubleEscape).toHaveBeenCalled());

    expect(ptyClient.broadcastWrite).toHaveBeenCalledWith(["term-a"], "y");
    expect(ptyClient.batchDoubleEscape).toHaveBeenCalledWith(["term-a"]);
  });

  it("answers a foreign submit exactly as a missing terminal, without probing it", async () => {
    const foreign = await remoteInvoke(CHANNELS.TERMINAL_SUBMIT, "term-b", "hello");
    const missing = await remoteInvoke(CHANNELS.TERMINAL_SUBMIT, "term-gone", "hello");

    expect(foreign).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(missing).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(ptyClient.getTerminalAsync).not.toHaveBeenCalledWith("term-b");
    expect(ptyClient.submit).not.toHaveBeenCalled();

    await expect(remoteInvoke(CHANNELS.TERMINAL_SUBMIT, "term-a", "hello")).resolves.toMatchObject({
      ok: true,
    });
    expect(ptyClient.submit).toHaveBeenCalledWith("term-a", "hello", undefined, undefined);
  });

  it("refuses to force-resume a foreign terminal", async () => {
    await expect(remoteInvoke(CHANNELS.TERMINAL_FORCE_RESUME, "term-b")).resolves.toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(ptyClient.forceResume).not.toHaveBeenCalled();
  });
});

describe("terminal input from a local view", () => {
  let dispose: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcGuardForTesting();
    markIpcSecurityReady();
    dispose = registerTerminalIOHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => dispose());

  it("keeps the ungated path, including ids main does not place in its project", () => {
    localSend(CHANNELS.TERMINAL_INPUT, "term-b", "ls\r");
    localSend(CHANNELS.TERMINAL_INPUT, "term-unknown", "ls\r");
    localSend(CHANNELS.TERMINAL_BROADCAST_WRITE, ["term-a", "term-b"], "y");

    expect(ptyClient.write).toHaveBeenCalledWith("term-b", "ls\r");
    expect(ptyClient.write).toHaveBeenCalledWith("term-unknown", "ls\r");
    expect(ptyClient.broadcastWrite).toHaveBeenCalledWith(["term-a", "term-b"], "y");
    expect(ptyClient.getTerminalProjectId).not.toHaveBeenCalled();
  });
});
