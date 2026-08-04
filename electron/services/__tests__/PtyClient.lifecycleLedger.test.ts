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

function writeMessages(child: MockUtilityProcess): Array<{ id: string; data: string }> {
  return child.postMessage.mock.calls
    .map((call: unknown[]) => call[0] as { type?: string; id?: string; data?: string })
    .filter((msg) => msg?.type === "write")
    .map((msg) => ({ id: msg.id!, data: msg.data! }));
}

describe("PtyClient lifecycle ledger", () => {
  let mockChild: MockUtilityProcess;
  let PtyClientClass: typeof import("../PtyClient.js").PtyClient;
  let getLifecycleLedger: typeof import("../pty/lifecycleLedger.js").getLifecycleLedger;
  let disposeLifecycleLedger: typeof import("../pty/lifecycleLedger.js").disposeLifecycleLedger;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    shared.appMock.removeAllListeners();
    mockChild = createMockChild();
    shared.forkMock.mockReturnValue(mockChild);

    ({ PtyClient: PtyClientClass } = await import("../PtyClient.js"));
    ({ getLifecycleLedger, disposeLifecycleLedger } = await import("../pty/lifecycleLedger.js"));

    // Installed only after the dynamic imports resolve: a faked clock during
    // module re-execution can starve the import path and hang the hook (#11661).
    // Still ahead of the dispose below, which ran under the fake clock before.
    vi.useFakeTimers();
    disposeLifecycleLedger();
  });

  afterEach(() => {
    disposeLifecycleLedger();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createReadyClient(): import("../PtyClient.js").PtyClient {
    const client = new PtyClientClass();
    mockChild.emit("message", { type: "ready" });
    return client;
  }

  const baseOptions: PtyHostSpawnOptions = {
    cwd: "/repo/wt-a",
    cols: 80,
    rows: 24,
    launchAgentId: "claude",
    agentModelId: "opus",
    worktreeId: "wt-a",
    env: { ANTHROPIC_BASE_URL: "https://proxy.example" },
  };

  it("mints and stamps launchGeneration on every spawn of an id", () => {
    const client = createReadyClient();

    client.spawn("t1", baseOptions);
    client.kill("t1");
    client.spawn("t1", baseOptions);

    const spawns = spawnMessages(mockChild);
    expect(spawns.map((s) => s.options.launchGeneration)).toEqual([1, 2]);
    expect(getLifecycleLedger().currentGeneration("t1")).toBe(2);

    // Launch facts recorded with env provenance, never values.
    const entry = getLifecycleLedger().getEntry("t1");
    expect(entry?.facts).toMatchObject({
      launchAgentId: "claude",
      agentModelId: "opus",
      worktreeId: "wt-a",
      worktreeSource: "explicit",
    });
    expect(entry?.facts.env?.keys).toEqual(["ANTHROPIC_BASE_URL"]);
    expect(JSON.stringify(entry)).not.toContain("proxy.example");
  });

  it("replays crashed-host spawns under fresh generations and closes the old ones", () => {
    const client = createReadyClient();
    const ledger = getLifecycleLedger();
    client.spawn("t1", baseOptions);
    expect(ledger.currentGeneration("t1")).toBe(1);

    const restartedChild = createMockChild();
    shared.forkMock.mockReturnValue(restartedChild);
    vi.spyOn(Math, "random").mockReturnValue(0);
    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(200);
    restartedChild.emit("message", { type: "ready" });

    const replayed = spawnMessages(restartedChild);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.options.launchGeneration).toBe(2);
    expect(ledger.currentGeneration("t1")).toBe(2);

    // Old incarnation closed as a host crash; its journal slot is independent
    // of the replayed generation's.
    expect(ledger.recordClose("t1", 1, "late")).toMatchObject({
      accepted: false,
      reason: "duplicate-close",
    });
    expect(ledger.recordJournal("t1", 1, "sess-before-crash").accepted).toBe(true);
    expect(ledger.recordJournal("t1", 2, "sess-after-crash").accepted).toBe(true);
  });

  it("re-injects postSpawnInput on crash respawn so wrapper-less shells resume (#11339)", () => {
    const client = createReadyClient();
    // A command launch on a shell that can't host a startup wrapper (fish,
    // nushell, unrecognized Windows shell): the IPC handler puts the launch
    // command on `postSpawnInput` instead of in `args`.
    client.spawn("t1", { ...baseOptions, postSpawnInput: "claude --resume s-1\r" });

    // Delivery is bound to spawn success on the host (#11341), so Main sends no
    // separate write — the command rides the spawn options instead.
    expect(writeMessages(mockChild)).toEqual([]);

    const restartedChild = createMockChild();
    shared.forkMock.mockReturnValue(restartedChild);
    vi.spyOn(Math, "random").mockReturnValue(0);
    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(200);
    restartedChild.emit("message", { type: "ready" });

    const replayed = spawnMessages(restartedChild);
    expect(replayed).toHaveLength(1);
    // The command survives replay on the spawn options, so the fresh host
    // re-injects it exactly once on success — the terminal comes back running
    // its command (here a resume), not a bare prompt. No separate Main write.
    expect(replayed[0]!.options.postSpawnInput).toBe("claude --resume s-1\r");
    expect(writeMessages(restartedChild)).toEqual([]);
  });

  it("replays wrapper args verbatim on crash respawn — a resume survives (#11339)", () => {
    const client = createReadyClient();
    // Wrapper-capable shells (zsh/bash/sh/pwsh/cmd) embed the launch command in
    // `args`, so a resume launch already resumes on verbatim replay — no
    // postSpawnInput and no separate write should appear.
    const wrapperArgs = [
      "-lic",
      "trap : INT\nclaude --resume s-1\ntrap - INT\nexec '/bin/bash' -l",
    ];
    client.spawn("t1", {
      ...baseOptions,
      shell: "/bin/bash",
      args: wrapperArgs,
      command: "claude --resume s-1",
    });

    const restartedChild = createMockChild();
    shared.forkMock.mockReturnValue(restartedChild);
    vi.spyOn(Math, "random").mockReturnValue(0);
    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(200);
    restartedChild.emit("message", { type: "ready" });

    const replayed = spawnMessages(restartedChild);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.options.shell).toBe("/bin/bash");
    expect(replayed[0]!.options.args).toEqual(wrapperArgs);
    expect(replayed[0]!.options.postSpawnInput).toBeUndefined();
    // No stray post-spawn write for a wrapper shell.
    expect(writeMessages(restartedChild)).toHaveLength(0);
  });

  it("keeps the same generation for the initial-ready replay (nothing was delivered)", () => {
    // Deferred start: spawn before the host is ready.
    const client = new PtyClientClass({ deferStart: true });
    client.start();
    client.spawn("t1", baseOptions);
    mockChild.emit("message", { type: "ready" });

    const spawns = spawnMessages(mockChild);
    // One replayed spawn on ready (the pre-ready send is dropped by transport,
    // but both stamped messages carry the SAME generation — same incarnation).
    expect(spawns.length).toBeGreaterThanOrEqual(1);
    for (const spawn of spawns) {
      expect(spawn.options.launchGeneration).toBe(1);
    }
    expect(getLifecycleLedger().currentGeneration("t1")).toBe(1);
  });

  it("attributes exit events to the generation they carry, not the successor", () => {
    const client = createReadyClient();
    const ledger = getLifecycleLedger();

    client.spawn("t1", baseOptions);
    client.kill("t1");
    client.spawn("t1", baseOptions); // restart reuses the id → generation 2

    // The killed incarnation's exit arrives late, stamped with generation 1.
    mockChild.emit("message", { type: "exit", id: "t1", exitCode: 137, launchGeneration: 1 });

    const entry = ledger.getEntry("t1");
    expect(entry?.generation).toBe(2);
    expect(entry?.closedAt).toBeUndefined();

    // The live incarnation's own exit still closes it.
    mockChild.emit("message", { type: "exit", id: "t1", exitCode: 0, launchGeneration: 2 });
    expect(ledger.getEntry("t1")?.closedAt).toBeDefined();
    expect(ledger.getEntry("t1")?.exitCode).toBe(0);
  });

  it("records spawn failures as resolved+closed for the failing generation", () => {
    const client = createReadyClient();
    const ledger = getLifecycleLedger();

    client.spawn("t1", baseOptions);
    mockChild.emit("message", {
      type: "spawn-result",
      id: "t1",
      result: { success: false, id: "t1", error: { code: "ENOENT", message: "no shell" } },
    });

    const entry = ledger.getEntry("t1");
    expect(entry?.spawnOk).toBe(false);
    expect(entry?.closedAt).toBeDefined();
    expect(entry?.closeReason).toBe("spawn-failed:ENOENT");
  });

  it("a stale spawn failure from a killed predecessor cannot clear the successor", () => {
    const client = createReadyClient();
    const ledger = getLifecycleLedger();

    client.spawn("t1", baseOptions); // generation 1
    client.kill("t1");
    client.spawn("t1", baseOptions); // generation 2, live

    // The predecessor's failure result arrives late, stamped with its own
    // generation. It must neither drop the successor's pendingSpawns entry
    // (host-crash replay would lose the terminal) nor close its ledger entry.
    mockChild.emit("message", {
      type: "spawn-result",
      id: "t1",
      result: {
        success: false,
        id: "t1",
        launchGeneration: 1,
        error: { code: "ENOENT", message: "no shell" },
      },
    });

    expect(client.hasTerminal("t1")).toBe(true);
    const entry = ledger.getEntry("t1");
    expect(entry?.generation).toBe(2);
    expect(entry?.closedAt).toBeUndefined();
    expect(entry?.spawnOk).toBeUndefined();
  });

  it("records successful spawn resolution", () => {
    const client = createReadyClient();
    client.spawn("t1", baseOptions);
    mockChild.emit("message", {
      type: "spawn-result",
      id: "t1",
      result: { success: true, id: "t1" },
    });
    expect(getLifecycleLedger().getEntry("t1")?.spawnOk).toBe(true);
  });

  describe("resize-result generation filtering (#11641)", () => {
    function emitResizeResult(
      client: import("../PtyClient.js").PtyClient,
      launchGeneration: number | null
    ): Array<[string, unknown]> {
      const seen: Array<[string, unknown]> = [];
      client.on("resize-result", (id: string, result: unknown) => seen.push([id, result]));
      mockChild.emit("message", {
        type: "resize-result",
        id: "t1",
        result: {
          launchGeneration,
          requestedCols: 120,
          requestedRows: 40,
          appliedCols: 120,
          appliedRows: 40,
          outcome: "applied",
        },
      });
      return seen;
    }

    it("forwards a result stamped with the live incarnation", () => {
      const client = createReadyClient();
      client.spawn("t1", baseOptions);

      expect(emitResizeResult(client, 1)).toHaveLength(1);
    });

    it("drops a result from an incarnation that was already replaced", () => {
      const client = createReadyClient();
      client.spawn("t1", baseOptions);
      client.kill("t1");
      client.spawn("t1", baseOptions);

      // Generation 1's echo lands after the same id respawned. Applying it
      // would report the dead PTY's geometry as the successor's.
      expect(emitResizeResult(client, 1)).toHaveLength(0);
      expect(emitResizeResult(client, 2)).toHaveLength(1);
    });

    it("drops a result that carries no incarnation at all", () => {
      const client = createReadyClient();
      client.spawn("t1", baseOptions);

      expect(emitResizeResult(client, null)).toHaveLength(0);
    });
  });
});
