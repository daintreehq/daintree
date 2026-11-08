import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVisualOutputRouter, type VisualOutputRouter } from "../visualOutputRouter.js";
import { IpcQueueManager } from "../ipcQueue.js";
import { PtyPauseCoordinator } from "../PtyPauseCoordinator.js";
import { createConnectionHandlers } from "../handlers/connection.js";
import { createTerminalQueryHandlers } from "../handlers/terminalQueries.js";
import type { HandlerMap, HostContext, RendererConnection } from "../handlers/types.js";
import { HIDDEN_VIEW_SKIP_REASON, type PtyHostEvent } from "../../../shared/types/pty-host.js";
import {
  IPC_HIDDEN_VIEW_MAX_QUEUE_BYTES,
  IPC_MAX_PAUSE_MS,
  IPC_TOTAL_QUEUE_HIGH_WATERMARK_BYTES,
} from "../../services/pty/types.js";

// A full-width TUI redraw row: box-drawing characters are 3 bytes in UTF-8.
const REDRAW = "─".repeat(1365) + "\r\n";
const REDRAW_BYTES = Buffer.byteLength(REDRAW, "utf8");
const TICK_MS = 20;

type Terminal = {
  id: string;
  projectId: string;
  contentEpoch: number;
  lastInputTime: number;
  analysisEnabled: boolean;
};

interface Harness {
  router: VisualOutputRouter;
  rendererConnections: Map<number, RendererConnection>;
  ipcQueue: IpcQueueManager;
  connection: HandlerMap;
  queries: HandlerMap;
  events: PtyHostEvent[];
  coordinators: Map<string, PtyPauseCoordinator>;
  rawPauses: Map<string, number>;
  batcherWrite: ReturnType<typeof vi.fn>;
  windowProjectMap: Map<number, string | null>;
  fallbackEligibleProjects: Set<string>;
  ipcDataMirrorTerminals: Set<string>;
}

function createHarness(terminalIds: string[], projectId: string, extra: string[] = []): Harness {
  // `extra` terminals belong to proj-b, the project the window usually shows.
  const terminals = new Map<string, Terminal>(
    [...terminalIds.map((id) => [id, projectId]), ...extra.map((id) => [id, "proj-b"])].map(
      ([id, pid]) => [
        id!,
        { id: id!, projectId: pid!, contentEpoch: 0, lastInputTime: 0, analysisEnabled: false },
      ]
    )
  );
  terminalIds = [...terminalIds, ...extra];
  const events: PtyHostEvent[] = [];
  const sendEvent = (event: PtyHostEvent) => events.push(event);
  const rawPauses = new Map<string, number>();
  const coordinators = new Map<string, PtyPauseCoordinator>();
  for (const id of terminalIds) {
    rawPauses.set(id, 0);
    coordinators.set(
      id,
      new PtyPauseCoordinator({
        pause: () => rawPauses.set(id, rawPauses.get(id)! + 1),
        resume: () => {},
      })
    );
  }
  const getPauseCoordinator = (id: string) => coordinators.get(id);

  const ipcQueue = new IpcQueueManager({
    getTerminal: () => undefined,
    getPauseCoordinator,
    sendEvent,
    metricsEnabled: () => false,
    emitTerminalStatus: vi.fn(),
    emitReliabilityMetric: vi.fn(),
  });

  // One window. Its port belongs to whichever view is on screen, and its
  // batcher always has room — the cached project never reaches it anyway.
  const batcherWrite = vi.fn(() => true);
  const rendererConnections = new Map<number, RendererConnection>([
    [
      1,
      {
        port: { postMessage: vi.fn() },
        batcher: { write: batcherWrite },
        holderWebContentsId: 101,
      } as unknown as RendererConnection,
    ],
  ]);
  const windowProjectMap = new Map<number, string | null>();
  const fallbackEligibleProjects = new Set<string>();
  const ipcDataMirrorTerminals = new Set<string>();

  const ptyManager = {
    getTerminal: (id: string) => terminals.get(id),
    getTerminalsForProject: (pid: string) =>
      [...terminals.values()].filter((t) => t.projectId === pid).map((t) => t.id),
    getSerializedStateAsync: vi.fn(async () => "snapshot"),
  };

  const router = createVisualOutputRouter({
    getTerminal: ptyManager.getTerminal as never,
    backpressureManager: { isSuspended: () => false } as never,
    ipcQueueManager: ipcQueue,
    rendererConnections,
    terminalWorkerConnections: new Map(),
    windowProjectMap,
    fallbackEligibleProjects,
    ipcDataMirrorTerminals,
    packetFramer: {} as never,
    getVisualBuffers: () => [],
    getVisualSignalView: () => null,
    getAnalysisBuffer: () => null,
    getPauseCoordinator,
    getOrCreatePauseCoordinator: getPauseCoordinator,
    recordDrop: vi.fn(),
    emitReliabilityMetric: vi.fn(),
    sendEvent,
    metricsEnabled: () => false,
  });

  const ctx = {
    ptyManager,
    ipcQueueManager: ipcQueue,
    rendererConnections,
    terminalWorkerConnections: new Map(),
    windowProjectMap,
    fallbackEligibleProjects,
    windowFocusedTerminalMap: new Map(),
    disconnectWindow: vi.fn(),
    disconnectTerminalWorkerPort: vi.fn(),
    recomputeActivityTiers: vi.fn(),
    createPortQueueManager: vi.fn(),
    createTerminalWorkerPortQueueManager: vi.fn(),
    sendEvent,
    ptyPool: null,
    initialPoolWarmDeferred: false,
  } as unknown as HostContext;

  return {
    router,
    rendererConnections,
    ipcQueue,
    connection: createConnectionHandlers(ctx),
    queries: createTerminalQueryHandlers(ctx),
    events,
    coordinators,
    rawPauses,
    batcherWrite,
    windowProjectMap,
    fallbackEligibleProjects,
    ipcDataMirrorTerminals,
  };
}

