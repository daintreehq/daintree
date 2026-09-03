import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import type { PtyHostSpawnOptions } from "../../../shared/types/pty-host.js";

const shared = vi.hoisted(() => ({
  terminals: new Map<string, MockTerminalProcess>(),
  created: [] as MockTerminalProcess[],
  // Geometry the fake node-pty reports back, when it must differ from the dims
  // it was asked for (ConPTY queues a pre-ready resize and keeps reporting the
  // old grid). `null` = the PTY holds exactly what it was spawned with.
  ptyGeometryOverride: null as { cols: number | null; rows: number | null } | null,
  trashCallbacks: new Map<string, (id: string) => void>(),
  eventsEmit: vi.fn(),
  computeSpawnContext: vi.fn(),
  acquirePtyProcess: vi.fn(),
  agentTransitionState: vi.fn(),
  agentEmitKilled: vi.fn(),
  disposeSerializer: vi.fn(),
  deleteSessionFile: vi.fn(),
  getGitBranch: vi.fn(),
}));

type MockPtyProcess = Pick<IPty, "kill" | "pid" | "cols" | "rows" | "process">;

interface TerminalCallbacks {
  emitData: (id: string, data: string | Uint8Array) => void;
  onExit: (id: string, exitCode: number) => void;
}

class MockTerminalProcess {
  id: string;
  options: PtyHostSpawnOptions;
  callbacks: TerminalCallbacks;
  sessionId: string | null = null;
  info: {
    id: string;
    cwd: string;
    cols: number;
    rows: number;
    kind?: string;
    launchAgentId?: string;
    launchGeneration?: number;
    projectId?: string;
    worktreeId?: string;
    title?: string;
    titleMode?: string;
    lastObservedTitle?: string;
    agentLaunchFlags?: string[];
    agentModelId?: string;
    spawnedAt: number;
    isExited: boolean;
    wasKilled: boolean;
    outputBuffer: string;
    semanticBuffer: string[];
    restartCount: number;
  };
  kill = vi.fn(() => {
    this.info.wasKilled = true;
  });
  resize = vi.fn((cols: number, rows: number) => {
    const unchanged = this.info.cols === cols && this.info.rows === rows;
    this.info.cols = cols;
    this.info.rows = rows;
    return {
      requestedCols: cols,
      requestedRows: rows,
      appliedCols: cols,
      appliedRows: rows,
      outcome: unchanged ? ("unchanged" as const) : ("applied" as const),
    };
  });
  readPtyGeometry = vi.fn(
    (): { cols: number | null; rows: number | null } =>
      shared.ptyGeometryOverride ?? { cols: this.info.cols, rows: this.info.rows }
  );
  setSabModeEnabled = vi.fn();
  dispose = vi.fn();
  getActivityTier = vi.fn(() => "active" as const);

  constructor(
    id: string,
    options: PtyHostSpawnOptions,
    callbacks: TerminalCallbacks,
    _deps: unknown,
    _spawnContext: unknown,
    _ptyProcess: MockPtyProcess
  ) {
    this.id = id;
    this.options = options;
    this.callbacks = callbacks;
    this.info = {
      id,
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      kind: options.kind,
      launchAgentId: options.launchAgentId,
      launchGeneration: options.launchGeneration,
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      title: options.title,
      agentLaunchFlags: options.agentLaunchFlags,
      agentModelId: options.agentModelId,
      spawnedAt: Date.now(),
      isExited: false,
      wasKilled: false,
      outputBuffer: "",
      semanticBuffer: [],
      restartCount: 0,
    };
    shared.created.push(this);
  }

  getInfo() {
    return this.info;
  }

  shouldPreserveOnExit(): boolean {
    return false;
  }

  gracefulShutdownCalled = false;

