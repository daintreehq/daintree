import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { EventEmitter } from "events";

const shared = vi.hoisted(() => ({
  forkMock: vi.fn(),
  tracker: {
    removeTrashed: vi.fn(),
    persistTrashed: vi.fn(),
    clearAll: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  utilityProcess: {
    fork: shared.forkMock,
  },
  UtilityProcess: EventEmitter,
  MessagePortMain: class {},
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  },
}));

vi.mock("../TrashedPidTracker.js", () => ({
  getTrashedPidTracker: () => shared.tracker,
}));

interface MockUtilityProcess extends EventEmitter {
  postMessage: Mock;
  kill: Mock;
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid?: number;
}

interface MockMessagePortMain {
  close: Mock;
}

interface PtyClientPrivateAccess {
  child: MockUtilityProcess | null;
  pendingMessagePorts: Map<number, MockMessagePortMain>;
}

function createMockChild(): MockUtilityProcess {
  return Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 321,
  });
}

function createMockPort(): MockMessagePortMain {
  return {
    close: vi.fn(),
  };
}

describe("PtyClient adversarial", () => {
  let mockChild: MockUtilityProcess;
  let PtyClientClass: typeof import("../PtyClient.js").PtyClient;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    mockChild = createMockChild();
    shared.forkMock.mockReturnValue(mockChild);

    ({ PtyClient: PtyClientClass } = await import("../PtyClient.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createReadyClient(
    config?: import("../PtyClient.js").PtyClientConfig
  ): import("../PtyClient.js").PtyClient {
    const client = new PtyClientClass(config);
    mockChild.emit("message", { type: "ready" });
    return client;
  }

  it("DOUBLE_RESUME_HANDSHAKE_COALESCES", () => {
    const client = createReadyClient({ healthCheckIntervalMs: 1000 });

    client.pauseHealthCheck();
    mockChild.postMessage.mockClear();
    client.resumeHealthCheck();
    client.resumeHealthCheck();

    mockChild.emit("message", { type: "pong" });
    vi.advanceTimersByTime(3000);

    const healthChecks = mockChild.postMessage.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type?: string })?.type === "health-check"
    );
    expect(healthChecks).toHaveLength(4);
  });

  it("LATE_PONG_AFTER_HANDSHAKE_TIMEOUT_DOES_NOT_DUPLICATE_INTERVAL", () => {
    const client = createReadyClient({ healthCheckIntervalMs: 1000 });

    client.pauseHealthCheck();
    mockChild.postMessage.mockClear();
    client.resumeHealthCheck();

    vi.advanceTimersByTime(5000);
    mockChild.emit("message", { type: "pong" });
    vi.advanceTimersByTime(3000);

    const healthChecks = mockChild.postMessage.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type?: string })?.type === "health-check"
    );
    expect(healthChecks).toHaveLength(4);
  });

  it("REPLACING_PENDING_PORT_ONLY_FORWARDS_NEW_PORT", () => {
    const client = createReadyClient();
    const privateAccess = client as unknown as PtyClientPrivateAccess;
    const oldPort = createMockPort();
    const newPort = createMockPort();
    const restartedChild = createMockChild();

    privateAccess.child = null;
    client.connectMessagePort(7, oldPort as unknown as import("electron").MessagePortMain);
    client.connectMessagePort(7, newPort as unknown as import("electron").MessagePortMain);
    shared.forkMock.mockReturnValue(restartedChild);

    client.manualRestart();
    restartedChild.emit("message", { type: "ready" });

    expect(oldPort.close).toHaveBeenCalledTimes(1);
    expect(restartedChild.postMessage).toHaveBeenCalledWith({ type: "connect-port", windowId: 7 }, [
      newPort,
    ]);
    expect(restartedChild.postMessage).not.toHaveBeenCalledWith(
      { type: "connect-port", windowId: 7 },
      [oldPort]
    );
  });

  it("CONTEXT_REPLAY_ORDER_AFTER_PORT_TRANSITION", () => {
    const client = createReadyClient();
    const privateAccess = client as unknown as PtyClientPrivateAccess;
    const port = createMockPort();
    const restartedChild = createMockChild();

    privateAccess.child = null;
    client.connectMessagePort(4, port as unknown as import("electron").MessagePortMain);
    client.setActiveProject(4, "project-a", "/projects/a");
    shared.forkMock.mockReturnValue(restartedChild);

    client.manualRestart();
    restartedChild.emit("message", { type: "ready" });

    const messageTypes = restartedChild.postMessage.mock.calls.map(
      (call: unknown[]) => (call[0] as { type?: string })?.type
    );
    expect(messageTypes.indexOf("connect-port")).toBeGreaterThanOrEqual(0);
    expect(messageTypes.indexOf("set-active-project")).toBeGreaterThan(
      messageTypes.indexOf("connect-port")
    );
  });

  it("TERMINAL_STATUS_ORDER_SURVIVES_RESTART", () => {
    const client = createReadyClient();
    const restartedChild = createMockChild();
    const statuses: string[] = [];
    client.on("terminal-status", (payload: { status: string }) => {
      statuses.push(payload.status);
    });
    shared.forkMock.mockReturnValue(restartedChild);

    mockChild.emit("message", {
      type: "terminal-status",
      id: "t1",
      status: "paused-backpressure",
      timestamp: 1,
    });
    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(2000);
    restartedChild.emit("message", { type: "ready" });
    restartedChild.emit("message", {
      type: "terminal-status",
      id: "t1",
      status: "running",
      timestamp: 2,
    });

    expect(statuses).toEqual(["paused-backpressure", "running"]);
  });

  it("DISPOSE_RESOLVES_ORPHANED_PENDING_OPS", async () => {
    const client = createReadyClient();
    const privateAccess = client as unknown as PtyClientPrivateAccess;
    const pendingPort = createMockPort();

    privateAccess.child = null;
    client.connectMessagePort(9, pendingPort as unknown as import("electron").MessagePortMain);
    privateAccess.child = mockChild;

    const terminalPromise = client.getTerminalAsync("t1");
    const snapshotPromise = client.getTerminalSnapshot("t1");
    const allSnapshotsPromise = client.getAllTerminalSnapshots();
    const transitionPromise = client.transitionState("t1", { type: "busy" }, "output", 1);

    client.dispose();

    await expect(terminalPromise).resolves.toBeNull();
    await expect(snapshotPromise).resolves.toBeNull();
    await expect(allSnapshotsPromise).resolves.toEqual([]);
    await expect(transitionPromise).resolves.toBe(false);
    expect(pendingPort.close).toHaveBeenCalledTimes(1);
    expect(mockChild.postMessage).toHaveBeenCalledWith({ type: "dispose" });

    vi.advanceTimersByTime(1000);
    expect(mockChild.kill).toHaveBeenCalledTimes(1);
  });
});
