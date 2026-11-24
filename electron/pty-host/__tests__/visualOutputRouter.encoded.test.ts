import { afterEach, describe, expect, it, vi } from "vitest";
import { createVisualOutputRouter } from "../visualOutputRouter.js";
import { IpcQueueManager } from "../ipcQueue.js";
import type { RendererConnection } from "../handlers/types.js";
import type { PtyHostEvent } from "../../../shared/types/pty-host.js";

function createRouter(
  options: {
    analysisEnabled?: boolean;
    windows?: number;
    shownProject?: string;
    metrics?: boolean;
  } = {}
) {
  const terminal = {
    id: "t1",
    projectId: "proj-a",
    contentEpoch: 0,
    lastInputTime: 0,
    analysisEnabled: options.analysisEnabled ?? false,
  };
  const events: PtyHostEvent[] = [];
  const sendEvent = (event: PtyHostEvent) => events.push(event);
  const writes: ReturnType<typeof vi.fn>[] = [];
  const rendererConnections = new Map<number, RendererConnection>();
  for (let window = 1; window <= (options.windows ?? 1); window++) {
    const write = vi.fn(() => true);
    writes.push(write);
    rendererConnections.set(window, {
      port: { postMessage: vi.fn() },
      batcher: { write },
      holderWebContentsId: 100 + window,
    } as unknown as RendererConnection);
  }
  const frame = vi.fn(() => null);
  const analysisWrite = vi.fn(() => 1);
  const ipcQueue = new IpcQueueManager({
    getTerminal: () => undefined,
    getPauseCoordinator: () => undefined,
    sendEvent,
    metricsEnabled: () => false,
    emitTerminalStatus: vi.fn(),
    emitReliabilityMetric: vi.fn(),
  });
  const router = createVisualOutputRouter({
    getTerminal: ((id: string) => (id === "t1" ? terminal : undefined)) as never,
    backpressureManager: { isSuspended: () => false } as never,
    ipcQueueManager: ipcQueue,
    rendererConnections,
    terminalWorkerConnections: new Map(),
    windowProjectMap: new Map(
      options.shownProject === undefined ? [] : [[9, options.shownProject] as const]
    ),
    fallbackEligibleProjects: new Set(),
    frozenViewProjects: new Set(),
    ipcDataMirrorTerminals: new Set(),
    packetFramer: { frame } as never,
    getVisualBuffers: () => [],
    getVisualSignalView: () => null,
    getAnalysisBuffer: () => ({ write: analysisWrite }) as never,
    getPauseCoordinator: () => undefined,
    getOrCreatePauseCoordinator: () => undefined,
    recordDrop: vi.fn(),
    emitReliabilityMetric: vi.fn(),
    sendEvent,
    metricsEnabled: () => options.metrics ?? false,
  });
  return { router, writes, frame, events, ipcQueue };
}

describe("VisualOutputRouter with pre-encoded output", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands a sole window the terminal's own bytes without encoding again", () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const { router, writes } = createRouter();
    const encoded = new TextEncoder().encode("héllo │");
    encode.mockClear();

    router.routeOutput("t1", "héllo │", 42, encoded);

    expect(encode).not.toHaveBeenCalled();
    const [, chunk, byteCount, owned] = writes[0].mock.calls[0];
    expect(chunk).toBe(encoded);
    expect(byteCount).toBe(Buffer.byteLength("héllo │", "utf8"));
    expect(owned).toBe(true);
  });

  it("shares the bytes with the analysis frame and keeps them from the batcher", () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const { router, writes, frame } = createRouter({ analysisEnabled: true });
    const encoded = new TextEncoder().encode("agent output");
    encode.mockClear();

    router.routeOutput("t1", "agent output", 12, encoded);

    expect(encode).not.toHaveBeenCalled();
    expect(writes[0].mock.calls[0][3]).toBe(false);
    expect(frame).toHaveBeenCalledWith("t1", encoded);
  });

  it("never lets one of several windows own the bytes", () => {
    const { router, writes } = createRouter({ windows: 2 });
    const encoded = new TextEncoder().encode("two windows");

    router.routeOutput("t1", "two windows", 11, encoded);

    expect(writes.map((write) => write.mock.calls[0][3])).toEqual([false, false]);
    expect(writes.map((write) => write.mock.calls[0][1])).toEqual([encoded, encoded]);
  });

  it.each([
    ["with its bytes", true],
    ["without its bytes", false],
  ])("charges IPC queues and throughput the chunk's UTF-8 length %s", (_label, withBytes) => {
    const text = "héllo │";
    const bytes = Buffer.byteLength(text, "utf8");
    const encoded = withBytes ? new TextEncoder().encode(text) : undefined;

    // No port and the project on screen: the primary IPC fallback carries it.
    const primary = createRouter({ windows: 0, shownProject: "proj-a", metrics: true });
    primary.router.routeOutput("t1", text, bytes, encoded);
    expect(primary.ipcQueue.getQueuedBytes("t1")).toBe(bytes);
    expect(primary.router.takeThroughputAccumulator().get("t1")?.totalBytes).toBe(bytes);

    // A window shows another project: only a cached view's budgeted copy goes out.
    const hidden = createRouter({ windows: 0, shownProject: "proj-b" });
    hidden.router.routeOutput("t1", text, bytes, encoded);
    expect(hidden.ipcQueue.getHiddenQueuedBytes("t1")).toBe(bytes);
    expect(hidden.events.filter((event) => event.type === "data")).toHaveLength(1);
  });

  it("still encodes a string that arrives without its bytes", () => {
    const { router, writes, frame } = createRouter({ analysisEnabled: true });

    router.routeOutput("t1", "héllo", 6);

    const [, chunk, byteCount, owned] = writes[0].mock.calls[0];
    expect(Buffer.from(chunk as Uint8Array).toString("utf8")).toBe("héllo");
    expect(byteCount).toBe(6);
    expect(owned).toBe(true);
    expect(frame).toHaveBeenCalledWith("t1", "héllo");
  });
});
