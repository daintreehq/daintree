import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type {
  FdGrowthPayload,
  TerminalResizeResult,
  TerminalSubmitStatusPayload,
} from "../../../../../shared/types/pty-host.js";

const { liveWebContents } = vi.hoisted(() => ({
  liveWebContents: new Map<number, unknown>(),
}));
const { broadcastToRenderer, broadcastToProjectRenderers, logWarn, logInfo } = vi.hoisted(() => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));
const {
  revokePaneConfig,
  acceptCapturedAgentSession,
  acceptObservedAgentSession,
  releaseSupersededCapturedSession,
} = vi.hoisted(() => ({
  revokePaneConfig: vi.fn(async (_id: string) => undefined),
  acceptCapturedAgentSession: vi.fn(),
  acceptObservedAgentSession: vi.fn(async () => "filled"),
  releaseSupersededCapturedSession: vi.fn(),
}));
const handleTerminalExit = vi.hoisted(() => vi.fn());
const handleTerminalSpawnResult = vi.hoisted(() => vi.fn());
const serviceRef = vi.hoisted(() => ({
  current: null as {
    handleTerminalExit: typeof handleTerminalExit;
    handleTerminalSpawnResult: typeof handleTerminalSpawnResult;
  } | null,
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: () => [] },
  WebContentsView: class {},
  webContents: { fromId: (id: number) => liveWebContents.get(id) ?? null },
}));
// Only the two plain fan-outs are doubled; terminal:data keeps the real
// project-scoped routing over the real view registry.
vi.mock("../../../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils.js")>()),
  broadcastToRenderer,
  broadcastToProjectRenderers,
}));
vi.mock("../../../../utils/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../utils/logger.js")>()),
  logWarn,
  logInfo,
}));
vi.mock("../../../../services/McpPaneConfigService.js", () => ({
  mcpPaneConfigService: { revokePaneConfig },
}));
vi.mock("../../../../services/pty/agentSessionCapturePersistence.js", () => ({
  acceptCapturedAgentSession,
  acceptObservedAgentSession,
  releaseSupersededCapturedSession,
}));
const deliverFirstPrompt = vi.hoisted(() => vi.fn());
vi.mock("../../../../services/pty/firstPromptDelivery.js", () => ({ deliverFirstPrompt }));
const notifyPanelsChanged = vi.hoisted(() => vi.fn());
vi.mock("../../../../services/DriveLeaseService.js", () => ({
  peekDriveLeaseService: () => ({ notifyPanelsChanged }),
}));
vi.mock("../../../../window/serviceRefs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../window/serviceRefs.js")>()),
  getMcpServerServiceRef: () => serviceRef.current,
}));

import { CHANNELS } from "../../../channels.js";
import { events, type DaintreeEventMap } from "../../../../services/events.js";
import { registerTerminalEventHandlers } from "../events.js";
import { SPAWN_CONFIRMATION_TIMEOUT_MS, armSpawnConfirmation } from "../spawnConfirmation.js";
import {
  clearPortHolderWebContents,
  registerAppView,
  registerCachedViewWebContents,
  registerPortHolderWebContents,
  registerProjectView,
  unregisterAppView,
  unregisterProjectView,
} from "../../../../window/webContentsRegistry.js";
import type { HandlerDependencies } from "../../../types.js";

beforeEach(() => {
  serviceRef.current = null;
});

/**
 * #12514: `terminal:data` is relayed to the owning project's views only —
 * cached ones included, since a cached view has no resync path on warm
 * reactivation — instead of to every renderer in the app. Drives the real
 * `broadcastToProjectRenderersExcept` over the real view registry so the routing
 * under test is production code, not a fixture's idea of it.
 */
interface FakeWebContents {
  id: number;
  send: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
}

function makeWebContents(id: number): FakeWebContents {
  const wc: FakeWebContents = {
    id,
    send: vi.fn(),
    isDestroyed: () => false,
    once: vi.fn(),
    removeListener: vi.fn(),
  };
  liveWebContents.set(id, wc);
  return wc;
}

function makeWindow(id: number) {
  return { id, isDestroyed: () => false };
}

function dataSends(wc: FakeWebContents) {
  return wc.send.mock.calls.filter((call) => call[0] === CHANNELS.TERMINAL_DATA);
}

