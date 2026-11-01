import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubProcessKillForFile } from "../../../__tests__/helpers/processKillGuard.js";
import type { IPty } from "node-pty";
import { TerminalProcess } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import { events } from "../../events.js";
import { TurnOutcomeService } from "../../mcp-server/turnOutcomeLog.js";

vi.mock("../../../utils/windowsTreeKill.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/windowsTreeKill.js")>()),
  killWindowsProcessTrees: vi.fn(async () => []),
  killWindowsProcessTreesSync: vi.fn(() => []),
}));

vi.mock("node-pty", () => {
  return { spawn: vi.fn() };
});

let ptyOnDataCallback: ((data: string) => void) | null = null;

function createMockPty(): IPty {
  const pty: Partial<IPty> = {
    pid: 123,
    cols: 80,
    rows: 24,
    write: () => {},
    resize: () => {},
    kill: vi.fn(),
    pause: () => {},
    resume: () => {},
    onData: (cb: (data: string) => void) => {
      ptyOnDataCallback = cb;
      return { dispose: () => {} };
    },
    onExit: () => ({ dispose: () => {} }),
  };
  const withDestroy = pty as Partial<IPty> & { destroy: () => void };
  withDestroy.destroy = vi.fn();
  return pty as IPty;
}

const spawnContext: SpawnContext = { shell: "/bin/zsh", args: ["-l"], env: {} };

/**
 * Main's half of the path, wired the way McpServerService wires it: every
 * agent:output payload goes to `appendOutput`, and a turn ends on the FSM
 * transition the pty-host emits after its synchronous flush. `seenAtTurnEnd`
 * is the ring the classifier read at each turn end.
 */
function createMain() {
  let boundSession: string | null = null;
  const service = new TurnOutcomeService({
    saveConfig: () => {},
    readConfig: () => ({ auditEnabled: true, auditMaxRecords: 500 }),
    getSessionIdForTerminal: () => boundSession,
    getRecentAuditRecords: () => [],
    logStore: { read: () => [], write: () => {} },
  });
  const forwarded: string[] = [];
  const seenAtTurnEnd: string[] = [];
  const off = events.on("agent:output", (payload) => {
    forwarded.push(payload.data);
    if (payload.terminalId) service.appendOutput(payload.terminalId, payload.data);
  });
  const transition = (terminalId: string, previousState: string, state: string): void => {
    if (state !== "working") seenAtTurnEnd.push(service.getRecentOutput(terminalId));
    service.handleTransition({
      terminalId,
      previousState,
      state,
      trigger: "output",
      timestamp: Date.now(),
    });
  };
  return {
    service,
    forwarded,
    seenAtTurnEnd,
    transition,
    bind: (sessionId: string) => {
      boundSession = sessionId;
    },
    dispose: off,
  };
}

type Main = ReturnType<typeof createMain>;

function createTerminal(main: Main, options: { isAssistantTerminal?: boolean }): TerminalProcess {
  return new TerminalProcess(
    "t1",
    {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      kind: "terminal" as const,
      launchAgentId: "claude",
      ...options,
    },
    { emitData: () => {}, onExit: () => {} },
    {
      agentStateService: {
        handleActivityState: (_info: unknown, state: "busy" | "idle" | "completed") => {
          if (state === "busy") main.transition("t1", "idle", "working");
          else main.transition("t1", "working", state);
        },
        updateAgentState: () => {},
        emitAgentKilled: () => {},
      } as unknown as ConstructorParameters<typeof TerminalProcess>[3]["agentStateService"],
      ptyPool: null,
      processTreeCache: null,
    },
    spawnContext,
    createMockPty()
  );
}

/** The analysis backend's turn-end path: flush, then the FSM transition. */
function endTurn(terminal: TerminalProcess): void {
  const internals = terminal as unknown as {
    terminalInfo: { spawnedAt: number };
    handleAnalysisActivityState(spawnedAt: number, state: "idle"): void;
  };
  internals.handleAnalysisActivityState(internals.terminalInfo.spawnedAt, "idle");
}

const ANSWER =
  "Updated the forwarder gate and its tests; the bound terminal still sees every byte.\r\n";
const HEDGE = "I'm not sure the earlier binding covered this case.\r\n";

stubProcessKillForFile(600);

describe("TerminalProcess output reaching the turn-outcome classifier (#15667)", () => {
  let main: Main;

  beforeEach(() => {
    vi.useFakeTimers();
    ptyOnDataCallback = null;
    main = createMain();
  });

  afterEach(() => {
    main.dispose();
    vi.useRealTimers();
    vi.clearAllTimers();
  });

  it("hands Main an Assistant terminal's every byte, in order, before the turn ends", () => {
    main.bind("session-1");
    const terminal = createTerminal(main, { isAssistantTerminal: true });
    // Over the size trigger, so it flushes on arrival rather than on the timer.
    const big = `${"x".repeat(2500)}\r\n`;

    ptyOnDataCallback!("first ");
    vi.advanceTimersByTime(50);
    ptyOnDataCallback!(big);
    ptyOnDataCallback!(HEDGE);
    // The hedge is still pending in the coalescing window when the turn ends.
    endTurn(terminal);

    expect(main.forwarded.join("")).toBe(`first ${big}${HEDGE}`);
    expect(main.seenAtTurnEnd.at(-1)).toBe(`first ${big}${HEDGE}`);
    const records = main.service.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ terminalId: "t1", sessionId: "session-1" });
    expect(records[0].outcome).toBe("hedged");

    terminal.dispose();
  });

  it("classifies a mid-output bind from the first batch that arrives after it", () => {
    const terminal = createTerminal(main, { isAssistantTerminal: true });

    // Flushed while unbound: Main drops it, exactly as it always has.
    ptyOnDataCallback!(HEDGE);
    vi.advanceTimersByTime(50);
    // Produced before the bind but still pending, so it arrives after it.
    ptyOnDataCallback!("pending at bind. ");
    main.bind("session-1");
    ptyOnDataCallback!(ANSWER);
    endTurn(terminal);

    expect(main.forwarded.join("")).toBe(`${HEDGE}pending at bind. ${ANSWER}`);
    expect(main.seenAtTurnEnd.at(-1)).toBe(`pending at bind. ${ANSWER}`);
    const records = main.service.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("answered");

    terminal.dispose();
  });

  it("sends Main nothing for an agent terminal that is not the Assistant", () => {
    const terminal = createTerminal(main, {});

    ptyOnDataCallback!(ANSWER);
    ptyOnDataCallback!("y".repeat(2500));
    vi.advanceTimersByTime(100);
    endTurn(terminal);
    terminal.dispose();

    expect(main.forwarded).toEqual([]);
    expect(main.seenAtTurnEnd.every((seen) => seen === "")).toBe(true);
    expect(main.service.getRecords()).toEqual([]);
  });
});
