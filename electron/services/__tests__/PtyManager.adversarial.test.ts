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
  type: "terminal" | "claude";
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
  type: string;
  projectId?: string;
  agentId?: string;
  spawnedAt: number;
  isExited: boolean;
  wasKilled: boolean;
  outputBuffer: string;
  semanticBuffer: string[];
  restartCount: number;
}

class MockTerminalProcess {
  id: string;
  info: TerminalInfoShape;
  callbacks: TerminalCallbacks;
  ptyProcess: MockPtyProcess;
  kill = vi.fn((_reason?: string) => {
    this.info.wasKilled = true;
  });
  setSabModeEnabled = vi.fn();
  setActivityMonitorTier = vi.fn();
  startProcessDetector = vi.fn();
  dispose = vi.fn();

  constructor(
    id: string,
    options: SpawnOptionsShape,
    callbacks: TerminalCallbacks,
    _deps: unknown,
    _spawnContext: unknown,
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
      type: options.type,
      projectId: options.projectId,
      agentId: options.agentId,
      spawnedAt: options.spawnedAt ?? Date.now(),
      isExited: false,
      wasKilled: false,
      outputBuffer: "",
      semanticBuffer: [],
      restartCount: 0,
    };
    shared.created.push(this);
  }

  getInfo(): TerminalInfoShape {
    return this.info;
  }

  getIsAgentTerminal(): boolean {
    return !!this.info.agentId;
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

vi.mock("../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
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
    type: "terminal",
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
      isAgentTerminal: false,
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
        kind: "agent",
        type: "claude",
        projectId: "project-a",
        agentId: "agent-1",
        spawnedAt,
      })
    );

    const result = manager.transitionState("agent-1", event, "output", 0.37, spawnedAt);

    expect(result).toBe(false);
    expect(shared.agentTransitionState).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent-1",
        agentId: "agent-1",
        spawnedAt,
      }),
      event,
      "output",
      0.37,
      spawnedAt
    );
  });

  it("DISPOSE_EMITS_AGENT_KILLED_ONLY_FOR_AGENTS", () => {
    const manager = new PtyManager();
    const listener = vi.fn();
    manager.on("data", listener);

    manager.spawn(
      "agent-1",
      spawnOptions({ kind: "agent", type: "claude", agentId: "agent-1", projectId: "project-a" })
    );
    manager.spawn("term-1", spawnOptions({ projectId: "project-a" }));

    manager.dispose();

    expect(shared.agentEmitKilled).toHaveBeenCalledTimes(1);
    expect(shared.agentEmitKilled).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1", agentId: "agent-1" }),
      "cleanup"
    );
    expect(shared.created[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(shared.created[1]!.dispose).toHaveBeenCalledTimes(1);
    expect(manager.listenerCount("data")).toBe(0);
    expect(shared.disposeSerializer).toHaveBeenCalledTimes(1);
  });
});
