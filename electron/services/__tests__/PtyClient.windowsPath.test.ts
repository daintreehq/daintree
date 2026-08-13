import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { EventEmitter } from "events";
import type { PtyHostSpawnOptions } from "../../../shared/types/pty-host.js";

const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  const appEmitter = new EventEmitter();
  const appMock = Object.assign(appEmitter, {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
  });
  return {
    forkMock: vi.fn(),
    tracker: {
      removeTrashed: vi.fn(),
      persistTrashed: vi.fn(),
      clearAll: vi.fn(),
    },
    appMock,
  };
});

vi.mock("electron", () => ({
  utilityProcess: {
    fork: shared.forkMock,
  },
  UtilityProcess: EventEmitter,
  MessagePortMain: class {},
  app: shared.appMock,
}));

vi.mock("../TrashedPidTracker.js", () => ({
  getTrashedPidTracker: () => shared.tracker,
}));

vi.mock("../../utils/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  isValidLogOverrideLevel: vi.fn(() => true),
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

function spawnMessages(
  child: MockUtilityProcess
): Array<{ id: string; options: PtyHostSpawnOptions }> {
  return child.postMessage.mock.calls
    .map(
      (call: unknown[]) => call[0] as { type?: string; id?: string; options?: PtyHostSpawnOptions }
    )
    .filter((msg) => msg?.type === "spawn")
    .map((msg) => ({ id: msg.id!, options: msg.options! }));
}

/**
 * The pty-host holds the environment it was forked with for its whole life, so
 * the spawn message is the only carrier for a PATH that changed since (#11773).
 * These assert what actually goes on the wire.
 */
describe("PtyClient Windows PATH stamping", () => {
  const realPlatform = process.platform;
  const setPlatform = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  };

  let mockChild: MockUtilityProcess;
  let PtyClientClass: typeof import("../PtyClient.js").PtyClient;
  let disposeLifecycleLedger: typeof import("../pty/lifecycleLedger.js").disposeLifecycleLedger;
  let getLifecycleLedger: typeof import("../pty/lifecycleLedger.js").getLifecycleLedger;
  let originalPath: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    shared.appMock.removeAllListeners();
    mockChild = createMockChild();
    shared.forkMock.mockReturnValue(mockChild);
    originalPath = process.env.PATH;

    ({ PtyClient: PtyClientClass } = await import("../PtyClient.js"));
    ({ getLifecycleLedger, disposeLifecycleLedger } = await import("../pty/lifecycleLedger.js"));

    // Install after imports: fake timers can stall module re-execution (#11661).
    vi.useFakeTimers();
    disposeLifecycleLedger();
  });

  afterEach(() => {
    disposeLifecycleLedger();
    vi.useRealTimers();
    vi.restoreAllMocks();
    setPlatform(realPlatform);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  });

  // Constructed on the real platform so host-fork wiring behaves normally; the
  // stamp is read at send time, which is all these exercise.
  function createReadyClient(): import("../PtyClient.js").PtyClient {
    const client = new PtyClientClass();
    mockChild.emit("message", { type: "ready" });
    return client;
  }

  const baseOptions: PtyHostSpawnOptions = { cwd: "C:\\repo", cols: 80, rows: 24 };

  it("stamps main's current PATH onto a Windows spawn", () => {
    const client = createReadyClient();
    process.env.PATH = "C:\\Windows;C:\\Python313";
    setPlatform("win32");

    client.spawn("t1", baseOptions);

    expect(spawnMessages(mockChild)[0]?.options.env).toEqual({ PATH: "C:\\Windows;C:\\Python313" });
  });

  it("merges the PATH alongside a caller's other env vars", () => {
    const client = createReadyClient();
    process.env.PATH = "C:\\Windows";
    setPlatform("win32");

    client.spawn("t1", { ...baseOptions, env: { ANTHROPIC_BASE_URL: "https://proxy.example" } });

    expect(spawnMessages(mockChild)[0]?.options.env).toEqual({
      ANTHROPIC_BASE_URL: "https://proxy.example",
      PATH: "C:\\Windows",
    });
  });

  it("yields to a caller-supplied PATH under any casing", () => {
    const client = createReadyClient();
    process.env.PATH = "C:\\Windows";
    setPlatform("win32");

    client.spawn("t1", { ...baseOptions, env: { Path: "C:\\Custom" } });

    const env = spawnMessages(mockChild)[0]?.options.env;
    expect(env).toEqual({ Path: "C:\\Custom" });
  });

  it("treats a deliberately empty PATH as a choice, not an absence", () => {
    const client = createReadyClient();
    process.env.PATH = "C:\\Windows";
    setPlatform("win32");

    client.spawn("t1", { ...baseOptions, env: { PATH: "" } });

    expect(spawnMessages(mockChild)[0]?.options.env).toEqual({ PATH: "" });
  });

  it("does not mutate the caller's options or env object", () => {
    const client = createReadyClient();
    process.env.PATH = "C:\\Windows";
    setPlatform("win32");
    const callerEnv = { ANTHROPIC_BASE_URL: "https://proxy.example" };
    const callerOptions = { ...baseOptions, env: callerEnv };

    client.spawn("t1", callerOptions);

    expect(callerEnv).toEqual({ ANTHROPIC_BASE_URL: "https://proxy.example" });
    expect(callerOptions.env).toBe(callerEnv);
  });

  it("keeps the implicit PATH out of lifecycle-ledger env provenance", () => {
    const client = createReadyClient();
    process.env.PATH = "C:\\Windows";
    setPlatform("win32");

    client.spawn("t1", { ...baseOptions, env: { ANTHROPIC_BASE_URL: "https://proxy.example" } });

    expect(getLifecycleLedger().getEntry("t1")?.facts.env?.keys).toEqual(["ANTHROPIC_BASE_URL"]);
  });

  it("re-stamps a changed PATH when a crashed host replays the spawn", () => {
    const client = createReadyClient();
    process.env.PATH = "C:\\Windows";
    setPlatform("win32");
    client.spawn("t1", baseOptions);

    const restartedChild = createMockChild();
    shared.forkMock.mockReturnValue(restartedChild);
    vi.spyOn(Math, "random").mockReturnValue(0);
    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(200);

    // The tool the user installed while the host was down must be on the PATH
    // of the replayed terminal, not the one captured when it first opened.
    process.env.PATH = "C:\\Windows;C:\\Python313";
    restartedChild.emit("message", { type: "ready" });

    const replayed = spawnMessages(restartedChild);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.options.env?.PATH).toBe("C:\\Windows;C:\\Python313");
  });

  it("leaves POSIX spawns untouched", () => {
    const client = createReadyClient();
    process.env.PATH = "/usr/bin";
    setPlatform("darwin");

    client.spawn("t1", { ...baseOptions, env: { ANTHROPIC_BASE_URL: "https://proxy.example" } });
    client.spawn("t2", baseOptions);

    const spawns = spawnMessages(mockChild);
    expect(spawns[0]?.options.env).toEqual({ ANTHROPIC_BASE_URL: "https://proxy.example" });
    expect(spawns[1]?.options.env).toBeUndefined();
  });
});