describe("terminal event handlers — terminal:data routing (#12514)", () => {
  let ptyClient: EventEmitter & { getTerminalProjectId: ReturnType<typeof vi.fn> };
  let dispose: () => void;
  const windows: Array<ReturnType<typeof makeWindow>> = [];
  const projectViewIds: number[] = [];
  const portHolderWindowIds: number[] = [];

  // Drives the real registry rather than a stub: `distributePortsToView` records
  // the holder there after a confirmed delivery, and this is the same call.
  function holdPortIn(windowId: number, wc: FakeWebContents): void {
    registerPortHolderWebContents(windowId, wc.id);
    portHolderWindowIds.push(windowId);
  }

  function showInWindow(win: ReturnType<typeof makeWindow>, wc: FakeWebContents): void {
    registerAppView(win as never, { webContents: wc } as never);
  }

  function bindToProject(projectId: string, wc: FakeWebContents): void {
    registerProjectView(projectId, wc as never);
    projectViewIds.push(wc.id);
  }

  beforeEach(() => {
    ptyClient = Object.assign(new EventEmitter(), {
      getTerminalProjectId: vi.fn((id: string) => (id === "term-a" ? "project-a" : null)),
    });
    dispose = registerTerminalEventHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
    for (const windowId of portHolderWindowIds.splice(0)) clearPortHolderWebContents(windowId);
    for (const id of projectViewIds.splice(0)) unregisterProjectView(id);
    for (const win of windows.splice(0)) unregisterAppView(win as never);
    liveWebContents.clear();
  });

  describe("with project views registered", () => {
    let activeA: FakeWebContents;
    let cachedB: FakeWebContents;
    let activeB: FakeWebContents;
    let cachedA: FakeWebContents;

    beforeEach(() => {
      // Window 1 shows project A with B cached behind it; window 2 is the
      // mirror image, so project A has one visible and one cached view.
      const win1 = makeWindow(1);
      const win2 = makeWindow(2);
      windows.push(win1, win2);

      activeA = makeWebContents(11);
      cachedB = makeWebContents(12);
      activeB = makeWebContents(21);
      cachedA = makeWebContents(22);

      showInWindow(win1, activeA);
      bindToProject("project-a", activeA);
      bindToProject("project-b", cachedB);
      registerCachedViewWebContents(cachedB as never);

      showInWindow(win2, activeB);
      bindToProject("project-b", activeB);
      bindToProject("project-a", cachedA);
      registerCachedViewWebContents(cachedA as never);
    });

    it("delivers a chunk to every view of the owning project, cached ones included", () => {
      const chunk = new Uint8Array([104, 105]);

      ptyClient.emit("data", "term-a", chunk);

      expect(ptyClient.getTerminalProjectId).toHaveBeenCalledWith("term-a");
      expect(dataSends(activeA)).toEqual([[CHANNELS.TERMINAL_DATA, "term-a", chunk]]);
      expect(dataSends(cachedA)).toEqual([[CHANNELS.TERMINAL_DATA, "term-a", chunk]]);
    });

    it("skips the port holder of a window the host already fed (#12557)", () => {
      // Window 1's active project-A view read the chunk off its MessagePort, so
      // the host named window 1 while keeping the fallback open for window 2's
      // cached copy. Re-sending to that view would dispatch the same bytes
      // into its xterm a second time — terminalClient.onData subscribes to
      // both transports.

      ptyClient.emit("data", "term-a", "working... step 1", {
        portDeliveredWebContentsIds: [activeA.id],
      });

      expect(dataSends(activeA)).toHaveLength(0);
      expect(dataSends(cachedA)).toEqual([[CHANNELS.TERMINAL_DATA, "term-a", "working... step 1"]]);
    });

    it("ignores a delivered id that matches no view of the project", () => {
      // A view torn down between the host writing to its port and Main routing
      // the fallback. Excluding an id nobody matches is a no-op, so every live
      // view still receives the chunk.
      ptyClient.emit("data", "term-a", "output", { portDeliveredWebContentsIds: [999_999] });

      expect(dataSends(activeA)).toEqual([[CHANNELS.TERMINAL_DATA, "term-a", "output"]]);
      expect(dataSends(cachedA)).toEqual([[CHANNELS.TERMINAL_DATA, "term-a", "output"]]);
    });

    it("excludes the recipient even after its window's holder moved on (#12557)", () => {
      // The race the identity carriage exists for: the host wrote the chunk to
      // window 1's project-A view, then window 1 switched to project B before
      // Main routed the fallback. Resolving the recipient from the window would
      // now exclude the B view and re-deliver into the A view that already
      // parsed it; the echoed identity still names the A view.
      holdPortIn(1, activeB);

      ptyClient.emit("data", "term-a", "step", { portDeliveredWebContentsIds: [activeA.id] });

      expect(dataSends(activeA)).toHaveLength(0);
      expect(dataSends(cachedA)).toEqual([[CHANNELS.TERMINAL_DATA, "term-a", "step"]]);
    });

    it("routes a port-flush recovery batch to that window's holder alone (#12557)", () => {
      // The view's port threw mid-flush. Everyone else already has these
      // bytes — siblings from their own ports, port-less views from the
      // supplementary fallback — so a re-broadcast would double-deliver.

      ptyClient.emit("data", "term-a", "recovered", { portRecoveryWebContentsId: activeA.id });

      expect(dataSends(activeA)).toEqual([[CHANNELS.TERMINAL_DATA, "term-a", "recovered"]]);
      expect(dataSends(cachedA)).toHaveLength(0);
      expect(dataSends(activeB)).toHaveLength(0);
      expect(dataSends(cachedB)).toHaveLength(0);
    });

    it("drops a recovery batch whose view is already gone (#12557)", () => {
      // Nothing can be addressed, and smearing it across the project would
      // duplicate into every view that already has it.
      ptyClient.emit("data", "term-a", "recovered", { portRecoveryWebContentsId: 999_999 });

      for (const wc of [activeA, cachedA, activeB, cachedB]) {
        expect(dataSends(wc)).toHaveLength(0);
      }
    });

    it("never reaches another project's views, visible or cached", () => {
      ptyClient.emit("data", "term-a", "hello");

      expect(dataSends(activeB)).toHaveLength(0);
      expect(dataSends(cachedB)).toHaveLength(0);
    });

    it("still excludes a fed port holder when the project is unknown (#12557)", () => {
      // `getTerminalProjectId` starts returning null the moment
      // `PtyClient.kill()` drops the spawn record, while chunks the host
      // already emitted are still arriving. The unscoped fan-out must not
      // hand one back to the view that read it off its port.
      ptyClient.emit("data", "term-untracked", "late output", {
        portDeliveredWebContentsIds: [activeA.id],
      });

      expect(dataSends(activeA)).toHaveLength(0);
      expect(dataSends(cachedA)).toEqual([
        [CHANNELS.TERMINAL_DATA, "term-untracked", "late output"],
      ]);
    });

    it("falls back to every app view when the terminal's project is unknown", () => {
      // A terminal main no longer tracks answers null — the fallback is what
      // keeps its late output from being swallowed.
      ptyClient.emit("data", "term-untracked", "late output");

      for (const wc of [activeA, cachedB, activeB, cachedA]) {
        expect(dataSends(wc)).toEqual([[CHANNELS.TERMINAL_DATA, "term-untracked", "late output"]]);
      }
    });

    it("drops a chunk whose project no view hosts", () => {
      ptyClient.getTerminalProjectId.mockReturnValue("project-evicted");

      ptyClient.emit("data", "term-evicted", "output");

      for (const wc of [activeA, cachedB, activeB, cachedA]) {
        expect(dataSends(wc)).toHaveLength(0);
      }
    });
  });

  describe("with no project views registered", () => {
    it("falls back to every app view even for a known project", () => {
      // Startup, or windows that never route through ProjectViewManager.
      const win1 = makeWindow(1);
      const win2 = makeWindow(2);
      windows.push(win1, win2);
      const first = makeWebContents(31);
      const second = makeWebContents(41);
      showInWindow(win1, first);
      showInWindow(win2, second);

      ptyClient.emit("data", "term-a", "boot output");

      expect(dataSends(first)).toEqual([[CHANNELS.TERMINAL_DATA, "term-a", "boot output"]]);
      expect(dataSends(second)).toEqual([[CHANNELS.TERMINAL_DATA, "term-a", "boot output"]]);
    });
  });

  it("stops relaying once the handlers are disposed", () => {
    const win = makeWindow(1);
    windows.push(win);
    const wc = makeWebContents(51);
    showInWindow(win, wc);

    dispose();
    ptyClient.emit("data", "term-a", "after dispose");

    expect(dataSends(wc)).toHaveLength(0);
    expect(ptyClient.listenerCount("data")).toBe(0);
  });
});

