/**
 * The IPC resize fallback follows the drive lease the port paths already
 * enforce: a caller whose client isn't driving the terminal's project can't
 * set its grid. With no lease service started (a local-only app) the path is
 * untouched and asks nothing about projects.
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

const ptyClient = {
  resize: vi.fn(),
  getTerminalProjectId: vi.fn((id: string) => (id === "term-a" ? "project-a" : null)),
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

function remoteResize(id: string): void {
  getIpcDispatcher().sendForEndpoint(invocation, CHANNELS.TERMINAL_RESIZE, [
    { id, cols: 100, rows: 30 },
  ]);
}

function localResize(id: string): void {
  const call = ipcMainMock.on.mock.calls.find(
    ([registered]) => registered === CHANNELS.TERMINAL_RESIZE
  );
  if (!call) throw new Error("terminal:resize was never registered");
  (call[1] as (event: unknown, ...rest: unknown[]) => void)(
    { sender: { id: 1 } },
    { id, cols: 100, rows: 30 }
  );
}

describe("terminal:resize and the drive lease", () => {
  let dispose: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    leaseRef.current = null;
    _resetIpcGuardForTesting();
    markIpcSecurityReady();
    getIpcDispatcher().setInvokeEnveloper(async (_channel, _args, call) =>
      wrapSuccess(await call())
    );
    dispose = registerTerminalIOHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
    getIpcDispatcher().setInvokeEnveloper(null);
  });

  it("leaves a local-only resize untouched when no lease service runs", () => {
    localResize("term-a");
    expect(ptyClient.resize).toHaveBeenCalledWith("term-a", 100, 30);
    expect(ptyClient.getTerminalProjectId).not.toHaveBeenCalled();
  });

  it("drops a remote resize while another client drives the project", async () => {
    const isDriving = vi.fn(() => false);
    leaseRef.current = { isDriving };
    remoteResize("term-a");
    await vi.waitFor(() => expect(isDriving).toHaveBeenCalledWith("project-a", endpoint));
    expect(ptyClient.resize).not.toHaveBeenCalled();
  });

  it("resizes for the driving client", async () => {
    leaseRef.current = { isDriving: () => true };
    remoteResize("term-a");
    await vi.waitFor(() => expect(ptyClient.resize).toHaveBeenCalledWith("term-a", 100, 30));
  });

  it("drops a local window's resize while a remote client drives", () => {
    const isDriving = vi.fn(() => false);
    leaseRef.current = { isDriving };
    localResize("term-a");
    expect(isDriving).toHaveBeenCalledWith(
      "project-a",
      expect.objectContaining({ kind: "local-view" })
    );
    expect(ptyClient.resize).not.toHaveBeenCalled();
  });
});
