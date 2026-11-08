import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVisualOutputRouter, type VisualOutputRouter } from "../visualOutputRouter.js";
import { IpcQueueManager } from "../ipcQueue.js";
import { PtyPauseCoordinator } from "../PtyPauseCoordinator.js";
import { createConnectionHandlers } from "../handlers/connection.js";
import { createTerminalQueryHandlers } from "../handlers/terminalQueries.js";
import type { HandlerMap, HostContext, RendererConnection } from "../handlers/types.js";
import { HIDDEN_VIEW_SKIP_REASON, type PtyHostEvent } from "../../../shared/types/pty-host.js";
import { IPC_HIDDEN_VIEW_MAX_QUEUE_BYTES, IPC_MAX_PAUSE_MS } from "../../services/pty/types.js";

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

function createHarness(terminalIds: string[], projectId: string): Harness {
  const terminals = new Map<string, Terminal>(
    terminalIds.map((id) => [
      id,
      { id, projectId, contentEpoch: 0, lastInputTime: 0, analysisEnabled: false },
    ])
  );
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
  // The cached view of the project holds no port, so Main keeps it eligible.
  const fallbackEligibleProjects = new Set<string>([projectId]);
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
function show(h: Harness, projectId: string): void {
  h.connection["project-switch"]!({ type: "project-switch", windowId: 1, projectId } as never);
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
      // The cached view was fed until its budget filled, and no further.
      expect(h.ipcQueue.getQueuedBytes(id)).toBeLessThanOrEqual(IPC_HIDDEN_VIEW_MAX_QUEUE_BYTES);
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
    for (const id of AGENTS) expect(h.ipcQueue.getQueuedBytes(id)).toBe(0);
    expect(h.ipcQueue.getTotalQueuedBytes()).toBe(0);
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

  it("reports a skip after a snapshot request again, so a view that repainted early catches up", () => {
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
});