function captured(): DaintreeEventMap["agent-session:captured"] {
  return {
    terminalId: "t1",
    launchGeneration: 2,
    boundary: "exit",
    record: {
      sessionId: "synthetic-session",
      agentId: "codex",
      worktreeId: null,
      title: null,
      projectId: "p1",
    },
  };
}

describe("terminal event handlers — captured agent sessions (#12433)", () => {
  let dispose: () => void;
  let ptyClient: EventEmitter;

  beforeEach(() => {
    acceptCapturedAgentSession.mockReset();
    acceptObservedAgentSession.mockClear();
    releaseSupersededCapturedSession.mockReset();
    ptyClient = Object.assign(new EventEmitter(), { getTerminalProjectId: vi.fn() });
    dispose = registerTerminalEventHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
  });

  it("hands each capture to persistence before the emit returns", () => {
    const payload = captured();

    events.emit("agent-session:captured", payload);

    // Synchronous acceptance is what lets a quit's drain see this write: a
    // hop through a microtask would leave a window where it is invisible.
    expect(acceptCapturedAgentSession).toHaveBeenCalledTimes(1);
    expect(acceptCapturedAgentSession).toHaveBeenCalledWith(payload);
  });

  it("hands each argv observation to persistence before the emit returns (#15994)", () => {
    const payload = {
      terminalId: "t1",
      agentId: "codex",
      projectId: "proj-1",
      sessionId: "0199f8c1-2b4d-7e3a-9f10-5c6d7e8f9a0b",
      run: { launchGeneration: 3, agentIncarnation: 1 },
    };

    events.emit("agent-session:observed", payload);

    expect(acceptObservedAgentSession.mock.calls).toEqual([[payload]]);
    expect(acceptCapturedAgentSession).not.toHaveBeenCalled();
  });

  it("offers only a confirmed spawn, with its generation, to the relaunch release", () => {
    ptyClient.emit("spawn-result", "t1", { success: true, id: "t1", launchGeneration: 4 });
    ptyClient.emit("spawn-result", "t2", {
      success: false,
      id: "t2",
      launchGeneration: 2,
      error: { code: "TERMINAL_ALREADY_LIVE", message: "still running" },
    });

    // A refused spawn leaves the previous process — and its id — in place.
    expect(releaseSupersededCapturedSession.mock.calls).toEqual([["t1", 4]]);
  });

  it("stops accepting once the handlers are disposed", () => {
    dispose();
    dispose = () => {};

    events.emit("agent-session:captured", captured());

    expect(acceptCapturedAgentSession).not.toHaveBeenCalled();
  });
});

