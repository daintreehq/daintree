/**
 * #11100: the cross-project ownership gate on the worker ingest port is only
 * as good as `ctx.projectId`. While that resolved through the process-global
 * ProjectViewManager, every window except the last-created one resolved null
 * and the gate failed open — a terminal in project B could be handed a live
 * ingest port to a window sitting on project A.
 *
 * These specs drive the real `defineIpcNamespace` → `typedHandleWithContext`
 * chain so the context is built by production code, not by the fixture.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

const getWindowForWebContentsMock = vi.hoisted(() =>
  vi.fn<(wc: { id: number }) => unknown>(() => null)
);
const getProjectForWebContentsMock = vi.hoisted(() =>
  vi.fn<(id: number) => string | null>(() => null)
);

vi.mock("../../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: getWindowForWebContentsMock,
  getProjectForWebContents: getProjectForWebContentsMock,
  getAppWebContents: vi.fn(() => null),
  getAllAppWebContents: vi.fn(() => []),
  getWebContentsForProject: vi.fn(() => []),
  hasRegisteredProjectViews: vi.fn(() => true),
  isCachedViewWebContents: vi.fn(() => false),
}));

const distributeTerminalWorkerPortToViewMock = vi.hoisted(() =>
  vi.fn(() => ({ token: "port-token" }))
);

vi.mock("../../../../window/portDistribution.js", () => ({
  distributeTerminalWorkerPortToView: distributeTerminalWorkerPortToViewMock,
  releaseTerminalWorkerPort: vi.fn(),
}));

import { CHANNELS } from "../../../channels.js";
import { registerTerminalIOHandlers } from "../io.js";
import { _resetIpcGuardForTesting, markIpcSecurityReady } from "../../../ipcGuard.js";
import type { HandlerDependencies } from "../../../types.js";

const WINDOW_A = 1;
const WINDOW_B = 2;
const SENDER_A = 101;
const SENDER_B = 202;

/** Window A is on project A; window B — created later — is on project B. */
const VIEW_TO_PROJECT = new Map([
  [SENDER_A, "project-a"],
  [SENDER_B, "project-b"],
]);

/** Terminal "term-b" belongs to project B, i.e. to window B. */
const TERMINALS = new Map([
  ["term-a", { id: "term-a", projectId: "project-a" }],
  ["term-b", { id: "term-b", projectId: "project-b" }],
  ["term-unowned", { id: "term-unowned", projectId: null }],
]);

function buildDeps(): HandlerDependencies {
  const windowContexts = new Map([
    [WINDOW_A, { windowId: WINDOW_A, services: {} }],
    [WINDOW_B, { windowId: WINDOW_B, services: {} }],
  ]);

  return {
    ptyClient: {
      getTerminalAsync: vi.fn((id: string) => Promise.resolve(TERMINALS.get(id) ?? null)),
    },
    windowRegistry: {
      getByWindowId: (id: number) => windowContexts.get(id),
    },
  } as unknown as HandlerDependencies;
}

/** Invoke the registered ingest-port handler as the given renderer. */
function requestIngestPort(senderId: number, terminalId: string): Promise<unknown> {
  const call = ipcMainMock.handle.mock.calls.find(
    ([channel]) => channel === CHANNELS.TERMINAL_REQUEST_WORKER_INGEST_PORT
  );
  if (!call) throw new Error("ingest-port handler was never registered");
  const registered = call[1] as (...args: unknown[]) => Promise<unknown>;
  return registered({ sender: { id: senderId } }, terminalId);
}

describe("terminal worker ingest port — cross-project ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcGuardForTesting();
    markIpcSecurityReady();

    getProjectForWebContentsMock.mockImplementation((id) => VIEW_TO_PROJECT.get(id) ?? null);
    getWindowForWebContentsMock.mockImplementation((wc) =>
      wc.id === SENDER_A ? { id: WINDOW_A } : { id: WINDOW_B }
    );
    distributeTerminalWorkerPortToViewMock.mockReturnValue({ token: "port-token" });

    registerTerminalIOHandlers(buildDeps());
  });

  it("refuses to mint a port for a terminal owned by another window's project", async () => {
    await expect(requestIngestPort(SENDER_A, "term-b")).resolves.toBeNull();
    expect(distributeTerminalWorkerPortToViewMock).not.toHaveBeenCalled();
  });

  it("mints a port for a terminal the sender's own project owns", async () => {
    await expect(requestIngestPort(SENDER_B, "term-b")).resolves.toEqual({ token: "port-token" });
    expect(distributeTerminalWorkerPortToViewMock).toHaveBeenCalledOnce();
  });

  it("both windows are served their own terminal in the same session", async () => {
    const [a, b] = await Promise.all([
      requestIngestPort(SENDER_A, "term-a"),
      requestIngestPort(SENDER_B, "term-b"),
    ]);

    expect(a).toEqual({ token: "port-token" });
    expect(b).toEqual({ token: "port-token" });
    expect(distributeTerminalWorkerPortToViewMock).toHaveBeenCalledTimes(2);
  });

  it("serves an unbound window its own projectless terminal", async () => {
    // A Cmd+N window sits on the project picker: its view is deliberately never
    // registered, so its context project is null, and the default terminal it
    // spawns carries no owner either. Null must match null, or these windows
    // lose their dedicated port for no reason.
    getProjectForWebContentsMock.mockReturnValue(null);

    await expect(requestIngestPort(SENDER_A, "term-unowned")).resolves.toEqual({
      token: "port-token",
    });
    expect(distributeTerminalWorkerPortToViewMock).toHaveBeenCalledOnce();
  });

  // The two asymmetric cases. Null is an identity, not a wildcard: the pty-host
  // skips its per-window filter entirely when a window's project is null, so a
  // port minted for either mismatch would be fed real bytes.
  it("refuses a null-context sender a project-owned terminal", async () => {
    getProjectForWebContentsMock.mockReturnValue(null);

    await expect(requestIngestPort(SENDER_A, "term-b")).resolves.toBeNull();
    expect(distributeTerminalWorkerPortToViewMock).not.toHaveBeenCalled();
  });

  it("refuses a project-bound sender an unowned terminal", async () => {
    await expect(requestIngestPort(SENDER_A, "term-unowned")).resolves.toBeNull();
    expect(distributeTerminalWorkerPortToViewMock).not.toHaveBeenCalled();
  });

  it("returns null for a terminal that no longer exists", async () => {
    await expect(requestIngestPort(SENDER_A, "gone")).resolves.toBeNull();
    expect(distributeTerminalWorkerPortToViewMock).not.toHaveBeenCalled();
  });
});