  gracefulShutdown(): Promise<string | null> {
    this.gracefulShutdownCalled = true;
    return Promise.resolve(this.sessionId);
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
  trash(id: string, onExpire: (id: string) => void): void {
    shared.trashCallbacks.set(id, onExpire);
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
  MAX_PRESERVED_TERMINAL_SNAPSHOTS: 20,
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

vi.mock("../../utils/gitUtils.js", () => ({
  getGitBranch: shared.getGitBranch,
}));

vi.mock("../../utils/logger.js", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
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

function spawnOptions(overrides?: Partial<PtyHostSpawnOptions>): PtyHostSpawnOptions {
  return {
    cwd: "/repo",
    cols: 80,
    rows: 24,
    kind: "terminal",
    ...overrides,
  };
}

describe("PtyManager lifecycle ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared.terminals.clear();
    shared.created.length = 0;
    shared.trashCallbacks.clear();
    shared.ptyGeometryOverride = null;
    shared.computeSpawnContext.mockReturnValue({
      env: {},
      shell: "/bin/zsh",
      args: ["-l"],
    });
    shared.acquirePtyProcess.mockImplementation(() => ({
      ptyProcess: createPtyProcess(),
      prelude: "",
      dataHandoff: undefined,
    }));
    shared.agentTransitionState.mockReturnValue(true);
    shared.deleteSessionFile.mockResolvedValue(undefined);
    shared.getGitBranch.mockResolvedValue("feature/x");
  });

  it("applies a pre-first-spawn buffered resize as initial dims", () => {
    const manager = new PtyManager();

    // Renderer resize beats the spawn IPC — the classic race the buffer serves.
    manager.resize("t1", 132, 43);
    manager.spawn("t1", spawnOptions({ launchGeneration: 1 }));

    expect(shared.created[0]?.options.cols).toBe(132);
    expect(shared.created[0]?.options.rows).toBe(43);
  });

  it("stamps a resize result with the incarnation that applied it (#11641)", () => {
    const manager = new PtyManager();
    const results: Array<{ id: string; launchGeneration: number | null }> = [];
    manager.on("resize-result", (id: string, result: { launchGeneration: number | null }) => {
      results.push({ id, launchGeneration: result.launchGeneration });
    });

    manager.spawn("t1", spawnOptions({ launchGeneration: 1 }));
    manager.resize("t1", 120, 40);
    manager.kill("t1");
    shared.created[0]!.callbacks.onExit("t1", 0);
    manager.spawn("t1", spawnOptions({ launchGeneration: 2 }));
    manager.resize("t1", 130, 45);

    // Main filters stale echoes by generation, so a result that reports the
    // wrong incarnation would be attributed to the successor.
    expect(results).toEqual([
      { id: "t1", launchGeneration: 1 },
      { id: "t1", launchGeneration: 2 },
    ]);
  });

  it("defers a buffered resize's echo until spawn gives it an incarnation (#11641)", () => {
    const manager = new PtyManager();
    const results: Array<{ launchGeneration: number | null; appliedCols: number | null }> = [];
    manager.on(
      "resize-result",
      (_id: string, result: { launchGeneration: number | null; appliedCols: number | null }) => {
        results.push({
          launchGeneration: result.launchGeneration,
          appliedCols: result.appliedCols,
        });
      }
    );

    // Nothing has launched yet, so there is no incarnation to attribute the
    // geometry to.
    manager.resize("t1", 132, 43);
    expect(results).toEqual([]);

    // These buffered dims BECOME the PTY's boot geometry without passing
    // through resize(). Staying silent here would leave the renderer with no
    // applied geometry at all for a terminal whose first grid came from the
    // buffer, so a divergence at boot would go unseen.
    manager.spawn("t1", spawnOptions({ launchGeneration: 1 }));
    expect(results).toEqual([{ launchGeneration: 1, appliedCols: 132 }]);
  });

  it("reads the boot geometry back instead of echoing the request (#11641)", () => {
    const manager = new PtyManager();
    const results: unknown[] = [];
    manager.on("resize-result", (_id: string, result: unknown) => results.push(result));

    // The backend queued the boot geometry and still reports the old grid.
    // Claiming `applied` here would manufacture agreement with xterm and hide
    // the very split the echo exists to expose.
    shared.ptyGeometryOverride = { cols: 80, rows: 24 };
    manager.resize("t1", 132, 43);
    manager.spawn("t1", spawnOptions({ launchGeneration: 1 }));

    expect(results).toEqual([
      expect.objectContaining({
        outcome: "deferred",
        requestedCols: 132,
        requestedRows: 43,
        appliedCols: null,
        appliedRows: null,
      }),
    ]);
  });

  it("emits no echo for a spawn that did not consume a buffered resize (#11641)", () => {
    const manager = new PtyManager();
    const results: unknown[] = [];
    manager.on("resize-result", (...args: unknown[]) => results.push(args));

    manager.spawn("t1", spawnOptions({ launchGeneration: 1 }));

    expect(results).toEqual([]);
  });

  it("forwards the outcome and applied geometry, not just the generation (#11641)", () => {
    const manager = new PtyManager();
    const results: unknown[] = [];
    manager.on("resize-result", (_id: string, result: unknown) => results.push(result));

    manager.spawn("t1", spawnOptions({ launchGeneration: 1 }));
    manager.resize("t1", 120, 40);
    // Re-asserting the geometry the PTY already holds must still report it —
    // the dedup shortcut emits no SIGWINCH, so silence here is what would let a
    // stuck PTY go undetected.
    manager.resize("t1", 120, 40);
    // Out of range at the trust boundary: the direct MessagePort transport
    // reaches this method without passing through any other validation.
    manager.resize("t1", 40.5, 10);

    expect(results).toEqual([
      expect.objectContaining({ outcome: "applied", appliedCols: 120, requestedCols: 120 }),
      expect.objectContaining({ outcome: "unchanged", appliedCols: 120 }),
      expect.objectContaining({ outcome: "rejected", appliedCols: null, requestedCols: 40.5 }),
    ]);
  });

  it("drops a buffered resize stamped by a previous incarnation", () => {
    const manager = new PtyManager();

    manager.spawn("t1", spawnOptions({ launchGeneration: 1 }));
    manager.kill("t1");
    shared.created[0]!.callbacks.onExit("t1", 0);

    // Stale resize from the killed incarnation lands after the kill removed
    // the pendingResizes entry but before the respawn — buffered, stamped
    // with generation 1.
    manager.resize("t1", 500, 2);

    manager.spawn("t1", spawnOptions({ launchGeneration: 2 }));

    // The successor boots at its own spawn dims, not the stale geometry.
    expect(shared.created[1]?.options.cols).toBe(80);
    expect(shared.created[1]?.options.rows).toBe(24);
  });

  it("still applies a buffered resize when spawn adopts a fresh external generation", () => {
    const manager = new PtyManager();

    manager.resize("t1", 100, 30);
    manager.spawn("t1", spawnOptions({ launchGeneration: 7 }));

    expect(shared.created[0]?.options.cols).toBe(100);
    expect(shared.created[0]?.options.rows).toBe(30);
  });

  it("captures no resume record when a trashed assistant terminal expires", async () => {
    // The assistant cannot reach the trash today — the renderer routes
    // `removeOnExit` panels straight to removal — but the record that says so
    // lives here, a process away from that rule (#12183).
    const manager = new PtyManager();

    manager.spawn(
      "t1",
      spawnOptions({ launchAgentId: "claude", launchGeneration: 3, isAssistantTerminal: true })
    );
    shared.created[0]!.sessionId = "sess-1";

    manager.trash("t1");
    shared.trashCallbacks.get("t1")!("t1");
    await vi.waitFor(() => {
      expect(shared.created[0]!.gracefulShutdownCalled).toBe(true);
    });

    expect(shared.eventsEmit).not.toHaveBeenCalledWith("agent-session:captured", expect.anything());
  });

  it("stamps terminalId and launchGeneration on trash-expiry session captures", async () => {
    const manager = new PtyManager();

    manager.spawn(
      "t1",
      spawnOptions({
        launchAgentId: "claude",
        launchGeneration: 3,
        worktreeId: "wt-a",
        agentModelId: "opus",
      })
    );
    shared.created[0]!.sessionId = "sess-1";
    shared.created[0]!.info.title = "Claude";

    manager.trash("t1");
    shared.trashCallbacks.get("t1")!("t1");
    await vi.waitFor(() => {
      expect(shared.eventsEmit).toHaveBeenCalledWith(
        "agent-session:captured",
        expect.objectContaining({
          terminalId: "t1",
          launchGeneration: 3,
          record: expect.objectContaining({
            sessionId: "sess-1",
            agentId: "claude",
            worktreeId: "wt-a",
            agentModelId: "opus",
          }),
        })
      );
    });
  });
});