const PROJECTS: Record<string, string | null> = {
  a1: "project-a",
  a2: "project-a",
  b1: "project-b",
  gone: null,
};

describe("terminal event handlers — broadcast-write-result forwarding", () => {
  let ptyClient: EventEmitter & { getTerminalProjectId: (id: string) => string | null };
  let dispose: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ptyClient = Object.assign(new EventEmitter(), {
      getTerminalProjectId: (id: string) => PROJECTS[id] ?? null,
    });
    dispose = registerTerminalEventHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
  });

  it("splits a mixed result into one payload per project", () => {
    ptyClient.emit("broadcast-write-result", {
      results: [
        { id: "a1", ok: false },
        { id: "b1", ok: false },
        { id: "a2", ok: true },
      ],
    });

    expect(broadcastToProjectRenderers.mock.calls).toEqual([
      [
        "project-a",
        CHANNELS.TERMINAL_BROADCAST_WRITE_RESULT,
        {
          results: [
            { id: "a1", ok: false },
            { id: "a2", ok: true },
          ],
        },
      ],
      [
        "project-b",
        CHANNELS.TERMINAL_BROADCAST_WRITE_RESULT,
        { results: [{ id: "b1", ok: false }] },
      ],
    ]);
    expect(broadcastToRenderer).not.toHaveBeenCalled();
  });

  it("sends only unattributable entries unscoped, keeping live targets in their project", () => {
    ptyClient.emit("broadcast-write-result", {
      results: [
        { id: "a1", ok: false },
        { id: "gone", ok: false },
      ],
    });

    expect(broadcastToProjectRenderers.mock.calls).toEqual([
      [
        "project-a",
        CHANNELS.TERMINAL_BROADCAST_WRITE_RESULT,
        { results: [{ id: "a1", ok: false }] },
      ],
      // A null project is the all-views fallback inside broadcastToProjectRenderers.
      [null, CHANNELS.TERMINAL_BROADCAST_WRITE_RESULT, { results: [{ id: "gone", ok: false }] }],
    ]);
  });

  it("sends nothing for an empty result", () => {
    ptyClient.emit("broadcast-write-result", { results: [] });
    expect(broadcastToProjectRenderers).not.toHaveBeenCalled();
    expect(broadcastToRenderer).not.toHaveBeenCalled();
  });
});

