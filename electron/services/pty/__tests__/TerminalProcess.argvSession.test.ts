import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubProcessKillForFile } from "../../../__tests__/helpers/processKillGuard.js";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import { AgentStateService } from "../AgentStateService.js";
import type { SpawnContext } from "../terminalSpawn.js";
import type { ProcessInfo, ProcessTreeCache } from "../../ProcessTreeCache.js";
import type { ProcessDetector } from "../../ProcessDetector.js";
import { events, type DaintreeEventMap } from "../../events.js";
import { resetAgentSessionCaptureDeliveryForTests } from "../agentSessionCaptureDelivery.js";

/**
 * #15994 through the production wiring: census rows into the real detector,
 * the real state machine counting runs, and the terminal's own observer
 * registration — nothing calls the observation handler by hand.
 */

vi.mock("../../../utils/windowsTreeKill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/windowsTreeKill.js")>()),
  killWindowsProcessTrees: vi.fn(async () => []),
  killWindowsProcessTreesSync: vi.fn(() => []),
}));

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

vi.mock("../terminalSessionPersistence.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  TERMINAL_SESSION_PERSISTENCE_ENABLED: false,
  persistSessionSnapshotSync: vi.fn(),
  persistSessionSnapshotAsync: vi.fn(),
}));

vi.mock("../../../utils/gitUtils.js", () => ({ getGitBranch: vi.fn(async () => null) }));

// Mock ptys carry made-up PIDs; every kill path must land on a stub (#14418).
stubProcessKillForFile(600);

const PTY_PID = 123;
const OLD_ID = "019a0000-0000-7000-8000-0000000001d0";
const HAND_ID = "0199f8c1-2b4d-7e3a-9f10-5c6d7e8f9a0b";

function createMockPty(pid: number): IPty {
  return {
    pid,
    cols: 80,
    rows: 24,
    write: () => {},
    resize: () => {},
    kill: vi.fn(),
    pause: () => {},
    resume: () => {},
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
  } as unknown as IPty;
}

