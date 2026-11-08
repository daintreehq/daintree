import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { EventEmitter } from "events";
import type { PtyHostSpawnOptions, SpawnResult } from "../../../shared/types/pty-host.js";

const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  const appEmitter = new EventEmitter();
  const appMock = Object.assign(appEmitter, {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  });
  return {
    forkMock: vi.fn(),
    tracker: { removeTrashed: vi.fn(), persistTrashed: vi.fn(), clearAll: vi.fn() },
    appMock,
  };
});

vi.mock("electron", () => ({
  utilityProcess: { fork: shared.forkMock },
  UtilityProcess: EventEmitter,
  MessagePortMain: class {},
  app: shared.appMock,
}));

vi.mock("../TrashedPidTracker.js", () => ({
  getTrashedPidTracker: () => shared.tracker,
}));

vi.mock("../../utils/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  isValidLogOverrideLevel: vi.fn(() => true),
  ingestHostLogEvent: vi.fn(),
}));

interface MockUtilityProcess extends EventEmitter {
  postMessage: Mock;
  kill: Mock;
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid?: number;
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

function spawnMessages(child: MockUtilityProcess, id: string): unknown[] {
  return child.postMessage.mock.calls
    .map((call: unknown[]) => call[0] as { type?: string; id?: string })
    .filter((msg) => msg?.type === "spawn" && msg.id === id);
}

describe("PtyClient refuses a spawn into a project still awaiting its clone (#16352)", () => {
  let mockChild: MockUtilityProcess;
  let PtyClientClass: typeof import("../PtyClient.js").PtyClient;
  let gate: typeof import("../projectClone/checkoutGate.js");
  let disposeLifecycleLedger: typeof import("../pty/lifecycleLedger.js").disposeLifecycleLedger;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    shared.appMock.removeAllListeners();
    mockChild = createMockChild();
    shared.forkMock.mockReturnValue(mockChild);
    ({ PtyClient: PtyClientClass } = await import("../PtyClient.js"));
    gate = await import("../projectClone/checkoutGate.js");
    ({ disposeLifecycleLedger } = await import("../pty/lifecycleLedger.js"));
    vi.useFakeTimers();
    disposeLifecycleLedger();
  });

  afterEach(() => {
    gate.resetCheckoutGateForTests();
    disposeLifecycleLedger();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const options = (projectId?: string): PtyHostSpawnOptions => ({
    cwd: "/work/widgets",
    cols: 80,
    rows: 24,
    launchAgentId: "claude",
    ...(projectId ? { projectId } : {}),
  });

  function readyClient() {
    const client = new PtyClientClass();
    mockChild.emit("message", { type: "ready" });
    const results: SpawnResult[] = [];
    client.on("spawn-result", (_id: string, result: SpawnResult) => results.push(result));
    return { client, results };
  }

  it("answers with PROJECT_NOT_READY and sends nothing to the pty-host", () => {
    const { client, results } = readyClient();
    gate.markCheckoutPending("p-clone", "/work/widgets");

    client.spawn("t1", options("p-clone"));

    expect(results).toEqual([
      expect.objectContaining({
        success: false,
        id: "t1",
        error: expect.objectContaining({ code: "PROJECT_NOT_READY" }),
      }),
    ]);
    expect(spawnMessages(mockChild, "t1")).toHaveLength(0);
  });

  it("spawns into the project once its clone has landed", () => {
    const { client, results } = readyClient();
    gate.markCheckoutPending("p-clone", "/work/widgets");
    gate.clearCheckoutPending("p-clone");

    client.spawn("t1", options("p-clone"));

    expect(results).toEqual([]);
    expect(spawnMessages(mockChild, "t1")).toHaveLength(1);
  });

  it("leaves a spawn naming another project alone", () => {
    const { client, results } = readyClient();
    gate.markCheckoutPending("p-clone", "/work/widgets");

    client.spawn("t1", options("p-ready"));

    expect(results).toEqual([]);
    expect(spawnMessages(mockChild, "t1")).toHaveLength(1);
  });
});