function makePayload(overrides: Partial<FdGrowthPayload> = {}): FdGrowthPayload {
  return {
    state: "elevated",
    hostPid: 4242,
    terminals: 25,
    pooledPtys: 2,
    pluginPtys: 0,
    analysisWorkers: 3,
    fdCount: 140,
    expectedFds: 60,
    baselineFds: 37,
    growth: 43,
    sustainedSamples: 3,
    sampleIntervalMs: 30000,
    episodeStartedAt: 1_000_000,
    descriptorTypes: {
      charDevice: 28,
      socket: 3,
      fifo: 30,
      file: 70,
      directory: 6,
      other: 0,
      unavailable: 3,
    },
    timestamp: 1_060_000,
    ...overrides,
  };
}

describe("terminal event handlers — fd-growth (#12520)", () => {
  let ptyClient: EventEmitter & { getTerminalProjectId: ReturnType<typeof vi.fn> };
  let dispose: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ptyClient = Object.assign(new EventEmitter(), {
      getTerminalProjectId: vi.fn(),
    });
    dispose = registerTerminalEventHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
  });

  it("writes one warning per elevated transition, with the observation as context", () => {
    const payload = makePayload();

    ptyClient.emit("fd-growth", payload);

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logInfo).not.toHaveBeenCalled();
    const [message, context] = logWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(context).toEqual(payload);
    expect(message).toContain("pty-host 4242 FD count elevated");
    expect(message).toContain("140 open descriptors, 60 expected");
    expect(message).toContain("25 terminals, 2 pooled PTYs, 0 plugin PTYs, 3 analysis workers");
    expect(message).toContain("growth 43 over the post-restore baseline of 37");
    expect(message).toContain("for 3 samples at the current 30s sample interval");
    expect(message).toContain("file 70");
    expect(message).not.toContain("other 0");
  });

  it("writes one info record when the episode recovers", () => {
    const payload = makePayload({
      state: "recovered",
      fdCount: 99,
      growth: 2,
      sustainedSamples: 2,
      descriptorTypes: undefined,
      timestamp: 1_000_000 + 12 * 60_000,
    });

    ptyClient.emit("fd-growth", payload);

    expect(logWarn).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledTimes(1);
    const [message] = logInfo.mock.calls[0] as [string];
    expect(message).toContain("FD count back near baseline");
    expect(message).toContain("growth 2 over the post-restore baseline of 37");
    expect(message).toContain("12 min after it rose");
  });

  it("drops the elapsed claim when a recovery predates the episode it ends", () => {
    // An episode outlives a clock stepped backwards, so the recovery can carry
    // a timestamp earlier than its own start.
    ptyClient.emit(
      "fd-growth",
      makePayload({
        state: "recovered",
        growth: 0,
        descriptorTypes: undefined,
        episodeStartedAt: 1_000_000,
        timestamp: 1_000_000 - 5 * 60_000,
      })
    );

    const [message] = logInfo.mock.calls[0] as [string];
    expect(message).toContain("FD count back near baseline");
    expect(message).not.toContain("after it rose");
    expect(message).not.toMatch(/-\d+ min/);
  });

  it("omits the type breakdown when the elevation carries none", () => {
    ptyClient.emit("fd-growth", makePayload({ descriptorTypes: undefined }));

    expect(logWarn).toHaveBeenCalledTimes(1);
    const [message] = logWarn.mock.calls[0] as [string];
    expect(message).toContain("FD count elevated");
    expect(message).not.toContain("Descriptor types");
    expect(message).not.toContain("undefined");
  });

  it("states observations only — no leak verdict and no PTY-limit percentage", () => {
    ptyClient.emit("fd-growth", makePayload());
    ptyClient.emit("fd-growth", makePayload({ state: "recovered", growth: 0 }));

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledTimes(1);
    for (const [message] of [...logWarn.mock.calls, ...logInfo.mock.calls] as [string][]) {
      expect(message).not.toMatch(/leak/i);
      expect(message).not.toMatch(/% of limit/);
    }
  });

  it("does not relay either transition to renderers, so open views add no copies", () => {
    ptyClient.emit("fd-growth", makePayload());
    ptyClient.emit("fd-growth", makePayload({ state: "recovered", growth: 0 }));

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(broadcastToRenderer).not.toHaveBeenCalled();
    expect(broadcastToProjectRenderers).not.toHaveBeenCalled();
  });

  it("stops handling transitions after dispose", () => {
    dispose();
    dispose = () => {};

    ptyClient.emit("fd-growth", makePayload());

    expect(logWarn).not.toHaveBeenCalled();
    expect(ptyClient.listenerCount("fd-growth")).toBe(0);
  });
});

function makeResult(overrides: Partial<TerminalResizeResult> = {}): TerminalResizeResult {
  return {
    launchGeneration: 3,
    requestedCols: 120,
    requestedRows: 40,
    appliedCols: 120,
    appliedRows: 40,
    outcome: "applied",
    ...overrides,
  };
}

