import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import type { PtyHostSpawnOptions } from "../../../shared/types/pty-host.js";

const shared = vi.hoisted(() => ({
  terminals: new Map<string, MockTerminalProcess>(),
  created: [] as MockTerminalProcess[],
  eventsEmit: vi.fn(),
  computeSpawnContext: vi.fn(),
  acquirePtyProcess: vi.fn(),
  agentTransitionState: vi.fn(),
  agentEmitKilled: vi.fn(),
  disposeSerializer: vi.fn(),
  deleteSessionFile: vi.fn(),
  persistAgentSession: vi.fn(),
}));

interface SpawnOptionsShape extends PtyHostSpawnOptions {
  kind: "terminal" | "agent";
  spawnedAt?: number;
}

interface TerminalCallbacks {
  emitData: (id: string, data: string | Uint8Array) => void;
  onExit: (id: string, exitCode: number) => void;
}

type MockPtyProcess = Pick<IPty, "kill" | "pid" | "cols" | "rows" | "process">;

interface TerminalInfoShape {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  kind: string;
  launchAgentId?: string;
  projectId?: string;
  spawnedAt: number;
  isExited: boolean;
  wasKilled: boolean;
  outputBuffer: string;
  semanticBuffer: string[];
  restartCount: number;
  shell?: string;
  title?: string;
  worktreeId?: string;
  agentState?: string;
  lastInputTime?: number;
  lastOutputTime?: number;
  lastStateChange?: number;
  detectedAgentId?: string;
  analysisEnabled?: boolean;
  exitCode?: number;
  spawnArgs?: string[];
  agentLaunchFlags?: string[];
  agentModelId?: string;
  ptyProcess?: MockPtyProcess;
}

class MockTerminalProcess {
  id: string;
  info: TerminalInfoShape;
  callbacks: TerminalCallbacks;
  ptyProcess: MockPtyProcess;
  kill = vi.fn((_reason?: string) => {
    this.info.wasKilled = true;
  });
  resize = vi.fn((cols: number, rows: number) => {
    this.info.cols = cols;
    this.info.rows = rows;
  });
  setSabModeEnabled = vi.fn();
  setActivityMonitorTier = vi.fn();
  startProcessDetector = vi.fn();
  dispose = vi.fn();
  getActivityTier = vi.fn(() => "active" as const);
  getResizeStrategy = vi.fn(() => "default" as const);

  constructor(
    id: string,
    options: SpawnOptionsShape,
    callbacks: TerminalCallbacks,
    _deps: unknown,
    spawnContext: { shell?: string; args?: string[] } | undefined,
    ptyProcess: MockPtyProcess
  ) {
    this.id = id;
    this.callbacks = callbacks;
    this.ptyProcess = ptyProcess;
    this.info = {
      id,
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      kind: options.kind,
      launchAgentId: options.launchAgentId,
      projectId: options.projectId,
      spawnedAt: options.spawnedAt ?? Date.now(),
      isExited: false,
      wasKilled: false,
      outputBuffer: "",
      semanticBuffer: [],
      restartCount: 0,
      lastInputTime: 0,
      lastOutputTime: 0,
      ptyProcess,
      shell: spawnContext?.shell,
      spawnArgs: spawnContext?.args,
    };
    shared.created.push(this);
  }

  getInfo(): TerminalInfoShape {
    return this.info;
  }

  isAgentCurrentlyLive(): boolean {
    return !!this.info.detectedAgentId;
  }

  shouldPreserveOnExit(): boolean {
    return false;
  }

