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

const getWindowForWebContentsMock = vi.hoisted(() =>
  vi.fn<(wc: { id: number }) => unknown>(() => null)
);
const getProjectForWebContentsMock = vi.hoisted(() =>
  vi.fn<(id: number) => string | null>(() => null)
);
const { cachedViewIds, viewsByProject } = vi.hoisted(() => ({
  cachedViewIds: new Set<number>(),
  viewsByProject: new Map<string, number[]>(),
}));

vi.mock("../../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: getWindowForWebContentsMock,
  getProjectForWebContents: getProjectForWebContentsMock,
  getAppWebContents: vi.fn(() => null),
  getAllAppWebContents: vi.fn(() => []),
  getWebContentsForProject: vi.fn((projectId: string) =>
    (viewsByProject.get(projectId) ?? []).map((id) => ({ id }))
  ),
  hasRegisteredProjectViews: vi.fn(() => true),
  isCachedViewWebContents: vi.fn((id: number) => cachedViewIds.has(id)),
}));

const distributeTerminalWorkerPortToViewMock = vi.hoisted(() =>
  vi.fn(() => ({ token: "port-token" }))
);

vi.mock("../../../../window/portDistribution.js", () => ({
  distributeTerminalWorkerPortToView: distributeTerminalWorkerPortToViewMock,
  releaseTerminalWorkerPort: vi.fn(),
}));

const emitMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../services/events.js", () => ({
  events: { emit: emitMock, on: vi.fn(() => vi.fn()), off: vi.fn() },
}));

vi.mock("../../../../services/DriveLeaseService.js", () => ({
  peekDriveLeaseService: () => leaseRef.current,
}));

import { CHANNELS } from "../../../channels.js";
import { registerTerminalIOHandlers } from "../io.js";
import { _resetIpcGuardForTesting, markIpcSecurityReady } from "../../../ipcGuard.js";
import type { HandlerDependencies } from "../../../types.js";
import { _resetIpcDispatcherForTesting, getIpcDispatcher } from "../../../dispatcher.js";
import type { ClientEndpoint } from "../../../endpoint.js";
import type { IpcEnvelope } from "../../../../../shared/types/ipc/errors.js";

// Every block registers the handlers against its own fake ptyClient. A fresh
// dispatcher keeps one block's send listeners from answering another's, and
// the shared doubles start each test from their factory defaults.
beforeEach(() => {
  _resetIpcDispatcherForTesting();
  leaseRef.current = null;
  getWindowForWebContentsMock.mockReset();
  getProjectForWebContentsMock.mockReset();
  distributeTerminalWorkerPortToViewMock.mockReset();
  cachedViewIds.clear();
  viewsByProject.clear();
});

/**
 * A remote view is bound to one project, and a terminal id is not a
 * capability: the fleet snapshot hands every view every run's id. The input
 * path must refuse a remote caller any terminal its project doesn't own, using
 * main's own ownership record, while local views keep today's path untouched.
 */
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

    expect(ptyClient.broadcastWrite).toHaveBeenCalledWith(["term-a"], "y", false);
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
    expect(ptyClient.broadcastWrite).toHaveBeenCalledWith(["term-a", "term-b"], "y", false);
    expect(ptyClient.getTerminalProjectId).not.toHaveBeenCalled();
  });
});

/**
 * Terminal input follows the drive lease on every IPC path, the way the port
 * paths enforce it in the pty-host: only the project's driver may type or
 * submit. With no lease service started (a local-only app) nothing is asked.
 */
describe("terminal input and the drive lease", () => {
  const ptyClient = {
    write: vi.fn(),
    sendKey: vi.fn(),
    batchDoubleEscape: vi.fn(),
    broadcastWrite: vi.fn(),
    submit: vi.fn(),
    getTerminalAsync: vi.fn(async () => ({ hasPty: true })),
    getTerminalProjectId: vi.fn((id: string) => (id.startsWith("term-a") ? "project-a" : null)),
  };

  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

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
    expect(ptyClient.broadcastWrite).toHaveBeenCalledWith(["term-a"], "x", false);
    expect(ptyClient.submit).toHaveBeenCalledWith("term-a", "make test", undefined, undefined);
  });
});