describe("terminal event handlers — resize-result forwarding (#11641)", () => {
  let ptyClient: EventEmitter & { getTerminalProjectId: ReturnType<typeof vi.fn> };
  let dispose: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ptyClient = Object.assign(new EventEmitter(), {
      getTerminalProjectId: vi.fn((id: string) => `project-for-${id}`),
    });
    dispose = registerTerminalEventHandlers({
      ptyClient,
    } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
  });

  function resizeEnvelopes() {
    return broadcastToProjectRenderers.mock.calls.filter(
      (call) => call[1] === CHANNELS.EVENTS_PUSH && call[2]?.name === "terminal:resize-result"
    );
  }

  it("forwards a resize result as an events-push envelope carrying id and result", () => {
    const result = makeResult();

    ptyClient.emit("resize-result", "t1", result);

    const envelopes = resizeEnvelopes();
    expect(envelopes).toHaveLength(1);
    // The payload is a tuple the preload destructures as `([id, result])` —
    // an object payload here would silently deliver `undefined` to callers.
    expect(envelopes[0]?.[2]).toEqual({
      name: "terminal:resize-result",
      payload: ["t1", result],
    });
  });

  it("scopes the echo to the owning project instead of fanning out to every view", () => {
    ptyClient.emit("resize-result", "t1", makeResult());

    expect(ptyClient.getTerminalProjectId).toHaveBeenCalledWith("t1");
    expect(resizeEnvelopes()[0]?.[0]).toBe("project-for-t1");
    // Every non-owning view drops the echo in `recordPtyResizeResult` anyway, so
    // a global broadcast would be a structured clone + IPC task per unrelated view.
    expect(
      broadcastToRenderer.mock.calls.some((call) => call[1]?.name === "terminal:resize-result")
    ).toBe(false);
  });

  it("passes an unknown project through so the util can fall back to a full broadcast", () => {
    ptyClient.getTerminalProjectId.mockReturnValue(null);

    ptyClient.emit("resize-result", "t1", makeResult());

    expect(resizeEnvelopes()[0]?.[0]).toBeNull();
  });

  it("stops forwarding once the handlers are disposed", () => {
    dispose();

    ptyClient.emit("resize-result", "t1", makeResult());

    expect(resizeEnvelopes()).toHaveLength(0);
    expect(ptyClient.listenerCount("resize-result")).toBe(0);
  });

  it("forwards a result with no confirmed geometry without inventing one", () => {
    ptyClient.emit(
      "resize-result",
      "t1",
      makeResult({ outcome: "deferred", appliedCols: null, appliedRows: null })
    );

    const payload = resizeEnvelopes()[0]?.[2]?.payload as [string, TerminalResizeResult];
    expect(payload[1].appliedCols).toBeNull();
    expect(payload[1].appliedRows).toBeNull();
  });
});

describe("terminal exit forwarding during restart", () => {
  let ptyClient: EventEmitter & { consumeRestartExitSuppression: ReturnType<typeof vi.fn> };
  let dispose: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    serviceRef.current = { handleTerminalExit, handleTerminalSpawnResult };
    ptyClient = Object.assign(new EventEmitter(), {
      consumeRestartExitSuppression: vi.fn().mockReturnValue(false),
    });
    dispose = registerTerminalEventHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => dispose());

  it("withholds the restart exit from every view but still retires the old MCP bearer", () => {
    ptyClient.consumeRestartExitSuppression.mockReturnValueOnce(true);

    ptyClient.emit("exit", "t1", 0);

    expect(broadcastToRenderer).not.toHaveBeenCalled();
    expect(revokePaneConfig).toHaveBeenCalledExactlyOnceWith("t1");
    expect(handleTerminalExit).toHaveBeenCalledExactlyOnceWith("t1");

    ptyClient.emit("exit", "t1", 1);

    expect(broadcastToRenderer).toHaveBeenCalledExactlyOnceWith(CHANNELS.EVENTS_PUSH, {
      name: "terminal:exit",
      payload: ["t1", 1],
    });
  });

  it("continues forwarding ordinary successful exits", () => {
    ptyClient.emit("exit", "t1", 0);

    expect(broadcastToRenderer).toHaveBeenCalledExactlyOnceWith(CHANNELS.EVENTS_PUSH, {
      name: "terminal:exit",
      payload: ["t1", 0],
    });
  });

  it("tells every view an exit came from a session-preserving teardown (#13841)", () => {
    ptyClient.emit("exit", "t1", 0, 15, true);

    expect(broadcastToRenderer).toHaveBeenCalledExactlyOnceWith(CHANNELS.EVENTS_PUSH, {
      name: "terminal:exit",
      payload: ["t1", 0, { preserveSession: true }],
    });
  });

  it("still withholds a restart's exit when it carries the teardown mark", () => {
    ptyClient.consumeRestartExitSuppression.mockReturnValueOnce(true);

    ptyClient.emit("exit", "t1", 0, 15, true);

    expect(broadcastToRenderer).not.toHaveBeenCalled();
  });
});