  gracefulShutdown(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

class MockTerminalRegistry {
  add(id: string, terminal: MockTerminalProcess): void {
    shared.terminals.set(id, terminal);
  }

  get(id: string): MockTerminalProcess | undefined {
    return shared.terminals.get(id);
  }

  delete(id: string): void {
    shared.terminals.delete(id);
  }

  has(id: string): boolean {
    return shared.terminals.has(id);
  }

  getAll(): MockTerminalProcess[] {
    return Array.from(shared.terminals.values());
  }

  getAllIds(): string[] {
    return Array.from(shared.terminals.keys());
  }

  entries(): IterableIterator<[string, MockTerminalProcess]> {
    return shared.terminals.entries();
  }

  getForProject(projectId: string): string[] {
    return Array.from(shared.terminals.entries())
      .filter(([, terminal]) => terminal.getInfo().projectId === projectId)
      .map(([id]) => id);
  }

  terminalBelongsToProject(terminal: MockTerminalProcess, projectId: string): boolean {
    return terminal.getInfo().projectId === projectId;
  }

  clearTrashTimeout(_id: string): void {}

  isInTrash(_id: string): boolean {
    return false;
  }

  getTrashExpiresAt(_id: string): number | undefined {
    return undefined;
  }

  dispose(): void {
    shared.terminals.clear();
  }
}

class MockAgentStateService {
  transitionState = shared.agentTransitionState;
  emitAgentKilled = shared.agentEmitKilled;
}

vi.mock("../pty/terminalSpawn.js", () => ({
  computeSpawnContext: shared.computeSpawnContext,
  acquirePtyProcess: shared.acquirePtyProcess,
}));

vi.mock("../pty/index.js", () => ({
  TerminalRegistry: MockTerminalRegistry,
  AgentStateService: MockAgentStateService,
  TerminalProcess: MockTerminalProcess,
  TerminalSnapshot: class {},
}));

vi.mock("../events.js", () => ({
  events: {
    emit: shared.eventsEmit,
  },
}));

vi.mock("../pty/TerminalSerializerService.js", () => ({
  disposeTerminalSerializerService: shared.disposeSerializer,
}));

vi.mock("../pty/terminalSessionPersistence.js", () => ({
  deleteSessionFile: shared.deleteSessionFile,
}));

vi.mock("../pty/agentSessionHistory.js", () => ({
  persistAgentSession: shared.persistAgentSession,
}));

const logDebug = vi.fn();
const logInfo = vi.fn();
const logWarn = vi.fn();
const logError = vi.fn();

vi.mock("../../utils/logger.js", () => ({
  createLogger: vi.fn(() => ({
    debug: logDebug,
    info: logInfo,
    warn: logWarn,
    error: logError,
  })),
  logDebug,
  logInfo,
  logWarn,
  logError,
}));

const { PtyManager } = await import("../PtyManager.js");

function createPtyProcess(): MockPtyProcess {
  return {
    kill: vi.fn(),
    pid: 123,
    cols: 80,
    rows: 24,
    process: "zsh",
  };
}

function spawnOptions(overrides?: Partial<SpawnOptionsShape>): SpawnOptionsShape {
  return {
    cwd: "/repo",
    cols: 80,
    rows: 24,
    kind: "terminal",
    ...overrides,
  };
}

describe("PtyManager adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared.terminals.clear();
    shared.created.length = 0;
    shared.computeSpawnContext.mockReturnValue({
      env: {},
      shell: "/bin/zsh",
      args: ["-l"],
    });
    shared.acquirePtyProcess.mockImplementation(() => createPtyProcess());
    shared.agentTransitionState.mockReturnValue(true);
    shared.deleteSessionFile.mockResolvedValue(undefined);
    shared.persistAgentSession.mockResolvedValue(undefined);
  });

  it("STALE_EXIT_DOES_NOT_DELETE_REPLACEMENT", () => {
    const manager = new PtyManager();

    manager.spawn("t1", spawnOptions({ projectId: "project-a" }));
    manager.spawn("t1", spawnOptions({ projectId: "project-a" }));

    const exits: Array<{ id: string; code: number }> = [];
    manager.on("exit", (id: string, code: number) => {
      exits.push({ id, code });
    });

    const oldTerminal = shared.created[0]!;
    const newTerminal = shared.created[1]!;

    oldTerminal.callbacks.onExit("t1", 1);

    expect(manager.hasTerminal("t1")).toBe(true);
    expect(manager.getTerminal("t1")?.spawnedAt).toBe(newTerminal.info.spawnedAt);
    expect(exits).toEqual([]);

    newTerminal.callbacks.onExit("t1", 0);

    expect(exits).toEqual([{ id: "t1", code: 0 }]);
    expect(manager.hasTerminal("t1")).toBe(false);
  });

