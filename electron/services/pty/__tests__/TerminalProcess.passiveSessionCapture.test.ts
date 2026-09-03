import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import type { ProcessTreeCache } from "../../ProcessTreeCache.js";
import type { DetectionResult } from "../../ProcessDetector.js";
import { makeAgentResult, makeNoAgentResult } from "../../ProcessDetector.js";
import { events } from "../../events.js";
import type { DaintreeEventMap } from "../../events.js";
import { getAgentConfig } from "../../../../shared/config/agentRegistry.js";

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

vi.mock("../terminalSessionPersistence.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    TERMINAL_SESSION_PERSISTENCE_ENABLED: false,
    persistSessionSnapshotSync: vi.fn(),
    persistSessionSnapshotAsync: vi.fn(),
  };
});

// The capture stamps a best-effort branch by shelling out to git. Never let a
// unit test spawn a real process — and pin the value so the record assertions
// below can prove the stamp actually rides along.
vi.mock("../../../utils/gitUtils.js", () => ({
  getGitBranch: vi.fn(async () => "feature/passive-capture"),
}));

const SESSION_ID = "0199f8c1-2b4d-7e3a-9f10-5c6d7e8f9a0b";

/** Codex's real hint line, so a pattern change upstream fails these tests. */
function codexHint(id: string): string {
  const resume = getAgentConfig("codex")?.resume;
  if (resume?.kind !== "session-id" || !resume.sessionIdPattern) {
    throw new Error("codex must declare a sessionIdPattern");
  }
  const line = `  To continue this session, run codex resume ${id}`;
  if (!new RegExp(resume.sessionIdPattern).test(line)) {
    throw new Error("fixture no longer matches codex's declared sessionIdPattern");
  }
  return line;
}

type MockPty = IPty & {
  __emitData: (data: string) => void;
  __emitExit: (exitCode?: number, signal?: number) => void;
};

function createMockPty(): MockPty {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  const pty: Partial<MockPty> = {
    // 0, not a plausible pid: kill paths route through ProcessTreeKiller, which
    // signals a real process for any pid > 0.
    pid: 0,
    cols: 80,
    rows: 24,
    write: () => {},
    resize: () => {},
    kill: vi.fn(),
    pause: () => {},
    resume: () => {},
    onData: (callback: (data: string) => void) => {
      dataListeners.add(callback);
      return { dispose: () => dataListeners.delete(callback) };
    },
    onExit: (callback: (event: { exitCode: number; signal?: number }) => void) => {
      exitListeners.add(callback);
      return { dispose: () => exitListeners.delete(callback) };
    },
    __emitData: (data: string) => {
      for (const listener of dataListeners) listener(data);
    },
    __emitExit: (exitCode = 0, signal = 0) => {
      for (const listener of [...exitListeners]) listener({ exitCode, signal });
    },
  };
  return pty as MockPty;
}

function createMockProcessTreeCache(): ProcessTreeCache {
  return {
    getDescendantPids: vi.fn().mockReturnValue([]),
    getChildPids: vi.fn().mockReturnValue([]),
    getChildren: vi.fn().mockReturnValue([]),
    getProcess: vi.fn(),
    hasChildren: vi.fn().mockReturnValue(false),
    start: vi.fn(),
    stop: vi.fn(),
    onRefresh: vi.fn().mockReturnValue(() => {}),
    refresh: vi.fn(),
    getLastRefreshTime: vi.fn().mockReturnValue(0),
    getLastError: vi.fn().mockReturnValue(null),
    getCacheSize: vi.fn().mockReturnValue(0),
  } as unknown as ProcessTreeCache;
}

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];
type TerminalProcessDeps = ConstructorParameters<typeof TerminalProcess>[3];