describe("terminal event handlers — spawn confirmation (#12754)", () => {
  let ptyClient: EventEmitter & { getTerminalProjectId: ReturnType<typeof vi.fn> };
  let dispose: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    ptyClient = Object.assign(new EventEmitter(), {
      getTerminalProjectId: vi.fn(() => "project-a"),
      consumeRestartExitSuppression: vi.fn(() => false),
    });
    dispose = registerTerminalEventHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
    vi.useRealTimers();
  });

  function spawnResultEnvelopes() {
    return broadcastToRenderer.mock.calls.filter(
      (call) => call[0] === CHANNELS.EVENTS_PUSH && call[1]?.name === "terminal:spawn-result"
    );
  }

  it("tells the renderer when the host never answers, without main-side failure handling", () => {
    armSpawnConfirmation("t1");
    vi.advanceTimersByTime(SPAWN_CONFIRMATION_TIMEOUT_MS);

    const envelopes = spawnResultEnvelopes();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]![1].payload).toEqual([
      "t1",
      expect.objectContaining({
        success: false,
        id: "t1",
        error: expect.objectContaining({ code: "SPAWN_TIMEOUT" }),
      }),
    ]);
    // The spawn may still land — nothing may treat this as a final failure.
    expect(revokePaneConfig).not.toHaveBeenCalled();
  });

  it("a real spawn-result settles the window", () => {
    armSpawnConfirmation("t1");
    ptyClient.emit("spawn-result", "t1", { success: true, id: "t1" });
    vi.advanceTimersByTime(SPAWN_CONFIRMATION_TIMEOUT_MS * 2);

    expect(spawnResultEnvelopes()).toHaveLength(1);
    expect(spawnResultEnvelopes()[0]![1].payload[1]).toMatchObject({ success: true });
  });

  it("tells the project's watchers of a terminal that started, restarts included (#13280)", () => {
    ptyClient.emit("spawn-result", "t1", { success: true, id: "t1" });
    expect(notifyPanelsChanged).toHaveBeenCalledWith("project-a");

    notifyPanelsChanged.mockClear();
    ptyClient.emit("spawn-result", "t2", { success: false, id: "t2", error: { code: "X" } });
    ptyClient.getTerminalProjectId.mockReturnValueOnce(null);
    ptyClient.emit("spawn-result", "t3", { success: true, id: "t3" });
    expect(notifyPanelsChanged).not.toHaveBeenCalled();
  });

  it("a predecessor's exit does not disarm a restarted launch's window", () => {
    armSpawnConfirmation("t1");
    ptyClient.emit("exit", "t1", 0);
    vi.advanceTimersByTime(SPAWN_CONFIRMATION_TIMEOUT_MS);

    expect(spawnResultEnvelopes()).toHaveLength(1);
    expect(spawnResultEnvelopes()[0]![1].payload[1]).toMatchObject({
      error: { code: "SPAWN_TIMEOUT" },
    });
  });

  it("disposing the handlers drops armed windows", () => {
    armSpawnConfirmation("t1");
    dispose();
    dispose = () => {};
    vi.advanceTimersByTime(SPAWN_CONFIRMATION_TIMEOUT_MS);
    expect(spawnResultEnvelopes()).toHaveLength(0);
  });
});