  it("ACTIVE_PROJECT_FILTER_GATES_DATA_EMISSION", () => {
    const manager = new PtyManager();
    const received: Array<{ id: string; data: string | Uint8Array }> = [];

    manager.spawn("t1", spawnOptions({ projectId: "project-a" }));
    manager.spawn("t2", spawnOptions({ projectId: "project-b" }));
    manager.on("data", (id: string, data: string | Uint8Array) => {
      received.push({ id, data });
    });

    manager.setActiveProject("project-a");
    shared.created[0]!.callbacks.emitData("t1", "hello-a");
    shared.created[1]!.callbacks.emitData("t2", "hello-b");

    expect(received).toEqual([{ id: "t1", data: "hello-a" }]);
  });

  it("DUPLICATE_SPAWN_KILLS_PREVIOUS", () => {
    const manager = new PtyManager();

    manager.spawn("t1", spawnOptions({ projectId: "project-a" }));
    const original = shared.created[0]!;

    manager.spawn("t1", spawnOptions({ projectId: "project-b" }));

    expect(original.kill).toHaveBeenCalledTimes(1);
    expect(manager.getActiveTerminalIds()).toEqual(["t1"]);
    expect(manager.getTerminal("t1")?.projectId).toBe("project-b");
  });

  it("SAB_MODE_RETRO_PROPAGATES", () => {
    const manager = new PtyManager();

    manager.spawn("t1", spawnOptions());
    manager.spawn("t2", spawnOptions());

    manager.setSabMode(true);
    manager.setSabMode(false);

    expect(shared.created[0]!.setSabModeEnabled).toHaveBeenNthCalledWith(1, true);
    expect(shared.created[0]!.setSabModeEnabled).toHaveBeenNthCalledWith(2, false);
    expect(shared.created[1]!.setSabModeEnabled).toHaveBeenNthCalledWith(1, true);
    expect(shared.created[1]!.setSabModeEnabled).toHaveBeenNthCalledWith(2, false);
  });

  it("KILL_OF_EXITED_TERMINAL_REMOVES_ENTRY", () => {
    const manager = new PtyManager();

    manager.spawn("t1", spawnOptions());
    shared.created[0]!.info.isExited = true;

    manager.kill("t1");

    expect(manager.hasTerminal("t1")).toBe(false);
    expect(shared.deleteSessionFile).toHaveBeenCalledWith("t1");
  });

  it("PROJECT_SWITCH_RE_TIERS_AND_EMITS", () => {
    const manager = new PtyManager();
    const tierChanges: Array<{ id: string; tier: "active" | "background" }> = [];

    manager.spawn("t1", spawnOptions({ projectId: "project-a" }));
    manager.spawn("t2", spawnOptions({ projectId: "project-b" }));

    manager.onProjectSwitch("project-a", (id, tier) => {
      tierChanges.push({ id, tier });
    });

    expect(shared.created[0]!.setActivityMonitorTier).toHaveBeenCalledWith(50);
    expect(shared.created[1]!.setActivityMonitorTier).toHaveBeenCalledWith(500);
    expect(shared.created[0]!.startProcessDetector).toHaveBeenCalledTimes(1);
    expect(tierChanges).toEqual([
      { id: "t1", tier: "active" },
      { id: "t2", tier: "background" },
    ]);
    expect(shared.eventsEmit).toHaveBeenCalledWith(
      "terminal:foregrounded",
      expect.objectContaining({ id: "t1", projectId: "project-a" })
    );
    expect(shared.eventsEmit).toHaveBeenCalledWith(
      "terminal:backgrounded",
      expect.objectContaining({ id: "t2", projectId: "project-b" })
    );
  });