function createTerminal(overrides: Partial<Record<string, unknown>> = {}): TerminalProcess {
  const options = {
    cwd: "/tmp/passive-capture",
    cols: 80,
    rows: 24,
    kind: "terminal",
    launchAgentId: "codex",
    projectId: "proj-1",
    worktreeId: "wt-1",
    agentLaunchFlags: ["--yolo"],
    agentModelId: "gpt-5",
    launchGeneration: 7,
    ...overrides,
  } as TerminalProcessOptions;
  const ctx: SpawnContext = { shell: "/bin/zsh", args: ["-l"], env: {} };
  const terminal = new TerminalProcess(
    "t-passive",
    options,
    { emitData: () => {}, onExit: () => {} },
    {
      agentStateService: {
        handleActivityState: () => {},
        updateAgentState: () => {},
        emitAgentKilled: () => {},
        emitAgentCompleted: () => {},
      } as unknown as TerminalProcessDeps["agentStateService"],
      ptyPool: null,
      processTreeCache: createMockProcessTreeCache(),
    } as TerminalProcessDeps,
    ctx,
    createMockPty()
  );
  // The production foreground probe is an async stale-while-revalidate cache
  // whose pre-first-probe sentinel would hold the demotion gate closed here.
  (
    terminal as unknown as { readForegroundProcessGroupSnapshot: () => null }
  ).readForegroundProcessGroupSnapshot = () => null;
  return terminal;
}

function spawnedAt(terminal: TerminalProcess): number {
  return (terminal as unknown as { terminalInfo: { spawnedAt: number } }).terminalInfo.spawnedAt;
}

function detect(
  terminal: TerminalProcess,
  result: DetectionResult,
  at = spawnedAt(terminal)
): void {
  (
    terminal as unknown as { handleAgentDetection: (r: DetectionResult, s: number) => void }
  ).handleAgentDetection(result, at);
}

function mockPty(terminal: TerminalProcess): MockPty {
  return terminal.getInfo().ptyProcess as MockPty;
}

/** Promote to a live Codex identity, the state both boundaries start from. */
function promoteCodex(terminal: TerminalProcess): void {
  detect(terminal, makeAgentResult({ agentType: "codex", processIconId: "codex" }));
}

/** Prompt-return is the evidence that clears a launch-anchored agent. */
function demote(terminal: TerminalProcess): void {
  detect(terminal, makeNoAgentResult({ evidenceSource: "shell_command" }));
}