describe("terminal event handlers — submit-status forwarding (#11875)", () => {
  let ptyClient: EventEmitter & { getTerminalProjectId: ReturnType<typeof vi.fn> };
  let dispose: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ptyClient = Object.assign(new EventEmitter(), {
      getTerminalProjectId: vi.fn((id: string) => `project-for-${id}`),
    });
    dispose = registerTerminalEventHandlers({
      ptyClient,
    } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
  });

  function submitEnvelopes() {
    return broadcastToProjectRenderers.mock.calls.filter(
      (call) => call[1] === CHANNELS.EVENTS_PUSH && call[2]?.name === "terminal:submit-status"
    );
  }

  it("hands a run's first prompt to its owning project, never a broadcast (#15521)", () => {
    const firstPrompt = { text: "Fix the login bug", via: "send" as const, at: 5 };
    const busEmit = vi.spyOn(events, "emit");

    ptyClient.emit("first-prompt", "t1", firstPrompt, "project-a");

    expect(JSON.stringify(busEmit.mock.calls)).not.toContain("Fix the login bug");
    busEmit.mockRestore();

    // The run's own project, never whatever a pending duplicate spawn names.
    expect(ptyClient.getTerminalProjectId).not.toHaveBeenCalled();
    expect(deliverFirstPrompt).toHaveBeenCalledWith("project-a", "t1", firstPrompt);
    const leaked = [...broadcastToRenderer.mock.calls, ...broadcastToProjectRenderers.mock.calls];
    expect(JSON.stringify(leaked)).not.toContain("Fix the login bug");
  });

  it("drops a first prompt for a terminal no project owns", () => {
    ptyClient.emit("first-prompt", "t1", { text: "x", via: "send", at: 5 }, undefined);

    expect(deliverFirstPrompt).not.toHaveBeenCalled();
  });

  it("forwards the payload as a single object, not positional args", () => {
    // The router emits one `{ id, state }` object. Both ends of this
    // EventEmitter hop are untyped, so a positional/object mismatch would
    // compile cleanly and deliver `undefined` to the renderer.
    const payload: TerminalSubmitStatusPayload = { id: "t1", state: "slow" };

    ptyClient.emit("submit-status", payload);

    const envelopes = submitEnvelopes();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.[2]).toEqual({
      name: "terminal:submit-status",
      payload: { id: "t1", state: "slow" },
    });
  });

  it("scopes to the owning project rather than fanning out to every view", () => {
    ptyClient.emit("submit-status", { id: "t1", state: "slow" });

    expect(ptyClient.getTerminalProjectId).toHaveBeenCalledWith("t1");
    expect(submitEnvelopes()[0]?.[0]).toBe("project-for-t1");
    expect(
      broadcastToRenderer.mock.calls.some((call) => call[1]?.name === "terminal:submit-status")
    ).toBe(false);
  });

  it("passes an unknown project through so the util can fall back to a full broadcast", () => {
    // A killed terminal drops its pendingSpawns entry, so the project can be
    // null exactly when a late `settled` arrives — the fallback is what stops
    // that clearing event being swallowed.
    ptyClient.getTerminalProjectId.mockReturnValue(null);

    ptyClient.emit("submit-status", { id: "t1", state: "settled" });

    expect(submitEnvelopes()[0]?.[0]).toBeNull();
  });

  it("stops forwarding once the handlers are disposed", () => {
    dispose();

    ptyClient.emit("submit-status", { id: "t1", state: "slow" });

    expect(submitEnvelopes()).toHaveLength(0);
    expect(ptyClient.listenerCount("submit-status")).toBe(0);
  });
});

// A hand-over is of one running process (#12490): every exit and spawn result
// is handed to the MCP server, which alone knows which launch was handed over.
// The orchestrator's side ends with its bearer, which the pane-config
// revocation covers.
describe("terminal event handlers — terminal hand-over (#12490)", () => {
  let dispose: () => void;
  let ptyClient: EventEmitter;

  beforeEach(() => {
    handleTerminalExit.mockReset();
    handleTerminalSpawnResult.mockReset();
    serviceRef.current = { handleTerminalExit, handleTerminalSpawnResult };
    ptyClient = Object.assign(new EventEmitter(), {
      getTerminalProjectId: vi.fn(),
      consumeRestartExitSuppression: vi.fn(() => false),
    });
    dispose = registerTerminalEventHandlers({ ptyClient } as unknown as HandlerDependencies);
  });

  afterEach(() => {
    dispose();
  });

  it("reports every spawn result whole, failures included", () => {
    const succeeded = { success: true, id: "t1", launchGeneration: 4 };
    const refused = {
      success: false,
      id: "t2",
      launchGeneration: 2,
      error: { code: "TERMINAL_ALREADY_LIVE", message: "still running" },
    };
    ptyClient.emit("spawn-result", "t1", succeeded);
    ptyClient.emit("spawn-result", "t2", refused);

    expect(handleTerminalSpawnResult.mock.calls).toEqual([
      ["t1", succeeded],
      ["t2", refused],
    ]);
  });

  it("does nothing before the MCP server has ever loaded", () => {
    serviceRef.current = null;

    expect(() => ptyClient.emit("exit", "t1", 0)).not.toThrow();
    expect(() =>
      ptyClient.emit("spawn-result", "t1", { success: true, id: "t1", launchGeneration: 1 })
    ).not.toThrow();
  });
});
