/**
 * Terminal input follows the drive lease on every IPC path, the way the port
 * paths enforce it in the pty-host: only the project's driver may type or
 * submit. With no lease service started (a local-only app) nothing is asked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { wrapSuccess } from "../../../../../shared/utils/ipcErrorSerialization.js";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

const leaseRef = vi.hoisted(() => ({
  current: null as null | { isDriving: (projectId: string, ep: { clientId: string }) => boolean },
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

vi.mock("../../../../services/DriveLeaseService.js", () => ({
  peekDriveLeaseService: () => leaseRef.current,
}));

import { CHANNELS } from "../../../channels.js";
import { registerTerminalIOHandlers } from "../io.js";
import { _resetIpcGuardForTesting, markIpcSecurityReady } from "../../../ipcGuard.js";
import type { HandlerDependencies } from "../../../types.js";
import { getIpcDispatcher } from "../../../dispatcher.js";
import type { ClientEndpoint } from "../../../endpoint.js";
import type { IpcEnvelope } from "../../../../../shared/types/ipc/errors.js";

const ptyClient = {
  write: vi.fn(),
  sendKey: vi.fn(),
  batchDoubleEscape: vi.fn(),
  broadcastWrite: vi.fn(),
  submit: vi.fn(),
  getTerminalAsync: vi.fn(async () => ({ hasPty: true })),
  getTerminalProjectId: vi.fn((id: string) => (id.startsWith("term-a") ? "project-a" : null)),
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

function remoteInvoke(channel: string, ...args: unknown[]) {
  return getIpcDispatcher().invokeForEndpoint(invocation, channel, args);
}

function localSend(channel: string, ...args: unknown[]): void {
  const call = ipcMainMock.on.mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error(`${channel} was never registered`);
  (call[1] as (event: unknown, ...rest: unknown[]) => void)({ sender: { id: 1 } }, ...args);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("terminal input and the drive lease", () => {
  let dispose: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    leaseRef.current = null;
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

  it("types for a local window exactly as before when no lease service runs", () => {
    localSend(CHANNELS.TERMINAL_INPUT, "term-a", "ls\r");
    localSend(CHANNELS.TERMINAL_SEND_KEY, "term-a", "enter");
    expect(ptyClient.write).toHaveBeenCalledWith("term-a", "ls\r");
    expect(ptyClient.sendKey).toHaveBeenCalledWith("term-a", "enter");
    expect(ptyClient.getTerminalProjectId).not.toHaveBeenCalled();
  });

  it("drops a non-driver's input on every path, remote or local", async () => {
    const isDriving = vi.fn(() => false);
    leaseRef.current = { isDriving };

    remoteSend(CHANNELS.TERMINAL_INPUT, "term-a", "rm -rf\r");
    remoteSend(CHANNELS.TERMINAL_SEND_KEY, "term-a", "enter");
    remoteSend(CHANNELS.TERMINAL_BROADCAST_WRITE, ["term-a", "term-a2"], "x");
    remoteSend(CHANNELS.TERMINAL_BATCH_DOUBLE_ESCAPE, ["term-a"]);
    localSend(CHANNELS.TERMINAL_INPUT, "term-a", "y");
    await settle();

    expect(isDriving).toHaveBeenCalledWith("project-a", endpoint);
    expect(isDriving).toHaveBeenCalledWith(
      "project-a",
      expect.objectContaining({ kind: "local-view" })
    );
    expect(ptyClient.write).not.toHaveBeenCalled();
    expect(ptyClient.sendKey).not.toHaveBeenCalled();
    expect(ptyClient.broadcastWrite).not.toHaveBeenCalled();
    expect(ptyClient.batchDoubleEscape).not.toHaveBeenCalled();
  });

  it("refuses a non-driver's submit as DRIVEN_ELSEWHERE", async () => {
    leaseRef.current = { isDriving: () => false };
    const envelope = await remoteInvoke(CHANNELS.TERMINAL_SUBMIT, "term-a", "make test");
    expect(envelope.ok).toBe(false);
    expect(envelope.ok ? null : envelope.error.code).toBe("DRIVEN_ELSEWHERE");
    expect(ptyClient.submit).not.toHaveBeenCalled();
  });

  it("lets the driver type and submit", async () => {
    leaseRef.current = { isDriving: () => true };
    remoteSend(CHANNELS.TERMINAL_INPUT, "term-a", "ls\r");
    remoteSend(CHANNELS.TERMINAL_BROADCAST_WRITE, ["term-a"], "x");
    const envelope = await remoteInvoke(CHANNELS.TERMINAL_SUBMIT, "term-a", "make test");
    await settle();
    expect(envelope.ok).toBe(true);
    expect(ptyClient.write).toHaveBeenCalledWith("term-a", "ls\r");
    expect(ptyClient.broadcastWrite).toHaveBeenCalledWith(["term-a"], "x");
    expect(ptyClient.submit).toHaveBeenCalledWith("term-a", "make test", undefined, undefined);
  });
});