describe("passive agent session capture", () => {
  let captured: DaintreeEventMap["agent-session:captured"][];
  let unsubscribe: () => void;
  let terminals: TerminalProcess[];

  beforeEach(() => {
    captured = [];
    terminals = [];
    unsubscribe = events.on("agent-session:captured", (payload) => {
      captured.push(payload);
    });
  });

  afterEach(() => {
    unsubscribe();
    for (const terminal of terminals) {
      try {
        terminal.dispose();
      } catch {
        // Already torn down by the test.
      }
    }
    vi.clearAllMocks();
  });

  function track(terminal: TerminalProcess): TerminalProcess {
    terminals.push(terminal);
    return terminal;
  }

  async function settle(): Promise<void> {
    await vi.waitFor(() => expect(captured.length).toBeGreaterThan(0));
  }

  describe("natural PTY exit", () => {
    it("captures the resume hint the agent printed on its way out", async () => {
      const terminal = track(createTerminal());
      promoteCodex(terminal);
      mockPty(terminal).__emitData(`${codexHint(SESSION_ID)}\n`);
      mockPty(terminal).__emitExit(0);

      await settle();
      expect(captured).toHaveLength(1);
      expect(captured[0].terminalId).toBe("t-passive");
      // A PTY exit is one close per incarnation, so it keeps the ledger gate.
      expect(captured[0].launchGeneration).toBe(7);
      expect(captured[0].record).toEqual({
        sessionId: SESSION_ID,
        agentId: "codex",
        worktreeId: "wt-1",
        title: expect.anything(),
        projectId: "proj-1",
        agentLaunchFlags: ["--yolo"],
        agentModelId: "gpt-5",
        cwd: "/tmp/passive-capture",
        branch: "feature/passive-capture",
      });
    });

    it("accepts a hint delivered with no trailing newline before exit", async () => {
      const terminal = track(createTerminal());
      promoteCodex(terminal);
      mockPty(terminal).__emitData(codexHint(SESSION_ID));
      mockPty(terminal).__emitExit(0);

      await settle();
      expect(captured[0].record.sessionId).toBe(SESSION_ID);
    });

    it("takes the last hint when the buffer holds more than one", async () => {
      const terminal = track(createTerminal());
      promoteCodex(terminal);
      mockPty(terminal).__emitData(`${codexHint("stale-session-id")}\n`);
      mockPty(terminal).__emitData(`${codexHint(SESSION_ID)}\n`);
      mockPty(terminal).__emitExit(0);

      await settle();
      expect(captured[0].record.sessionId).toBe(SESSION_ID);
    });

    it("captures a hint wrapped in ANSI decoration", async () => {
      const terminal = track(createTerminal());
      promoteCodex(terminal);
      mockPty(terminal).__emitData(`\x1b[2m${codexHint(SESSION_ID)}\x1b[0m\r\n`);
      mockPty(terminal).__emitExit(0);

      await settle();
      expect(captured[0].record.sessionId).toBe(SESSION_ID);
    });

    it("stays silent when the terminal was killed — teardown already captured", async () => {
      const terminal = track(createTerminal());
      promoteCodex(terminal);
      mockPty(terminal).__emitData(`${codexHint(SESSION_ID)}\n`);
      terminal.kill("graceful-shutdown");
      mockPty(terminal).__emitExit(0);

      await vi.waitFor(() => expect(true).toBe(true));
      expect(captured).toHaveLength(0);
    });

    it("stays silent when the agent printed no hint", async () => {
      const terminal = track(createTerminal());
      promoteCodex(terminal);
      mockPty(terminal).__emitData("goodbye\n$ \n");
      mockPty(terminal).__emitExit(0);

      await vi.waitFor(() => expect(true).toBe(true));
      expect(captured).toHaveLength(0);
    });

    it("stays silent for a terminal that never hosted an agent", async () => {
      const terminal = track(createTerminal({ launchAgentId: undefined }));
      mockPty(terminal).__emitData(`${codexHint(SESSION_ID)}\n`);
      mockPty(terminal).__emitExit(0);

      await vi.waitFor(() => expect(true).toBe(true));
      expect(captured).toHaveLength(0);
    });
  });

  describe("demotion to a surviving shell", () => {
    it("captures the resume hint when the agent quits but the pane lives on", async () => {
      const terminal = track(createTerminal());
      promoteCodex(terminal);
      mockPty(terminal).__emitData(`${codexHint(SESSION_ID)}\n\nuser@host project % `);
      demote(terminal);

      await settle();
      expect(captured).toHaveLength(1);
      expect(captured[0].record.sessionId).toBe(SESSION_ID);
      // Deliberately ungated: a surviving shell can host several agent runs in
      // one generation, and gating would let the first consume the only slot.
      expect(captured[0].launchGeneration).toBeNull();
    });

    it("still clears the live identity and emits agent:exited", async () => {
      const exited: unknown[] = [];
      const off = events.on("agent:exited", (payload) => exited.push(payload));
      try {
        const terminal = track(createTerminal());
        promoteCodex(terminal);
        mockPty(terminal).__emitData(`${codexHint(SESSION_ID)}\n$ `);
        demote(terminal);

        await settle();
        expect(terminal.getInfo().detectedAgentId).toBeUndefined();
        expect(exited).toHaveLength(1);
      } finally {
        off();
      }
    });

    it("rejects a mid-conversation mention pushed past the trailing-line window", async () => {
      const terminal = track(createTerminal());
      promoteCodex(terminal);
      mockPty(terminal).__emitData(
        [
          `I resumed it earlier with codex resume ${SESSION_ID} and it worked`,
          "$ npm test",
          "  ok 1 - first",
          "  ok 2 - second",
          "  ok 3 - third",
          "user@host project % ",
        ].join("\n")
      );
      demote(terminal);

      await vi.waitFor(() => expect(true).toBe(true));
      expect(captured).toHaveLength(0);
    });

    it("holds a hint that is still mid-arrival on a live PTY", async () => {
      const terminal = track(createTerminal());
      promoteCodex(terminal);
      // No trailing character yet — the id may still be arriving, and a
      // truncated id would send restore to a session that does not exist.
      mockPty(terminal).__emitData(codexHint(SESSION_ID.slice(0, 18)));
      demote(terminal);

      await vi.waitFor(() => expect(true).toBe(true));
      expect(captured).toHaveLength(0);
    });

    it("captures each agent run in a shell that hosts several", async () => {
      const terminal = track(createTerminal());
      promoteCodex(terminal);
      mockPty(terminal).__emitData(`${codexHint(SESSION_ID)}\n$ `);
      demote(terminal);
      await settle();

      promoteCodex(terminal);
      mockPty(terminal).__emitData(`${codexHint("second-run-session-id")}\n$ `);
      demote(terminal);

      await vi.waitFor(() => expect(captured).toHaveLength(2));
      expect(captured.map((c) => c.record.sessionId)).toEqual([
        SESSION_ID,
        "second-run-session-id",
      ]);
      expect(captured.every((c) => c.launchGeneration === null)).toBe(true);
    });

    it("stays silent when a plain process icon clears with no agent behind it", async () => {
      const terminal = track(createTerminal({ launchAgentId: undefined }));
      detect(terminal, makeAgentResult({ processIconId: "npm", processName: "npm" }));
      mockPty(terminal).__emitData(`${codexHint(SESSION_ID)}\n$ `);
      demote(terminal);

      await vi.waitFor(() => expect(true).toBe(true));
      expect(captured).toHaveLength(0);
    });

    it("stays silent for a stale detection from a previous incarnation", async () => {
      const terminal = track(createTerminal());
      promoteCodex(terminal);
      // Deliberately no prompt-shaped tail: IdentityWatcher's own prompt-return
      // heuristic drives a genuine demotion through the same entry point, which
      // would make the stale-guard assertion below vacuous. The identity check
      // proves no real demotion slipped in.
      mockPty(terminal).__emitData(`${codexHint(SESSION_ID)}\nthinking...\n`);
      detect(terminal, makeNoAgentResult({ evidenceSource: "shell_command" }), 1);

      await vi.waitFor(() => expect(true).toBe(true));
      expect(terminal.getInfo().detectedAgentId).toBe("codex");
      expect(captured).toHaveLength(0);
    });
  });

  describe("record construction", () => {
    it("omits launch flags and model for an agent Daintree did not launch", async () => {
      const terminal = track(createTerminal({ launchAgentId: "claude" }));
      // The user quit Claude and started Codex by hand in the same pane.
      promoteCodex(terminal);
      mockPty(terminal).__emitData(`${codexHint(SESSION_ID)}\n$ `);
      demote(terminal);

      await settle();
      expect(captured[0].record.agentId).toBe("codex");
      expect(captured[0].record.agentLaunchFlags).toBeUndefined();
      expect(captured[0].record.agentModelId).toBeUndefined();
    });

    it("prefers the observed task title unless the user locked the title", async () => {
      const terminal = track(createTerminal());
      promoteCodex(terminal);
      const info = terminal.getInfo();
      info.lastObservedTitle = "Fixing the parser";
      mockPty(terminal).__emitData(`${codexHint(SESSION_ID)}\n$ `);
      demote(terminal);

      await settle();
      expect(captured[0].record.title).toBe("Fixing the parser");
    });
  });

  describe("logging", () => {
    it("never writes the captured session id into the log context", async () => {
      const terminal = track(createTerminal());
      promoteCodex(terminal);
      mockPty(terminal).__emitData(`${codexHint(SESSION_ID)}\n$ `);
      demote(terminal);

      await settle();
      const { logBuffer } = await import("../../LogBuffer.js");
      const serialized = JSON.stringify(logBuffer.getAll());
      expect(serialized).not.toContain(SESSION_ID);
    });
  });
});