  it("TRANSITIONSTATE_FORWARDS_INFO", () => {
    const manager = new PtyManager();
    const spawnedAt = 4242;
    const event = { type: "busy" } as const;

    shared.agentTransitionState.mockReturnValueOnce(false);
    manager.spawn(
      "agent-1",
      spawnOptions({
        kind: "terminal",
        launchAgentId: "claude",
        projectId: "project-a",
        spawnedAt,
      })
    );

    const result = manager.transitionState("agent-1", event, "output", 0.37, spawnedAt);

    expect(result).toBe(false);
    expect(shared.agentTransitionState).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-1",
        launchAgentId: "claude",
        spawnedAt,
      }),
      event,
      "output",
      0.37,
      spawnedAt
    );
  });

  it("GET_TERMINAL_INFO_FORWARDS_SPAWN_AND_AGENT_FIELDS", () => {
    shared.computeSpawnContext.mockReturnValueOnce({
      env: {},
      shell: "/usr/local/bin/claude",
      args: ["--dangerously-skip-permissions", "--model", "claude-opus-4-7"],
    });

    const manager = new PtyManager();

    manager.spawn(
      "agent-1",
      spawnOptions({ kind: "terminal", launchAgentId: "claude", projectId: "project-a" })
    );

    const created = shared.created[0]!;
    created.info.agentLaunchFlags = ["--dangerously-skip-permissions"];
    created.info.agentModelId = "claude-opus-4-7";
    created.info.detectedAgentId = "claude";

    const payload = manager.getTerminalInfo("agent-1");

    expect(payload).not.toBeNull();
    expect(payload!.shell).toBe("/usr/local/bin/claude");
    expect(payload!.spawnArgs).toEqual([
      "--dangerously-skip-permissions",
      "--model",
      "claude-opus-4-7",
    ]);
    expect(payload!.agentLaunchFlags).toEqual(["--dangerously-skip-permissions"]);
    expect(payload!.agentModelId).toBe("claude-opus-4-7");
    expect(payload!.detectedAgentId).toBe("claude");
  });

  it("GET_TERMINAL_INFO_FORWARDS_DEFAULT_SHELL_ARGS_FOR_PLAIN_TERMINAL", () => {
    const manager = new PtyManager();

    manager.spawn("term-1", spawnOptions({ projectId: "project-a" }));

    const payload = manager.getTerminalInfo("term-1");

    expect(payload).not.toBeNull();
    // Default mock spawn context returns args: ["-l"] — the production
    // TerminalProcess always populates spawnArgs from spawnContext.args.
    expect(payload!.spawnArgs).toEqual(["-l"]);
    expect(payload!.shell).toBe("/bin/zsh");
    expect(payload!.agentLaunchFlags).toBeUndefined();
    expect(payload!.agentModelId).toBeUndefined();
  });

  it("DISPOSE_EMITS_AGENT_KILLED_ONLY_FOR_AGENTS", () => {
    const manager = new PtyManager();
    const listener = vi.fn();
    manager.on("data", listener);

    manager.spawn(
      "agent-1",
      spawnOptions({ kind: "terminal", launchAgentId: "claude", projectId: "project-a" })
    );
    manager.spawn("term-1", spawnOptions({ projectId: "project-a" }));

    manager.dispose();

    expect(shared.agentEmitKilled).toHaveBeenCalledTimes(1);
    expect(shared.agentEmitKilled).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1", launchAgentId: "claude" }),
      "cleanup"
    );
    expect(shared.created[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(shared.created[1]!.dispose).toHaveBeenCalledTimes(1);
    expect(manager.listenerCount("data")).toBe(0);
    expect(shared.disposeSerializer).toHaveBeenCalledTimes(1);
  });

  it("RESIZE_BEFORE_SPAWN_APPLIES_BUFFERED_DIMS", () => {
    const manager = new PtyManager();

    manager.resize("t1", 120, 40);
    manager.spawn("t1", spawnOptions({ projectId: "project-a" }));

    const created = shared.created[0]!;
    expect(created.info.cols).toBe(120);
    expect(created.info.rows).toBe(40);
    expect(created.resize).not.toHaveBeenCalled();
  });

  it("RESIZE_BEFORE_SPAWN_COALESCES_LAST_WRITE", () => {
    const manager = new PtyManager();

    manager.resize("t1", 80, 24);
    manager.resize("t1", 140, 50);
    manager.spawn("t1", spawnOptions({ projectId: "project-a" }));

    const created = shared.created[0]!;
    expect(created.info.cols).toBe(140);
    expect(created.info.rows).toBe(50);
  });

  it("RESIZE_BEFORE_SPAWN_USES_DEBUG_NOT_WARN", () => {
    const manager = new PtyManager();

    manager.resize("t1", 100, 30);

    expect(logWarn).not.toHaveBeenCalled();
    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining("buffering resize 100x30"));
  });

  it("RESIZE_AFTER_SPAWN_FORWARDS_TO_TERMINAL", () => {
    const manager = new PtyManager();

    manager.spawn("t1", spawnOptions({ projectId: "project-a" }));
    manager.resize("t1", 90, 32);

    const created = shared.created[0]!;
    expect(created.resize).toHaveBeenCalledWith(90, 32);
  });

  it("KILL_CLEARS_PENDING_RESIZE", () => {
    const manager = new PtyManager();

    manager.resize("t1", 200, 60);
    manager.kill("t1");
    manager.spawn("t1", spawnOptions({ projectId: "project-a", cols: 80, rows: 24 }));

    const created = shared.created[0]!;
    // Pending dims were cleared by kill, so spawn uses its own options.
    expect(created.info.cols).toBe(80);
    expect(created.info.rows).toBe(24);
  });

  it("SPAWN_CONSUMES_PENDING_RESIZE_ONCE", () => {
    const manager = new PtyManager();

    manager.resize("t1", 200, 60);
    manager.spawn("t1", spawnOptions({ projectId: "project-a" }));

    expect(shared.created[0]!.info.cols).toBe(200);
    expect(shared.created[0]!.info.rows).toBe(60);

    // Kill and respawn — no pending entry should remain to leak into the next boot.
    manager.kill("t1");
    manager.spawn("t1", spawnOptions({ projectId: "project-a", cols: 80, rows: 24 }));

    expect(shared.created[1]!.info.cols).toBe(80);
    expect(shared.created[1]!.info.rows).toBe(24);
  });

  it("SPAWN_FAILURE_PRESERVES_PENDING_RESIZE_FOR_RETRY", () => {
    const manager = new PtyManager();

    manager.resize("t1", 200, 60);

    // Force the first spawn attempt to throw before registry.add fires.
    shared.acquirePtyProcess.mockImplementationOnce(() => {
      throw new Error("simulated pty.spawn failure");
    });

    expect(() => manager.spawn("t1", spawnOptions({ projectId: "project-a" }))).toThrow(
      "simulated pty.spawn"
    );
    expect(shared.created).toHaveLength(0);

    // Retry should still pick up the buffered dims because the failed spawn
    // never reached registry.add and so never consumed the pending entry.
    manager.spawn("t1", spawnOptions({ projectId: "project-a", cols: 80, rows: 24 }));
    expect(shared.created[0]!.info.cols).toBe(200);
    expect(shared.created[0]!.info.rows).toBe(60);
  });

  it("GRACEFUL_KILL_CLEARS_PENDING_RESIZE", async () => {
    const manager = new PtyManager();

    manager.resize("t1", 200, 60);
    // No spawn yet — gracefulKill should clear the pending entry.
    await manager.gracefulKill("t1");

    manager.spawn("t1", spawnOptions({ projectId: "project-a", cols: 80, rows: 24 }));
    expect(shared.created[0]!.info.cols).toBe(80);
    expect(shared.created[0]!.info.rows).toBe(24);
  });

  it("RESIZE_REJECTS_INVALID_DIMS", () => {
    const manager = new PtyManager();

    manager.resize("t1", 0, 24);
    manager.resize("t1", 80, NaN);
    manager.resize("t1", -10, 24);

    manager.spawn("t1", spawnOptions({ projectId: "project-a", cols: 80, rows: 24 }));

    // None of the invalid resizes should have been buffered.
    expect(shared.created[0]!.info.cols).toBe(80);
    expect(shared.created[0]!.info.rows).toBe(24);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("invalid dims"));
  });
});