const PROJECTS = ["proj-a", "proj-b"];

/**
 * Show `projectId` in the window as Main does: tell the host, then hand the
 * port to its view, which leaves every other project's cached view portless.
 */
function show(h: Harness, projectId: string, windowId = 1): void {
  h.connection["project-switch"]!({ type: "project-switch", windowId, projectId } as never);
  h.fallbackEligibleProjects.clear();
  for (const pid of PROJECTS) if (pid !== projectId) h.fallbackEligibleProjects.add(pid);
}

/**
 * Every terminal redraws once per tick unless its PTY reads are paused — a
 * paused agent blocks on its own writes, exactly as a real one does.
 * Returns how many redraws each terminal got out.
 */
function runAgents(h: Harness, ids: string[], durationMs: number): Map<string, number> {
  const written = new Map(ids.map((id) => [id, 0]));
  for (let t = 0; t < durationMs; t += TICK_MS) {
    for (const id of ids) {
      if (h.coordinators.get(id)!.isReadPaused) continue;
      h.router.routeOutput(id, REDRAW, undefined);
      written.set(id, written.get(id)! + 1);
    }
    vi.advanceTimersByTime(TICK_MS);
  }
  return written;
}

function statusEvents(h: Harness) {
  return h.events.filter(
    (e): e is Extract<PtyHostEvent, { type: "terminal-status" }> => e.type === "terminal-status"
  );
}

function ipcDataFor(h: Harness, id: string) {
  return h.events.filter((e) => e.type === "data" && e.id === id);
}

