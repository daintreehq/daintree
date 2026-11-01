import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { EventEmitter } from "events";
import type { PtyHostSpawnOptions } from "../../../shared/types/pty-host.js";
import type { TerminalLifecycleObservation } from "../../../shared/utils/pluginTerminalLifecycle.js";

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
    ingestHostLogEvent: vi.fn(),
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
  ingestHostLogEvent: shared.ingestHostLogEvent,
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
  let events: typeof import("../events.js").events;
  let startTerminalLifecycleObserver: typeof import("../pty/TerminalLifecycleObserver.js").startTerminalLifecycleObserver;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    shared.appMock.removeAllListeners();
    mockChild = createMockChild();
    shared.forkMock.mockReturnValue(mockChild);

    ({ PtyClient: PtyClientClass } = await import("../PtyClient.js"));
    ({ getLifecycleLedger, disposeLifecycleLedger } = await import("../pty/lifecycleLedger.js"));
    ({ events } = await import("../events.js"));
    ({ startTerminalLifecycleObserver } = await import("../pty/TerminalLifecycleObserver.js"));

    // Install after imports: fake timers can stall module re-execution (#11661).
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

  it("delivers a host log event all the way to the logger's ingest path (#12544)", () => {
    const client = createReadyClient();
    const logEvent = {
      type: "log" as const,
      timestamp: 1_700_000_000_000,
      level: "warn" as const,
      source: "pty-host:Graceful",
      message: "Graceful capture drain ended",
      contextJson: '{"drained":true}',
    };

    mockChild.emit("message", logEvent);

    // Proves the whole chain — PtyHostLifecycle intercept, the PtyShard
    // callback, and PtyClient's wiring — not just the interception.
    expect(shared.ingestHostLogEvent).toHaveBeenCalledTimes(1);
    expect(shared.ingestHostLogEvent).toHaveBeenCalledWith(logEvent);

    client.dispose();
  });

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
    client.suppressExitForRestart("t1");

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
    expect(client.consumeRestartExitSuppression("t1")).toBe(false);

    // Old incarnation closed as a host crash; its journal slot is independent
    // of the replayed generation's.
    expect(ledger.recordClose("t1", 1, "late")).toMatchObject({
      accepted: false,
      reason: "duplicate-close",
    });
    expect(ledger.recordJournal("t1", 1, "sess-before-crash").accepted).toBe(true);
    expect(ledger.recordJournal("t1", 2, "sess-after-crash").accepted).toBe(true);
  });

  it("reports the incarnation a crashed host took with it before replaying the terminal (#15976)", () => {
    const client = createReadyClient();
    const lost = vi.fn();
    client.on("incarnation-lost", lost);
    client.spawn("t1", baseOptions);

    const restartedChild = createMockChild();
    shared.forkMock.mockReturnValue(restartedChild);
    vi.spyOn(Math, "random").mockReturnValue(0);
    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(200);
    expect(lost).not.toHaveBeenCalled();
    restartedChild.emit("message", { type: "ready" });

    expect(lost).toHaveBeenCalledExactlyOnceWith({ terminalId: "t1", launchGeneration: 1 });
    expect(spawnMessages(restartedChild)[0]?.options.launchGeneration).toBe(2);
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

  it("delivers a launch's handback code once, never on a crash respawn (#12488)", () => {
    const client = createReadyClient();
    client.spawn("t1", { ...baseOptions, handbackCode: "k7f3qa" });

    expect(spawnMessages(mockChild)[0]!.options.handbackCode).toBe("k7f3qa");

    const restartedChild = createMockChild();
    shared.forkMock.mockReturnValue(restartedChild);
    vi.spyOn(Math, "random").mockReturnValue(0);
    mockChild.emit("exit", 1);
    vi.advanceTimersByTime(200);
    restartedChild.emit("message", { type: "ready" });

    const replayed = spawnMessages(restartedChild);
    expect(replayed).toHaveLength(1);
    // The request died with its host, so the replayed launch carries none.
    expect(replayed[0]!.options).not.toHaveProperty("handbackCode");
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

  it("keeps a predecessor's exit off the successor while recording its generation", () => {
    const client = createReadyClient();
    const ledger = getLifecycleLedger();
    const onExit = vi.fn();
    client.on("exit", onExit);

    client.spawn("t1", baseOptions);
    client.kill("t1");
    client.spawn("t1", baseOptions); // restart reuses the id → generation 2

    // The killed incarnation's exit arrives late, stamped with generation 1.
    mockChild.emit("message", { type: "exit", id: "t1", exitCode: 137, launchGeneration: 1 });

    const entry = ledger.getEntry("t1");
    expect(entry?.generation).toBe(2);
    expect(entry?.closedAt).toBeUndefined();
    expect(onExit).not.toHaveBeenCalled();
    expect(client.hasTerminal("t1")).toBe(true);

    // The live incarnation's own exit still closes it.
    mockChild.emit("message", { type: "exit", id: "t1", exitCode: 0, launchGeneration: 2 });
    expect(ledger.getEntry("t1")?.closedAt).toBeDefined();
    expect(ledger.getEntry("t1")?.exitCode).toBe(0);
    expect(onExit).toHaveBeenCalledExactlyOnceWith("t1", 0, undefined, undefined);
    expect(client.hasTerminal("t1")).toBe(false);
  });

  it("keeps each incarnation's exit after the host forgets it, for a wait on a closed panel (#15728)", () => {
    const client = createReadyClient();

    client.spawn("t1", baseOptions);
    client.kill("t1");
    client.spawn("t1", baseOptions);
    mockChild.emit("message", {
      type: "exit",
      id: "t1",
      exitCode: 0,
      signal: 9,
      launchGeneration: 1,
    });

    expect(client.recentExits.find("t1", 1)).toMatchObject({ exitCode: 0, signal: 9 });
    expect(client.recentExits.find("t1", 2)).toBeUndefined();

    mockChild.emit("message", { type: "exit", id: "t1", exitCode: 3, launchGeneration: 2 });
    expect(client.hasTerminal("t1")).toBe(false);
    expect(client.recentExits.find("t1", 2)?.exitCode).toBe(3);
  });

  it("reports every incarnation's exit by its spawn time, a superseded one's included (#15976)", () => {
    const client = createReadyClient();
    const facts = vi.fn();
    client.on("incarnation-exit", facts);

    client.spawn("t1", baseOptions);
    client.kill("t1");
    client.spawn("t1", baseOptions);
    mockChild.emit("message", {
      type: "exit",
      id: "t1",
      exitCode: 0,
      signal: 15,
      launchGeneration: 1,
      spawnedAt: 1_000,
    });
    mockChild.emit("message", {
      type: "exit",
      id: "t1",
      exitCode: 2,
      signal: 0,
      launchGeneration: 2,
      spawnedAt: 2_000,
    });

    expect(facts.mock.calls).toEqual([
      [{ terminalId: "t1", spawnedAt: 1_000, exitCode: 0, signal: 15 }],
      [{ terminalId: "t1", spawnedAt: 2_000, exitCode: 2, signal: 0 }],
    ]);
  });

  it("asks the host to end one incarnation's trash grace and answers what it did (#15728)", async () => {
    const client = createReadyClient();
    client.spawn("t1", baseOptions);

    const answer = client.endTrashGrace("t1", 1);
    const request = mockChild.postMessage.mock.calls
      .map((call: unknown[]) => call[0] as { type?: string; requestId?: string })
      .find((message) => message.type === "end-trash-grace");
    expect(request).toMatchObject({ id: "t1", expectedGeneration: 1 });
    mockChild.emit("message", {
      type: "end-trash-grace-result",
      requestId: request!.requestId,
      status: "started",
    });

    await expect(answer).resolves.toBe("started");
  });

  it("consumes restart suppression once and disarms it when a successor launches", () => {
    const client = createReadyClient();
    client.suppressExitForRestart("unknown");
    expect(client.consumeRestartExitSuppression("unknown")).toBe(false);
    client.spawn("t1", baseOptions);
    client.suppressExitForRestart("t1");
    expect(client.consumeRestartExitSuppression("t1")).toBe(true);
    expect(client.consumeRestartExitSuppression("t1")).toBe(false);

    client.suppressExitForRestart("t1");
    client.kill("t1");
    client.spawn("t1", baseOptions);
    expect(client.consumeRestartExitSuppression("t1")).toBe(false);
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

  it("reads whether a tracked terminal backs the assistant from its spawn stamp (#13494)", () => {
    const client = createReadyClient();
    client.spawn("t-assistant", { ...baseOptions, isAssistantTerminal: true });
    client.spawn("t-grid", baseOptions);

    expect(client.isAssistantTerminal("t-assistant")).toBe(true);
    expect(client.isAssistantTerminal("t-grid")).toBe(false);
    expect(client.isAssistantTerminal("t-unknown")).toBe(false);
  });

  it("reads a terminal's launch attribution off its spawn cache, and nothing else (#13814)", () => {
    const client = createReadyClient();
    client.spawn("t1", {
      ...baseOptions,
      projectId: "p1",
      kind: "terminal",
      pluginPanelKindId: "acme.build",
      title: "secret title",
      command: "claude --secret",
    });

    expect(client.getTerminalLaunchAttribution("t1")).toEqual({
      projectId: "p1",
      worktreeId: "wt-a",
      kind: "terminal",
      launchAgentId: "claude",
      pluginPanelKindId: "acme.build",
      launchGeneration: 1,
      isAssistantTerminal: undefined,
    });
    expect(client.getTerminalLaunchAttribution("t-unknown")).toBeNull();
  });

  it("attributes an exit to its project after the client has forgotten the terminal (#13814)", () => {
    const client = createReadyClient();
    const seen: TerminalLifecycleObservation[] = [];
    const unsub = events.on("terminal:lifecycle", (observation) => seen.push(observation));
    const stop = startTerminalLifecycleObserver(client);
    try {
      client.spawn("t1", { ...baseOptions, projectId: "p1" });
      mockChild.emit("message", {
        type: "spawn-result",
        id: "t1",
        result: { success: true, id: "t1", launchGeneration: 1 },
      });
      mockChild.emit("message", { type: "exit", id: "t1", exitCode: 3, launchGeneration: 1 });

      expect(client.getTerminalProjectId("t1")).toBeNull();
      expect(seen.map((o) => [o.type, o.projectId, o.kind, o.agentId])).toEqual([
        ["spawned", "p1", "agent", "claude"],
        ["exited", "p1", "agent", "claude"],
      ]);
      expect(seen[1]).toMatchObject({ exitCode: 3, worktreeId: "wt-a" });
    } finally {
      stop();
      unsub();
    }
  });

  describe("a spawn refused because the id is still live (#11341, #12498)", () => {
    function refuseAsLive(launchGeneration: number) {
      mockChild.emit("message", {
        type: "spawn-result",
        id: "t1",
        result: {
          success: false,
          id: "t1",
          launchGeneration,
          error: { code: "TERMINAL_ALREADY_LIVE", message: "live owner" },
        },
      });
    }

    it("keeps the live terminal registered under its original spawn", () => {
      // The refusal deleted the entry the duplicate had just overwritten, so a
      // running terminal read as gone — and the power blocker prunes on that.
      const client = createReadyClient();
      client.spawn("t1", { ...baseOptions, projectId: "p-live" }); // generation 1
      mockChild.emit("message", {
        type: "spawn-result",
        id: "t1",
        result: { success: true, id: "t1", launchGeneration: 1 },
      });

      client.spawn("t1", { ...baseOptions, projectId: "p-duplicate" }); // generation 2
      refuseAsLive(2);

      expect(client.hasTerminal("t1")).toBe(true);
      expect(client.getTerminalProjectId("t1")).toBe("p-live");
    });

    it("keeps a running assistant's identity while an unstamped duplicate awaits the host", () => {
      const client = createReadyClient();
      client.spawn("t1", { ...baseOptions, isAssistantTerminal: true }); // generation 1
      mockChild.emit("message", {
        type: "spawn-result",
        id: "t1",
        result: { success: true, id: "t1", launchGeneration: 1 },
      });

      client.spawn("t1", baseOptions); // generation 2, a duplicate without the stamp
      expect(client.isAssistantTerminal("t1")).toBe(true);

      refuseAsLive(2);
      expect(client.isAssistantTerminal("t1")).toBe(true);
    });

    it("reports the running incarnation as live while a duplicate awaits the host", () => {
      const client = createReadyClient();
      client.spawn("t1", baseOptions); // generation 1
      client.spawn("t1", baseOptions); // generation 2, a duplicate
      expect(client.getLiveGeneration("t1")).toBe(1);
      expect(client.isLiveGeneration("t1", 1)).toBe(true);

      refuseAsLive(2);
      expect(client.getLiveGeneration("t1")).toBe(1);
      expect(client.isLiveGeneration("t1", 2)).toBe(false);
    });

    it("restores the running spawn, not an earlier refused one, when duplicates overlap", () => {
      const client = createReadyClient();
      client.spawn("t1", { ...baseOptions, projectId: "p-live" }); // generation 1
      client.spawn("t1", { ...baseOptions, projectId: "p-first-duplicate" }); // generation 2
      client.spawn("t1", { ...baseOptions, projectId: "p-second-duplicate" }); // generation 3

      refuseAsLive(2);
      refuseAsLive(3);

      expect(client.hasTerminal("t1")).toBe(true);
      expect(client.getTerminalProjectId("t1")).toBe("p-live");
    });

    it("does not resurrect a terminal killed before the refusal arrives", () => {
      const client = createReadyClient();
      client.spawn("t1", baseOptions);
      client.spawn("t1", baseOptions);
      client.kill("t1");

      refuseAsLive(2);

      expect(client.hasTerminal("t1")).toBe(false);
    });

    it("still drops the entry when the replacing spawn genuinely fails", () => {
      // Any other failure means the host killed the prior incarnation to make
      // room, so nothing is left running under the id.
      const client = createReadyClient();
      client.spawn("t1", baseOptions);
      client.spawn("t1", baseOptions);

      mockChild.emit("message", {
        type: "spawn-result",
        id: "t1",
        result: {
          success: false,
          id: "t1",
          launchGeneration: 2,
          error: { code: "ENOENT", message: "no shell" },
        },
      });

      expect(client.hasTerminal("t1")).toBe(false);
    });
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

  it.each(["Path", "PATH", "pAtH"])("yields to a caller-supplied %s", (key) => {
    const client = createReadyClient();
    process.env.PATH = "C:\\Windows";
    setPlatform("win32");

    client.spawn("t1", { ...baseOptions, env: { [key]: "C:\\Custom" } });

    // Windows resolves every spelling to the same variable, so the skip has to
    // fold case rather than recognise a handful of known forms.
    expect(spawnMessages(mockChild)[0]?.options.env).toEqual({ [key]: "C:\\Custom" });
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

interface WatchdogPrivate {
  lifecycle: {
    child: MockUtilityProcess | null;
    isInitialized: boolean;
  };
  healthWatchdog: {
    missedHeartbeats: number;
    isHealthCheckPaused: boolean;
    healthCheckInterval: NodeJS.Timeout | null;
    isWaitingForHandshake: boolean;
  };
}

describe("PtyClient watchdog", () => {
  let mockChild: MockUtilityProcess;
  let PtyClientClass: typeof import("../PtyClient.js").PtyClient;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    shared.appMock.removeAllListeners();
    mockChild = createMockChild();
    shared.forkMock.mockReturnValue(mockChild);
    killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);

    ({ PtyClient: PtyClientClass } = await import("../PtyClient.js"));

    // Install after imports: fake timers can stall module re-execution (#11661).
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createReadyClient(
    config?: import("../PtyClient.js").PtyClientConfig
  ): import("../PtyClient.js").PtyClient {
    const client = new PtyClientClass(config);
    mockChild.emit("message", { type: "ready" });
    return client;
  }

  it("THREE_MISSED_PONGS_TRIGGER_FORCE_KILL", () => {
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const crashListener = vi.fn();
    client.on("host-crash-details", crashListener);

    // Ticks 1-3 increment the counter to 1, 2, 3. Tick 4 (counter >= MAX_MISSED_HEARTBEATS=3)
    // fires the watchdog: emits crash details, then calls process.kill.
    vi.advanceTimersByTime(400);

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(321, "SIGKILL");
    expect(crashListener).toHaveBeenCalledTimes(1);
    // Watchdog resets the counter to 0 after firing so the next tick starts fresh.
    expect((client as unknown as WatchdogPrivate).healthWatchdog.missedHeartbeats).toBe(0);
  });

  it("CRASH_DETAILS_EMITTED_BEFORE_KILL_WITH_SIGNAL_PAYLOAD", () => {
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const callOrder: string[] = [];
    let capturedPayload: unknown;
    client.on("host-crash-details", (payload: unknown) => {
      callOrder.push("event");
      capturedPayload = payload;
    });
    killSpy.mockImplementation((() => {
      callOrder.push("kill");
      return true;
    }) as typeof process.kill);

    vi.advanceTimersByTime(400);

    expect(callOrder).toEqual(["event", "kill"]);
    expect(capturedPayload).toMatchObject({
      code: null,
      signal: "SIGKILL",
      crashType: "SIGNAL_TERMINATED",
      timestamp: expect.any(Number),
    });
  });

  it("PONG_BEFORE_THIRD_MISS_RESETS_COUNTER", () => {
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const priv = client as unknown as WatchdogPrivate;

    vi.advanceTimersByTime(200);
    expect(priv.healthWatchdog.missedHeartbeats).toBe(2);

    mockChild.emit("message", { type: "pong" });
    expect(priv.healthWatchdog.missedHeartbeats).toBe(0);

    // Three more ticks bring the counter back to 3 without triggering the kill.
    vi.advanceTimersByTime(300);
    expect(priv.healthWatchdog.missedHeartbeats).toBe(3);
    expect(killSpy).not.toHaveBeenCalled();

    // The fourth tick is the one that fires the watchdog guard.
    vi.advanceTimersByTime(100);
    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it("PAUSE_MID_COUNT_FREEZES_COUNTER", () => {
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const priv = client as unknown as WatchdogPrivate;

    vi.advanceTimersByTime(200);
    expect(priv.healthWatchdog.missedHeartbeats).toBe(2);

    client.pauseHealthCheck();
    expect(priv.healthWatchdog.isHealthCheckPaused).toBe(true);
    expect(priv.healthWatchdog.healthCheckInterval).toBeNull();

    // With the interval cleared, advancing time has no effect on the counter.
    vi.advanceTimersByTime(10_000);
    expect(priv.healthWatchdog.missedHeartbeats).toBe(2);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("NULL_CHILD_MID_TICK_NO_KILL_NO_THROW", () => {
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const priv = client as unknown as WatchdogPrivate;
    const crashListener = vi.fn();
    client.on("host-crash-details", crashListener);

    // Drive the counter up to the threshold, then simulate the exit-event race:
    // the host is gone (child = null) when the 4th tick tries to fire the watchdog.
    vi.advanceTimersByTime(300);
    expect(priv.healthWatchdog.missedHeartbeats).toBe(3);

    priv.lifecycle.child = null;

    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(killSpy).not.toHaveBeenCalled();
    expect(crashListener).not.toHaveBeenCalled();
  });

  it("PONG_AFTER_PAUSE_RESUME_REENTRY_RESETS_COUNTER", () => {
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const priv = client as unknown as WatchdogPrivate;

    vi.advanceTimersByTime(200);
    expect(priv.healthWatchdog.missedHeartbeats).toBe(2);

    // pauseHealthCheck clears the interval but leaves the counter untouched.
    client.pauseHealthCheck();
    expect(priv.healthWatchdog.missedHeartbeats).toBe(2);

    // resumeHealthCheck sends a handshake ping and arms a 5s fallback timeout.
    client.resumeHealthCheck();
    expect(priv.healthWatchdog.isWaitingForHandshake).toBe(true);

    // A pong during the handshake window clears the counter and re-enters
    // startHealthCheckInterval(), which itself resets missedHeartbeats to 0.
    mockChild.emit("message", { type: "pong" });
    expect(priv.healthWatchdog.isWaitingForHandshake).toBe(false);
    expect(priv.healthWatchdog.missedHeartbeats).toBe(0);

    // Re-armed interval takes 4 fresh ticks to reach the kill threshold.
    vi.advanceTimersByTime(300);
    expect(killSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it("MISSING_PID_SKIPS_KILL_BUT_EMITS_CRASH_DETAILS", () => {
    // Race: the child process lost its pid (e.g. spawn failure / early exit) but
    // is still the referenced child. Watchdog should emit the crash event but
    // skip the signal to avoid `process.kill(undefined, ...)`.
    mockChild.pid = undefined;
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const crashListener = vi.fn();
    client.on("host-crash-details", crashListener);

    vi.advanceTimersByTime(400);

    expect(crashListener).toHaveBeenCalledTimes(1);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("PID_CLEARED_MID_FLIGHT_SKIPS_KILL", () => {
    // Complementary to MISSING_PID: the host starts with a valid pid, receives
    // heartbeats, then loses its pid right before the 4th tick. The watchdog
    // reads child.pid fresh each tick, so it should still emit crash details
    // but skip the signal.
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const crashListener = vi.fn();
    client.on("host-crash-details", crashListener);

    vi.advanceTimersByTime(300);
    mockChild.pid = undefined;
    vi.advanceTimersByTime(100);

    expect(crashListener).toHaveBeenCalledTimes(1);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("STEADY_STATE_PONGS_NEVER_KILL", () => {
    // Happy path: host answers every health-check with a pong. Over many ticks,
    // the watchdog must never fire and the counter must never cross the
    // threshold. This is the most common runtime state — a regression that
    // started force-killing healthy hosts would be catastrophic.
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const priv = client as unknown as WatchdogPrivate;
    const crashListener = vi.fn();
    client.on("host-crash-details", crashListener);

    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(100);
      mockChild.emit("message", { type: "pong" });
    }

    expect(killSpy).not.toHaveBeenCalled();
    expect(crashListener).not.toHaveBeenCalled();
    expect(priv.healthWatchdog.missedHeartbeats).toBe(0);
    const healthChecks = mockChild.postMessage.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type?: string })?.type === "health-check"
    );
    expect(healthChecks).toHaveLength(20);
  });

  it("HANDSHAKE_TIMEOUT_FALLBACK_RESETS_COUNTER", () => {
    // Alternate re-entry path: resume without a pong arriving. After the 5s
    // fallback timeout fires, startHealthCheckInterval() is called via the
    // timeout branch (PtyClient.ts:1325-1332) instead of the pong branch.
    // Either way, missedHeartbeats must be reset.
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const priv = client as unknown as WatchdogPrivate;

    vi.advanceTimersByTime(200);
    expect(priv.healthWatchdog.missedHeartbeats).toBe(2);

    client.pauseHealthCheck();
    client.resumeHealthCheck();
    expect(priv.healthWatchdog.isWaitingForHandshake).toBe(true);

    // No pong: handshake timeout (5000ms) fires and falls back to
    // startHealthCheckInterval() which resets the counter.
    vi.advanceTimersByTime(5000);
    expect(priv.healthWatchdog.isWaitingForHandshake).toBe(false);
    expect(priv.healthWatchdog.missedHeartbeats).toBe(0);

    vi.advanceTimersByTime(300);
    expect(killSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it("WATCHDOG_RE_ARMED_AFTER_AUTO_RESTART", () => {
    // Regression for #6690: when the host crashes and is auto-restarted, the
    // watchdog must restart with the new child. Previously a one-shot
    // start-in-constructor left the watchdog dead after the first crash.
    const client = createReadyClient({ healthCheckIntervalMs: 100 });
    const priv = client as unknown as WatchdogPrivate;

    // First host crashes — onExitSync stops the watchdog, restart timer is
    // scheduled inside the lifecycle's setImmediate.
    mockChild.emit("exit", 1);

    // The next fork (during the restart timer) returns a fresh mock child.
    const restartedChild = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
      kill: vi.fn(),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      pid: 654,
    }) as MockUtilityProcess;
    shared.forkMock.mockReturnValue(restartedChild);

    // Drain the setImmediate + the random-jittered restart delay (max 2000ms
    // for attempt 1: floor(100) + random*Math.min(2^1*1000, 10000)-100).
    vi.advanceTimersByTime(2_001);
    // New host emits ready
    restartedChild.emit("message", { type: "ready" });

    // Counter resets to 0 on each start; ticks 1-3 increment it; tick 4 fires.
    vi.advanceTimersByTime(400);

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(654, "SIGKILL");
    expect(priv.healthWatchdog.missedHeartbeats).toBe(0);
  });
});