/**
 * The IPC resize fallback follows the drive lease the port paths already
 * enforce: a caller whose client isn't driving the terminal's project can't
 * set its grid. With no lease service started (a local-only app) the path is
 * untouched and asks nothing about projects.
 */
describe("terminal:resize and the drive lease", () => {
  const ptyClient = {
    resize: vi.fn(),
    getTerminalProjectId: vi.fn((id: string) => (id === "term-a" ? "project-a" : null)),
  };

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

/**
 * #12060: the fleet palette groups runs by the pty-host's copy of `worktreeId`,
 * and nothing re-stamps that copy after spawn. This channel is the hop that
 * carries a cross-worktree move to it.
 *
 * The contract these specs pin is the one the issue is explicit about: there is
 * no silent fallback. `null` is the ONLY way to say "this run now has no
 * worktree", a malformed payload is dropped rather than guessed at, and nothing
 * here substitutes a project root, the active worktree, or the previous id for
 * a value that failed validation.
 */
describe("terminal:update-worktree-id", () => {
  const updateWorktreeId = vi.fn();

  function buildDeps(): HandlerDependencies {
    return {
      ptyClient: {
        updateWorktreeId,
        getTerminalAsync: vi.fn(() => Promise.resolve(null)),
        // Main's spawn record for the one run a remote view owns in these specs.
        getTerminalProjectId: vi.fn((id: string) => (id === "t1" ? "project-remote" : null)),
      },
      windowRegistry: { getByWindowId: () => undefined },
    } as unknown as HandlerDependencies;
  }

  /** Deliver a payload on the worktree channel exactly as the preload would. */
  function send(payload: unknown): void {
    const call = ipcMainMock.on.mock.calls.find(
      ([channel]) => channel === CHANNELS.TERMINAL_UPDATE_WORKTREE_ID
    );
    if (!call) throw new Error("worktree-update handler was never registered");
    const registered = call[1] as (event: unknown, payload: unknown) => void;
    registered({ sender: { id: 1 } }, payload);
  }

  let dispose: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcGuardForTesting();
    markIpcSecurityReady();
    getProjectForWebContentsMock.mockReturnValue("project-a");
    dispose = registerTerminalIOHandlers(buildDeps());
  });

  afterEach(() => {
    dispose();
    getIpcDispatcher().setInvokeEnveloper(null);
  });

  it("re-files a run onto a real worktree id", () => {
    send({ id: "t1", worktreeId: "/repo/.worktrees/feature" });

    expect(updateWorktreeId).toHaveBeenCalledWith("t1", "/repo/.worktrees/feature", "project-a");
  });

  it("names the sender's own project so the host can refuse a foreign terminal", () => {
    // The fleet snapshot hands every view every run's id, so a terminal id is
    // not a capability. Resolving the sender's project here is what lets the
    // record refuse a write from a renderer that does not own the run.
    getProjectForWebContentsMock.mockReturnValue("project-b");

    send({ id: "t1", worktreeId: "/repo" });

    expect(updateWorktreeId).toHaveBeenCalledWith("t1", "/repo", "project-b");
  });

  it("passes an unbound window's null project through as an identity", () => {
    // Null is not a wildcard: it has to reach the record as null so a
    // project-picker window matches only its own projectless terminals.
    getProjectForWebContentsMock.mockReturnValue(null);

    send({ id: "t1", worktreeId: "/repo" });

    expect(updateWorktreeId).toHaveBeenCalledWith("t1", "/repo", null);
  });

  it("forwards the id verbatim rather than canonicalizing the path", () => {
    // A worktree id is a path, and the same path has more than one spelling.
    // Re-deriving one here would file the run under an id the renderer does not
    // recognize as the worktree the user dragged it to.
    const id = "/Repo/../repo/.worktrees/feature/";
    send({ id: "t1", worktreeId: id });

    expect(updateWorktreeId).toHaveBeenCalledWith("t1", id, "project-a");
  });

  it("treats null as an explicit clear", () => {
    // The one path that really leaves a panel with no worktree: undoing a
    // dock-to-grid move deletes the id the pane adopted on its way to the grid.
    send({ id: "t1", worktreeId: null });

    expect(updateWorktreeId).toHaveBeenCalledWith("t1", null, "project-a");
  });

  it.each([
    ["a missing field", { id: "t1" }],
    ["undefined", { id: "t1", worktreeId: undefined }],
    ["an empty string", { id: "t1", worktreeId: "" }],
    ["whitespace only", { id: "t1", worktreeId: "   " }],
    ["a number", { id: "t1", worktreeId: 7 }],
    ["an object", { id: "t1", worktreeId: { path: "/repo" } }],
    ["a blank terminal id", { id: "", worktreeId: "/repo" }],
    ["a whitespace-only terminal id", { id: "   ", worktreeId: "/repo" }],
    ["a non-string terminal id", { id: 3, worktreeId: "/repo" }],
    ["no payload at all", undefined],
  ])("drops %s instead of guessing at it", (_label, payload) => {
    send(payload);

    expect(updateWorktreeId).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("announces the change so the palette regroups before the next poll", () => {
    send({ id: "t1", worktreeId: "/repo" });

    expect(emitMock).toHaveBeenCalledWith(
      "terminal:worktree-changed",
      expect.objectContaining({ id: "t1" })
    );
  });

  it("unhooks the listener on teardown so a re-register cannot double-apply", () => {
    // A leaked listener would apply every move twice — harmless for a set, but
    // it would also emit two fleet recomputes per drag.
    const listener = ipcMainMock.on.mock.calls.find(
      ([channel]) => channel === CHANNELS.TERMINAL_UPDATE_WORKTREE_ID
    )?.[1];

    dispose();

    expect(ipcMainMock.removeListener).toHaveBeenCalledWith(
      CHANNELS.TERMINAL_UPDATE_WORKTREE_ID,
      listener
    );
  });
  it("attributes a move sent over a link to the endpoint's own project", async () => {
    getIpcDispatcher().setInvokeEnveloper(async (_channel, _args, call) => {
      await call();
      return wrapSuccess(undefined);
    });
    const endpoint: ClientEndpoint = {
      endpointId: "remote:-3",
      clientId: "client-b",
      projectId: "project-remote",
      kind: "remote-view",
      handle: -3,
      send: vi.fn(),
      request: vi.fn(),
      onClose: () => ({ dispose: () => undefined }),
      isClosed: () => false,
    };

    getIpcDispatcher().sendForEndpoint(
      {
        endpoint,
        client: { clientId: "client-b", clientName: "b", platform: "darwin", kind: "remote" },
      },
      CHANNELS.TERMINAL_UPDATE_WORKTREE_ID,
      [{ id: "t1", worktreeId: "/repo/wt" }]
    );

    await vi.waitFor(() => {
      expect(updateWorktreeId).toHaveBeenCalledWith("t1", "/repo/wt", "project-remote");
    });
    expect(updateWorktreeId).toHaveBeenCalledTimes(1);
    expect(getProjectForWebContentsMock).not.toHaveBeenCalled();
  });
});

/**
 * #12792: `terminal:submit` carries the composer's image chips as an optional
 * trailing argument. Drives the real `defineIpcNamespace` registration.
 */
describe("terminal:submit image paths (#12792)", () => {
  const getTerminalAsync = vi.fn();
  const submit = vi.fn();

  function buildDeps(): HandlerDependencies {
    return {
      ptyClient: { getTerminalAsync, submit },
      windowRegistry: { getByWindowId: () => undefined },
    } as unknown as HandlerDependencies;
  }

  function submitViaIpc(...args: unknown[]): Promise<unknown> {
    const call = ipcMainMock.handle.mock.calls.find(
      ([channel]) => channel === CHANNELS.TERMINAL_SUBMIT
    );
    if (!call) throw new Error("submit handler was never registered");
    const registered = call[1] as (...handlerArgs: unknown[]) => Promise<unknown>;
    return registered({ sender: { id: 1 } }, ...args);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcGuardForTesting();
    markIpcSecurityReady();
    getTerminalAsync.mockResolvedValue({ id: "term-1", hasPty: true });
    registerTerminalIOHandlers(buildDeps());
  });

  it("forwards image paths to the pty-host", async () => {
    await submitViaIpc("term-1", "see /a/shot.png", undefined, undefined, ["/a/shot.png"]);

    expect(submit).toHaveBeenCalledWith(
      "term-1",
      "see /a/shot.png",
      undefined,
      undefined,
      undefined,
      ["/a/shot.png"]
    );
  });

  it("keeps the existing call shape when no images ride along", async () => {
    await submitViaIpc("term-1", "hello");

    expect(submit).toHaveBeenCalledWith("term-1", "hello", undefined, undefined);
  });

  it.each([
    ["a non-array", "/a/shot.png"],
    ["a relative path", ["shot.png"]],
    ["a non-image", ["/a/notes.txt"]],
    ["a UNC share", ["\\\\server\\share\\shot.png"]],
    ["a non-string", [42]],
    ["too many paths", Array.from({ length: 33 }, (_, i) => `/a/${i}.png`)],
  ])("refuses %s without writing anything", async (_label, imagePaths) => {
    await expect(
      submitViaIpc("term-1", "text", undefined, undefined, imagePaths)
    ).rejects.toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });
});

/**
 * #12514: a cached view demotes its terminals to "background" through the
 * activity-tier IPC, and the pty-host keeps one cadence per terminal (last
 * writer wins). The same project can be open in two windows, so a cached view
 * must not demote terminals another window is still showing.
 */
describe("terminal activity tier — cached sender with a visible sibling", () => {
  /** Window A shows project P; window B has P cached behind another project. */
  const VISIBLE_P = 101;
  const CACHED_P = 202;

  const TERMINAL_PROJECTS = new Map<string, string | null>([
    ["term-p", "project-p"],
    ["term-unowned", null],
  ]);

  const setActivityTier = vi.fn();
  const getTerminalProjectId = vi.fn((id: string) => TERMINAL_PROJECTS.get(id) ?? null);

  function setTier(
    senderId: number,
    payload: { id: string; tier: "active" | "background"; pollingIntervalMs?: number }
  ): void {
    const call = ipcMainMock.on.mock.calls.find(
      ([channel]) => channel === CHANNELS.TERMINAL_SET_ACTIVITY_TIER
    );
    if (!call) throw new Error("activity-tier handler was never registered");
    const handler = call[1] as (...args: unknown[]) => void;
    handler({ sender: { id: senderId } }, payload);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcGuardForTesting();
    markIpcSecurityReady();
    cachedViewIds.clear();
    cachedViewIds.add(CACHED_P);
    viewsByProject.clear();
    viewsByProject.set("project-p", [VISIBLE_P, CACHED_P]);

    registerTerminalIOHandlers({
      ptyClient: { setActivityTier, getTerminalProjectId },
    } as unknown as HandlerDependencies);
  });

  it("drops a cached view's demotion while another window shows the project", () => {
    setTier(CACHED_P, { id: "term-p", tier: "background", pollingIntervalMs: 1000 });

    expect(setActivityTier).not.toHaveBeenCalled();
  });

  it("forwards a cached view's demotion once no other view of the project is visible", () => {
    cachedViewIds.add(VISIBLE_P);

    setTier(CACHED_P, { id: "term-p", tier: "background", pollingIntervalMs: 1000 });

    expect(setActivityTier).toHaveBeenCalledWith("term-p", "background", 1000);
  });

  it("forwards a cached view's demotion when it is the project's only view", () => {
    viewsByProject.set("project-p", [CACHED_P]);

    setTier(CACHED_P, { id: "term-p", tier: "background" });

    expect(setActivityTier).toHaveBeenCalledWith("term-p", "background", undefined);
  });

  it("forwards a demotion from a view that is not cached", () => {
    setTier(VISIBLE_P, { id: "term-p", tier: "background", pollingIntervalMs: 200 });

    expect(setActivityTier).toHaveBeenCalledWith("term-p", "background", 200);
  });

  it("forwards a promotion from a cached view", () => {
    setTier(CACHED_P, { id: "term-p", tier: "active" });

    expect(setActivityTier).toHaveBeenCalledWith("term-p", "active", undefined);
  });

  it("forwards a cached view's demotion of a terminal with no known project", () => {
    setTier(CACHED_P, { id: "term-unowned", tier: "background" });

    expect(getTerminalProjectId).toHaveBeenCalledWith("term-unowned");
    expect(setActivityTier).toHaveBeenCalledWith("term-unowned", "background", undefined);
  });
});

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
describe("terminal worker ingest port — cross-project ownership", () => {
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

/**
 * #12337: `terminal:get-submissions` resolves one submission token against a
 * set of terminals. It is a read on behalf of a renderer, so it carries the
 * same cross-project ownership gate the ingest port does — a window must not
 * be able to probe a terminal belonging to another project, and the routing is
 * as much of the answer as the payload is.
 *
 * Drives the real `defineIpcNamespace` → `typedHandleWithContext` chain so the
 * context is built by production code, not by the fixture.
 */
describe("terminal:get-submissions (#12337)", () => {
  const SENDER_A = 101;
  const SENDER_B = 202;

  const VIEW_TO_PROJECT = new Map([
    [SENDER_A, "project-a"],
    [SENDER_B, "project-b"],
  ]);

  const TERMINAL_OWNERS = new Map<string, string | null>([
    ["term-a", "project-a"],
    ["term-b", "project-b"],
    ["term-unowned", null],
  ]);

  const getTerminalAsync = vi.fn();
  const getTerminalProjectId = vi.fn((id: string) => TERMINAL_OWNERS.get(id) ?? null);
  const getTerminalsForProjectAsync = vi.fn(async (_projectId: string): Promise<string[]> => []);

  function buildDeps(): HandlerDependencies {
    return {
      ptyClient: { getTerminalAsync, getTerminalProjectId, getTerminalsForProjectAsync },
      windowRegistry: { getByWindowId: () => undefined },
    } as unknown as HandlerDependencies;
  }

  function getSubmissions(
    senderId: number,
    terminalIds: unknown,
    submissionToken: unknown
  ): Promise<unknown> {
    const call = ipcMainMock.handle.mock.calls.find(
      ([channel]) => channel === CHANNELS.TERMINAL_GET_SUBMISSIONS
    );
    if (!call) throw new Error("get-submissions handler was never registered");
    const registered = call[1] as (...args: unknown[]) => Promise<unknown>;
    return registered({ sender: { id: senderId } }, terminalIds, submissionToken);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcGuardForTesting();
    markIpcSecurityReady();
    getProjectForWebContentsMock.mockImplementation((id) => VIEW_TO_PROJECT.get(id) ?? null);
    getTerminalProjectId.mockImplementation((id: string) => TERMINAL_OWNERS.get(id) ?? null);
    getTerminalsForProjectAsync.mockResolvedValue([]);
    getTerminalAsync.mockImplementation(async (id: string, token?: string) => ({
      id,
      projectId: TERMINAL_OWNERS.get(id) ?? undefined,
      submission: token === undefined ? undefined : { token, phase: "pty_written", at: 7 },
    }));
    registerTerminalIOHandlers(buildDeps());
  });

  it("resolves a token for a terminal the sender's own project owns", async () => {
    await expect(getSubmissions(SENDER_A, ["term-a"], "tok-1")).resolves.toEqual({
      "term-a": { status: "found", record: { token: "tok-1", phase: "pty_written", at: 7 } },
    });
    expect(getTerminalAsync).toHaveBeenCalledWith("term-a", "tok-1");
  });

  it("never routes an RPC for a terminal owned by another project", async () => {
    const result = await getSubmissions(SENDER_A, ["term-b"], "tok-1");

    // `unreadable`, and identical to what an id this host never heard of gets:
    // the reply shape must not tell a caller which foreign ids exist. The
    // lookup must also never reach that terminal's shard.
    expect(result).toEqual({ "term-b": { status: "unreadable" } });
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("never serves an unbound sender a record another project owns once main forgot its owner", async () => {
    // Main's null for an exited terminal matches an unbound sender's null
    // project; the record's own owner is what refuses it.
    getProjectForWebContentsMock.mockReturnValue(null);
    getTerminalProjectId.mockReturnValue(null);
    getTerminalAsync.mockResolvedValue({
      id: "term-exited",
      projectId: "project-a",
      submission: { token: "tok-1", phase: "pty_written", at: 7 },
    });

    await expect(getSubmissions(SENDER_A, ["term-exited"], "tok-1")).resolves.toEqual({
      "term-exited": { status: "unreadable" },
    });
  });

  it("tells the three outcomes apart within one batch", async () => {
    getTerminalProjectId.mockReturnValue("project-a");
    getTerminalAsync.mockImplementation(async (id: string, token?: string) => {
      if (id === "term-gone") return null;
      if (id === "term-empty") return { id, projectId: "project-a", submission: undefined };
      return { id, projectId: "project-a", submission: { token, phase: "pty_written", at: 7 } };
    });

    await expect(
      getSubmissions(SENDER_A, ["term-a", "term-empty", "term-gone"], "tok-1")
    ).resolves.toEqual({
      "term-a": { status: "found", record: { token: "tok-1", phase: "pty_written", at: 7 } },
      "term-empty": { status: "absent" },
      "term-gone": { status: "unreadable" },
    });
  });

  it("gives an unknown id the same answer a foreign one gets", async () => {
    // Both are `unreadable` and neither is routed, so the reply cannot be used
    // to probe which terminals exist outside the caller's project.
    const foreign = await getSubmissions(SENDER_A, ["term-b"], "tok-1");
    // Only the RPC spy is reset — `vi.clearAllMocks()` would also wipe the
    // `ipcMain.handle` call record the helper resolves the handler through.
    getTerminalAsync.mockClear();
    const unknown = await getSubmissions(SENDER_A, ["term-never-existed"], "tok-1");

    expect(foreign).toEqual({ "term-b": { status: "unreadable" } });
    expect(unknown).toEqual({ "term-never-existed": { status: "unreadable" } });
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("serves each project its own terminal in the same session", async () => {
    const [a, b] = await Promise.all([
      getSubmissions(SENDER_A, ["term-a", "term-b"], "tok-1"),
      getSubmissions(SENDER_B, ["term-a", "term-b"], "tok-2"),
    ]);

    expect(a).toEqual({
      "term-a": { status: "found", record: { token: "tok-1", phase: "pty_written", at: 7 } },
      "term-b": { status: "unreadable" },
    });
    expect(b).toEqual({
      "term-a": { status: "unreadable" },
      "term-b": { status: "found", record: { token: "tok-2", phase: "pty_written", at: 7 } },
    });
  });

  it("deduplicates repeated ids into one RPC", async () => {
    await getSubmissions(SENDER_A, ["term-a", "term-a", "term-a"], "tok-1");

    expect(getTerminalAsync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty", ""],
    ["missing", undefined],
    ["non-string", 42],
    ["over the length bound", "x".repeat(129)],
  ])("rejects a %s token as VALIDATION without reading anything", async (_label, token) => {
    // The preload is reachable without the action's own schema, so these bounds
    // have to hold here too rather than only on the MCP surface.
    await expect(getSubmissions(SENDER_A, ["term-a"], token)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("accepts a token exactly at the length bound", async () => {
    const token = "x".repeat(128);
    await expect(getSubmissions(SENDER_A, ["term-a"], token)).resolves.toEqual({
      "term-a": { status: "found", record: { token, phase: "pty_written", at: 7 } },
    });
  });

  it("rejects a non-array id list", async () => {
    await expect(getSubmissions(SENDER_A, "term-a", "tok-1")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("rejects an oversized id list instead of silently dropping the tail", async () => {
    // Truncating would answer `unreadable` for ids the caller asked about and
    // give it no way to learn that its request was clipped.
    const ids = Array.from({ length: 257 }, (_, i) => `term-${i}`);
    getTerminalProjectId.mockReturnValue("project-a");

    await expect(getSubmissions(SENDER_A, ids, "tok-1")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("serves a list right at the bound", async () => {
    const ids = Array.from({ length: 256 }, (_, i) => `term-${i}`);
    getTerminalProjectId.mockReturnValue("project-a");

    await getSubmissions(SENDER_A, ids, "tok-1");

    expect(getTerminalAsync).toHaveBeenCalledTimes(256);
  });
});

/**
 * #12495: `terminal:get-output-activity` reads `lastOutputChangeAt` for the
 * renderer's `terminal.getStatus` when the caller asked for output. It carries
 * the same cross-project ownership gate as submission lookup — the routing is
 * as much of the answer as the payload is.
 *
 * Drives the real `defineIpcNamespace` → `typedHandleWithContext` chain so the
 * context is built by production code, not by the fixture.
 */
describe("terminal:get-output-activity (#12495)", () => {
  const SENDER_A = 101;
  const SENDER_B = 202;

  const VIEW_TO_PROJECT = new Map([
    [SENDER_A, "project-a"],
    [SENDER_B, "project-b"],
  ]);

  const TERMINAL_OWNERS = new Map<string, string | null>([
    ["term-a", "project-a"],
    ["term-b", "project-b"],
    ["term-unowned", null],
  ]);

  const getTerminalAsync = vi.fn();
  const getTerminalProjectId = vi.fn((id: string) => TERMINAL_OWNERS.get(id) ?? null);
  const getTerminalsForProjectAsync = vi.fn(async (_projectId: string): Promise<string[]> => []);

  function buildDeps(): HandlerDependencies {
    return {
      ptyClient: { getTerminalAsync, getTerminalProjectId, getTerminalsForProjectAsync },
      windowRegistry: { getByWindowId: () => undefined },
    } as unknown as HandlerDependencies;
  }

  function getOutputActivity(senderId: number, terminalIds: unknown): Promise<unknown> {
    const call = ipcMainMock.handle.mock.calls.find(
      ([channel]) => channel === CHANNELS.TERMINAL_GET_OUTPUT_ACTIVITY
    );
    if (!call) throw new Error("get-output-activity handler was never registered");
    const registered = call[1] as (...args: unknown[]) => Promise<unknown>;
    return registered({ sender: { id: senderId } }, terminalIds);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcGuardForTesting();
    markIpcSecurityReady();
    getProjectForWebContentsMock.mockImplementation((id) => VIEW_TO_PROJECT.get(id) ?? null);
    getTerminalProjectId.mockImplementation((id: string) => TERMINAL_OWNERS.get(id) ?? null);
    getTerminalsForProjectAsync.mockResolvedValue([]);
    getTerminalAsync.mockImplementation(async (id: string) => ({
      id,
      projectId: TERMINAL_OWNERS.get(id) ?? undefined,
      lastOutputChangeAt: 5_000,
    }));
    registerTerminalIOHandlers(buildDeps());
  });

  it("reads the timestamp for a terminal the sender's own project owns", async () => {
    await expect(getOutputActivity(SENDER_A, ["term-a"])).resolves.toEqual({
      "term-a": { status: "read", lastOutputChangeAt: 5_000 },
    });
    // No token: this is a plain record read, not a submission lookup.
    expect(getTerminalAsync).toHaveBeenCalledWith("term-a");
  });

  it("reports a read terminal with no observed change as read, without a timestamp", async () => {
    getTerminalAsync.mockResolvedValue({
      id: "term-a",
      projectId: "project-a",
      lastOutputChangeAt: undefined,
    });

    const result = (await getOutputActivity(SENDER_A, ["term-a"])) as Record<string, object>;

    expect(result["term-a"]).toEqual({ status: "read" });
    expect(result["term-a"]).not.toHaveProperty("lastOutputChangeAt");
  });

  it("projects the typed-input time independently of the output time (#12718)", async () => {
    getTerminalAsync.mockResolvedValue({
      id: "term-a",
      projectId: "project-a",
      lastOutputChangeAt: undefined,
      lastTypedInputAt: 7_000,
    });

    await expect(getOutputActivity(SENDER_A, ["term-a"])).resolves.toEqual({
      "term-a": { status: "read", lastTypedInputAt: 7_000 },
    });

    getTerminalAsync.mockResolvedValue({
      id: "term-a",
      projectId: "project-a",
      lastOutputChangeAt: 5_000,
      lastTypedInputAt: 7_000,
    });

    await expect(getOutputActivity(SENDER_A, ["term-a"])).resolves.toEqual({
      "term-a": { status: "read", lastOutputChangeAt: 5_000, lastTypedInputAt: 7_000 },
    });
  });

  it("tells the outcomes apart within one batch", async () => {
    getTerminalProjectId.mockReturnValue("project-a");
    getTerminalAsync.mockImplementation(async (id: string) => {
      if (id === "term-gone") return null;
      if (id === "term-quiet") return { id, projectId: "project-a" };
      return { id, projectId: "project-a", lastOutputChangeAt: 9 };
    });

    await expect(
      getOutputActivity(SENDER_A, ["term-a", "term-quiet", "term-gone"])
    ).resolves.toEqual({
      "term-a": { status: "read", lastOutputChangeAt: 9 },
      "term-quiet": { status: "read" },
      "term-gone": { status: "unreadable" },
    });
  });

  it("never routes an RPC for a terminal owned by another project", async () => {
    const result = await getOutputActivity(SENDER_A, ["term-b"]);

    expect(result).toEqual({ "term-b": { status: "unreadable" } });
    expect(getTerminalAsync).not.toHaveBeenCalled();
  });

  it("reads a terminal main stopped tracking when the project's inventory still holds it", async () => {
    // An agent that exited on its own leaves its pane and pty-host record, but
    // main drops the spawn entry, so `getTerminalProjectId` answers null. Its
    // screen timestamp is still there to read.
    getTerminalProjectId.mockImplementation((id: string) =>
      id === "term-b" ? "project-b" : id === "term-a" ? "project-a" : null
    );
    getTerminalsForProjectAsync.mockResolvedValue(["term-exited", "term-b"]);
    getTerminalAsync.mockImplementation(async (id: string) => ({
      id,
      projectId: "project-a",
      lastOutputChangeAt: 5_000,
    }));

    const result = await getOutputActivity(SENDER_A, ["term-a", "term-exited", "term-b", "term-x"]);

    expect(result).toEqual({
      "term-a": { status: "read", lastOutputChangeAt: 5_000 },
      "term-exited": { status: "read", lastOutputChangeAt: 5_000 },
      // A known foreign owner is settled before the inventory is consulted,
      // whatever the inventory says.
      "term-b": { status: "unreadable" },
      "term-x": { status: "unreadable" },
    });
    expect(getTerminalsForProjectAsync).toHaveBeenCalledTimes(1);
    expect(getTerminalsForProjectAsync).toHaveBeenCalledWith("project-a");
    expect(getTerminalAsync.mock.calls.map(([id]) => id)).toEqual(["term-a", "term-exited"]);
  });

  it("never serves an unbound sender a record another project owns once main forgot its owner", async () => {
    // Main's null for an exited terminal matches an unbound sender's null
    // project; the record's own owner is what refuses it.
    getProjectForWebContentsMock.mockReturnValue(null);
    getTerminalProjectId.mockReturnValue(null);
    getTerminalAsync.mockResolvedValue({
      id: "term-exited",
      projectId: "project-a",
      lastOutputChangeAt: 5_000,
    });

    await expect(getOutputActivity(SENDER_A, ["term-exited"])).resolves.toEqual({
      "term-exited": { status: "unreadable" },
    });
  });

  it("skips the inventory when every id is already placed", async () => {
    await getOutputActivity(SENDER_A, ["term-a", "term-b"]);

    expect(getTerminalsForProjectAsync).not.toHaveBeenCalled();
  });

  it("treats a null project as an identity, not a wildcard", async () => {
    // A project-bound sender cannot read a projectless terminal…
    await expect(getOutputActivity(SENDER_A, ["term-unowned"])).resolves.toEqual({
      "term-unowned": { status: "unreadable" },
    });
    expect(getTerminalAsync).not.toHaveBeenCalled();

    // …and an unbound window reads its own projectless terminal but not a
    // project-owned one.
    getProjectForWebContentsMock.mockReturnValue(null);
    getTerminalsForProjectAsync.mockClear();
    await expect(getOutputActivity(SENDER_A, ["term-unowned", "term-a"])).resolves.toEqual({
      "term-unowned": { status: "read", lastOutputChangeAt: 5_000 },
      "term-a": { status: "unreadable" },
    });
    expect(getTerminalAsync).toHaveBeenCalledTimes(1);
    expect(getTerminalAsync).toHaveBeenCalledWith("term-unowned");
    // An unbound sender has no project inventory to consult.
    expect(getTerminalsForProjectAsync).not.toHaveBeenCalled();
  });
});