describe("visual routing for a project no window shows (#16497)", () => {
  const AGENTS = ["a1", "a2", "a3", "a4", "a5", "a6"];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps busy agents running behind a cached view that never acks, then starts the next hidden stretch from an empty queue", () => {
    const h = createHarness(AGENTS, "proj-a");
    h.ipcDataMirrorTerminals.add("a1");
    show(h, "proj-b");

    // Several pause windows' worth of sustained TUI output with no acks at all
    // (a frozen or heavily throttled cached view).
    const durationMs = IPC_MAX_PAUSE_MS * 4;
    const written = runAgents(h, AGENTS, durationMs);

    for (const id of AGENTS) {
      // Never held: every tick's redraw left the PTY.
      expect(h.rawPauses.get(id)).toBe(0);
      expect(written.get(id)).toBe(durationMs / TICK_MS);
      // The cached view was fed until its budget filled, and no further, all
      // of it outside the primary ledger.
      expect(h.ipcQueue.getHiddenQueuedBytes(id)).toBeLessThanOrEqual(
        IPC_HIDDEN_VIEW_MAX_QUEUE_BYTES
      );
      expect(h.ipcQueue.getQueuedBytes(id)).toBe(0);
      expect(ipcDataFor(h, id).length).toBe(
        Math.floor(IPC_HIDDEN_VIEW_MAX_QUEUE_BYTES / REDRAW_BYTES)
      );
    }
    expect(h.batcherWrite).not.toHaveBeenCalled();

    // One repaint notice per terminal for the whole stretch, and no
    // discontinuity marker anywhere.
    const statuses = statusEvents(h);
    expect(statuses.filter((e) => e.status === "data-loss" && !e.reason)).toHaveLength(0);
    const notices = statuses.filter((e) => e.reason === HIDDEN_VIEW_SKIP_REASON);
    expect(notices.map((e) => e.id).sort()).toEqual([...AGENTS].sort());

    // Main-side monitors still see every skipped redraw.
    const mirrored = h.events.filter((e) => e.type === "data-mirror" && e.id === "a1");
    expect(mirrored.length + ipcDataFor(h, "a1").length).toBe(durationMs / TICK_MS);

    // Back on screen: the ledger holds nothing, and output rides the port.
    show(h, "proj-a");
    for (const id of AGENTS) expect(h.ipcQueue.getHiddenQueuedBytes(id)).toBe(0);
    expect(h.ipcQueue.getQueueSnapshot().totalPendingBytes).toBe(0);
    h.events.length = 0;
    runAgents(h, AGENTS, 200);
    expect(h.batcherWrite).toHaveBeenCalled();
    expect(h.events.filter((e) => e.type === "data")).toHaveLength(0);

    // Away again: the cached view is fed from an empty budget, and the next
    // overflow is reported afresh.
    show(h, "proj-b");
    h.events.length = 0;
    runAgents(h, AGENTS, durationMs);
    for (const id of AGENTS) {
      expect(h.rawPauses.get(id)).toBe(0);
      expect(ipcDataFor(h, id).length).toBe(
        Math.floor(IPC_HIDDEN_VIEW_MAX_QUEUE_BYTES / REDRAW_BYTES)
      );
    }
    expect(statusEvents(h).filter((e) => e.reason === HIDDEN_VIEW_SKIP_REASON)).toHaveLength(
      AGENTS.length
    );
  });

  it("reports a skip after a snapshot request again", () => {
    const h = createHarness(["a1"], "proj-a");
    show(h, "proj-b");
    runAgents(h, ["a1"], IPC_MAX_PAUSE_MS);
    const notices = () => statusEvents(h).filter((e) => e.reason === HIDDEN_VIEW_SKIP_REASON);
    expect(notices()).toHaveLength(1);

    // The view repaints from a snapshot while the host still has its project
    // hidden (Main reactivates the view before it tells the host).
    h.queries["get-serialized-state"]!({
      type: "get-serialized-state",
      id: "a1",
      requestId: "r1",
    } as never);
    runAgents(h, ["a1"], 200);
    expect(notices()).toHaveLength(2);
  });

  it("still holds the PTY once the shown project's own copy hits a ledger that filled without a pause", () => {
    const h = createHarness(["a1"], "proj-a");
    show(h, "proj-a");
    // A second window holds a cached, portless view of proj-a, so the IPC copy
    // stays open beside the port: supplementary copies charge without pausing.
    h.fallbackEligibleProjects.add("proj-a");
    runAgents(h, ["a1"], 2 * 60 * 1000);
    expect(h.ipcQueue.isAtCapacity("a1", REDRAW_BYTES)).toBe(true);
    expect(h.rawPauses.get("a1")).toBe(0);

    // Now the port is saturated, so the IPC copy is the only delivery and the
    // full ledger rejects it. The pause it arms is what lets the safety timer
    // clear the stranded debt.
    h.batcherWrite.mockReturnValue(false);
    h.router.routeOutput("a1", REDRAW, undefined);
    expect(h.coordinators.get("a1")!.isReadPaused).toBe(true);

    vi.advanceTimersByTime(IPC_MAX_PAUSE_MS);
    expect(h.coordinators.get("a1")!.isReadPaused).toBe(false);
    expect(h.ipcQueue.getQueuedBytes("a1")).toBe(0);
  });

  it("keeps hidden debt out of the aggregate gate that paces the project on screen", () => {
    const hidden = Array.from({ length: 24 }, (_, i) => `h${i}`);
    const h = createHarness(hidden, "proj-a", ["s1"]);
    show(h, "proj-b");
    // Frozen cached panes fill their budgets: together far past the aggregate
    // high watermark, were they counted toward it.
    const chunksToFill = Math.ceil(IPC_HIDDEN_VIEW_MAX_QUEUE_BYTES / REDRAW_BYTES) + 1;
    for (let i = 0; i < chunksToFill; i++) {
      for (const id of hidden) h.router.routeOutput(id, REDRAW, undefined);
    }
    const hiddenDebt = hidden.reduce((sum, id) => sum + h.ipcQueue.getHiddenQueuedBytes(id), 0);
    expect(hiddenDebt).toBeGreaterThan(IPC_TOTAL_QUEUE_HIGH_WATERMARK_BYTES);

    // The shown terminal's port is saturated, so its copy goes over IPC as the
    // only delivery and is paced by the IPC ledger.
    h.batcherWrite.mockReturnValue(false);
    h.router.routeOutput("s1", REDRAW, undefined);

    expect(h.ipcQueue.getQueuedBytes("s1")).toBe(REDRAW_BYTES);
    expect(h.coordinators.get("s1")!.isReadPaused).toBe(false);
  });

  it("keeps a hidden project hidden when the last port fails", () => {
    const h = createHarness(["a1"], "proj-a");
    show(h, "proj-b");
    h.rendererConnections.clear();

    const durationMs = IPC_MAX_PAUSE_MS * 2;
    const written = runAgents(h, ["a1"], durationMs);

    expect(h.rawPauses.get("a1")).toBe(0);
    expect(written.get("a1")).toBe(durationMs / TICK_MS);
    expect(h.ipcQueue.getQueuedBytes("a1")).toBe(0);
    expect(statusEvents(h).filter((e) => e.reason === HIDDEN_VIEW_SKIP_REASON)).toHaveLength(1);
  });

  it("keeps the fallback primary at startup, before any project is routed", () => {
    const h = createHarness(["a1"], "proj-a");
    h.rendererConnections.clear();

    runAgents(h, ["a1"], IPC_MAX_PAUSE_MS * 1.5);

    expect(h.ipcQueue.getHiddenQueuedBytes("a1")).toBe(0);
    expect(h.coordinators.get("a1")!.isReadPaused).toBe(true);
  });

  it("treats a project shown in a window whose port failed as on screen", () => {
    const h = createHarness(["a1"], "proj-a");
    // Window 1 shows proj-a but its port is gone; window 2 shows proj-b.
    const conn = h.rendererConnections.get(1)!;
    h.rendererConnections.delete(1);
    h.rendererConnections.set(2, conn);
    show(h, "proj-a", 1);
    show(h, "proj-b", 2);
    h.fallbackEligibleProjects.add("proj-a");

    // Long enough to pass the high watermark, not long enough for the timer.
    const durationMs = IPC_MAX_PAUSE_MS * 1.5;
    const written = runAgents(h, ["a1"], durationMs);

    // The view on screen is a primary IPC consumer: its ledger paces the PTY.
    expect(h.ipcQueue.getHiddenQueuedBytes("a1")).toBe(0);
    expect(h.coordinators.get("a1")!.isReadPaused).toBe(true);
    expect(written.get("a1")).toBeLessThan(durationMs / TICK_MS);
    expect(statusEvents(h).filter((e) => e.reason === HIDDEN_VIEW_SKIP_REASON)).toHaveLength(0);
  });

  it("clears a project's IPC debt only when it comes back from being shown nowhere", () => {
    const h = createHarness(["a1"], "proj-a");
    show(h, "proj-a", 1);
    show(h, "proj-b", 2);
    h.ipcQueue.addBytes("a1", 4096);

    // Already on screen in window 1: a second window showing it changes nothing.
    show(h, "proj-a", 2);
    expect(h.ipcQueue.getQueuedBytes("a1")).toBe(4096);

    show(h, "proj-b", 1);
    show(h, "proj-b", 2);
    expect(h.ipcQueue.getQueuedBytes("a1")).toBe(4096);

    show(h, "proj-a", 1);
    expect(h.ipcQueue.getQueuedBytes("a1")).toBe(0);
  });

  it("leaves a paused terminal's debt to its safety timer when its project comes back", () => {
    const h = createHarness(["a1"], "proj-a");
    show(h, "proj-a");
    h.batcherWrite.mockReturnValue(false);
    // Primary IPC with no acks: the ledger pauses the PTY.
    runAgents(h, ["a1"], IPC_MAX_PAUSE_MS * 1.5);
    expect(h.coordinators.get("a1")!.isReadPaused).toBe(true);
    const debt = h.ipcQueue.getQueuedBytes("a1");

    show(h, "proj-b");
    show(h, "proj-a");
    expect(h.ipcQueue.getQueuedBytes("a1")).toBe(debt);
    expect(h.coordinators.get("a1")!.isReadPaused).toBe(true);

    vi.advanceTimersByTime(IPC_MAX_PAUSE_MS);
    expect(h.ipcQueue.getQueuedBytes("a1")).toBe(0);
    expect(h.coordinators.get("a1")!.isReadPaused).toBe(false);
  });
});