/** A census whose rows the test sets, refreshed only when the test says so. */
function createCensus(): {
  cache: ProcessTreeCache;
  show: (rows: Array<{ pid: number; command: string; comm?: string }>) => void;
  refresh: () => void;
} {
  let rows: ProcessInfo[] = [];
  const listeners = new Set<() => void>();
  const cache = {
    getDescendantPids: vi.fn(() => rows.map((row) => row.pid)),
    getChildPids: vi.fn(() => rows.map((row) => row.pid)),
    getChildren: vi.fn((pid: number) => (pid === PTY_PID ? rows : [])),
    getProcess: vi.fn(),
    hasChildren: vi.fn(() => rows.length > 0),
    start: vi.fn(),
    stop: vi.fn(),
    onRefresh: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    refresh: vi.fn(),
    getLastRefreshTime: vi.fn(() => 0),
    getLastError: vi.fn(() => null),
    getCacheSize: vi.fn(() => rows.length),
  } as unknown as ProcessTreeCache;
  return {
    cache,
    show: (next) => {
      rows = next.map(({ pid, command, comm = "node" }) => ({
        pid,
        ppid: PTY_PID,
        comm,
        command,
        cpuPercent: 0,
        memoryKb: 0,
      }));
    },
    refresh: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

type TerminalProcessOptions = ConstructorParameters<typeof TerminalProcess>[1];
type TerminalProcessDeps = ConstructorParameters<typeof TerminalProcess>[3];

function createCodexPane(cache: ProcessTreeCache, ptyPid = PTY_PID): TerminalProcess {
  const options = {
    cwd: "/tmp/argv-session",
    cols: 80,
    rows: 24,
    kind: "terminal",
    launchAgentId: "codex",
    projectId: "proj-1",
    launchGeneration: 5,
  } as TerminalProcessOptions;
  const ctx: SpawnContext = { shell: "/bin/zsh", args: ["-l"], env: {} };
  const terminal = new TerminalProcess(
    "t-argv",
    options,
    { emitData: () => {}, onExit: () => {} },
    {
      agentStateService: new AgentStateService(),
      ptyPool: null,
      processTreeCache: cache,
    } as unknown as TerminalProcessDeps,
    ctx,
    createMockPty(ptyPid)
  );
  // The production probe's pre-first-read sentinel would hold every demotion.
  (
    terminal as unknown as { readForegroundProcessGroupSnapshot: () => null }
  ).readForegroundProcessGroupSnapshot = () => null;
  return terminal;
}

function detector(terminal: TerminalProcess): ProcessDetector {
  const found = terminal.getInfo().processDetector;
  if (!found) throw new Error("terminal has no process detector");
  return found as ProcessDetector;
}

/** Codex quits and its prompt returns: the lifecycle signal that demotes. */
function quitToShell(terminal: TerminalProcess): void {
  detector(terminal).clearShellCommandEvidence("prompt-return");
}

describe("a hand-resumed run read off the census (#15994)", () => {
  let observed: Array<[string, number]>;
  let off: () => void;
  let terminal: TerminalProcess | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    observed = [];
    off = events.on("agent-session:observed", (p: DaintreeEventMap["agent-session:observed"]) =>
      observed.push([p.sessionId, p.run.agentIncarnation])
    );
  });

  afterEach(() => {
    terminal?.dispose();
    terminal = undefined;
    off();
    resetAgentSessionCaptureDeliveryForTests();
    vi.useRealTimers();
  });

  it("files the typed resume under the new run, past a row the last run left behind", async () => {
    const census = createCensus();
    census.show([{ pid: 456, command: `node /opt/homebrew/bin/codex resume ${OLD_ID}` }]);
    terminal = createCodexPane(census.cache);
    census.refresh();
    expect(observed).toEqual([[OLD_ID, 0]]);

    quitToShell(terminal);
    expect(terminal.getInfo().agentState).toBe("exited");

    // Typed before the census drops the old row: the typed command promotes
    // the next run against that stale row.
    terminal.write(`codex resume ${HAND_ID}\r`);
    await vi.advanceTimersByTimeAsync(1_300);
    expect(terminal.getInfo().detectedAgentId).toBe("codex");
    expect(terminal.getInfo().agentIncarnation).toBe(1);
    expect(observed).toEqual([[OLD_ID, 0]]);

    census.show([{ pid: 789, command: `node /opt/homebrew/bin/codex resume ${HAND_ID}` }]);
    census.refresh();
    census.refresh();
    expect(observed).toEqual([
      [OLD_ID, 0],
      [HAND_ID, 1],
    ]);
  });

  it("records nothing for a fresh conversation whose quoted prompt reads like a resume", async () => {
    const census = createCensus();
    census.show([{ pid: 456, command: "node /opt/homebrew/bin/codex" }]);
    terminal = createCodexPane(census.cache);
    census.refresh();
    quitToShell(terminal);

    terminal.write(`codex "resume ${HAND_ID}"\r`);
    // POSIX `ps` drops the quotes: the census alone reads a resume.
    census.show([{ pid: 789, command: `node /opt/homebrew/bin/codex resume ${HAND_ID}` }]);
    census.refresh();
    census.refresh();

    expect(terminal.getInfo().agentIncarnation).toBe(1);
    expect(observed).toEqual([]);
  });

  it("reads argv on a detector started once a Windows PTY's pid resolves", () => {
    const census = createCensus();
    census.show([
      { pid: 456, comm: "codex.exe", command: `C:\\tools\\codex.exe resume ${HAND_ID}` },
    ]);
    terminal = createCodexPane(census.cache, 0);
    expect(terminal.getInfo().processDetector).toBeUndefined();

    (terminal.getInfo().ptyProcess as { pid: number }).pid = PTY_PID;
    (terminal as unknown as { startProcessDetector: () => void }).startProcessDetector();
    census.refresh();

    expect(observed).toEqual([[HAND_ID, 0]]);
  });
});
