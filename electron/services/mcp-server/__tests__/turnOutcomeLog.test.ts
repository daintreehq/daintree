import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TurnOutcomeService,
  classifyTurnOutcome,
  type FsmTransition,
  type TurnOutcomeServiceDeps,
} from "../turnOutcomeLog.js";
import type {
  AssistantTurnRecord,
  McpAuditRecord,
} from "../../../../shared/types/ipc/mcpServer.js";

function makeAuditRecord(overrides: Partial<McpAuditRecord>): McpAuditRecord {
  return {
    id: overrides.id ?? "audit-1",
    timestamp: overrides.timestamp ?? Date.now(),
    toolId: overrides.toolId ?? "agent.getState",
    // The classifier joins on helpSessionId (the help-session id); sessionId
    // is the MCP transport id and intentionally never matches it.
    sessionId: overrides.sessionId ?? "mcp-transport-1",
    helpSessionId: overrides.helpSessionId ?? "session-1",
    tier: overrides.tier ?? "action",
    argsSummary: overrides.argsSummary ?? "{}",
    result: overrides.result ?? "success",
    durationMs: overrides.durationMs ?? 12,
    schemaVersion: overrides.schemaVersion ?? 1,
    severity: overrides.severity ?? "info",
    ...(overrides.errorCode !== undefined ? { errorCode: overrides.errorCode } : {}),
    ...(overrides.confirmationDecision !== undefined
      ? { confirmationDecision: overrides.confirmationDecision }
      : {}),
    ...(overrides.turnId !== undefined ? { turnId: overrides.turnId } : {}),
    ...(overrides.repeatCount !== undefined ? { repeatCount: overrides.repeatCount } : {}),
  };
}

function makeTransition(overrides: Partial<FsmTransition> = {}): FsmTransition {
  return {
    terminalId: "term-1",
    state: "idle",
    previousState: "working",
    trigger: "output",
    timestamp: Date.now(),
    ...overrides,
  };
}

interface Fixture {
  config: Record<string, unknown>;
  service: TurnOutcomeService;
  saveConfig: ReturnType<typeof vi.fn>;
  logStore: { read: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> };
  getPersistedLog: () => unknown[];
  getSessionIdForTerminal: (terminalId: string) => string | null;
  getRecentAuditRecords: () => readonly McpAuditRecord[];
  flushPersist: () => void;
}

function makeFixture(
  opts: {
    initialConfig?: Record<string, unknown>;
    initialLog?: unknown[];
    sessionId?: string | null;
    auditRecords?: McpAuditRecord[];
  } = {}
): Fixture {
  const config: Record<string, unknown> = {
    auditEnabled: true,
    auditMaxRecords: 500,
    ...(opts.initialConfig ?? {}),
  };
  const saveConfig = vi.fn((patch: Record<string, unknown>) => {
    Object.assign(config, patch);
  });
  let persistedLog: unknown[] = [...(opts.initialLog ?? [])];
  const logStore = {
    read: vi.fn(() => persistedLog),
    write: vi.fn((records: unknown[]) => {
      persistedLog = records;
    }),
  };
  const sessionId = "sessionId" in opts ? opts.sessionId : "session-1";
  const getSessionIdForTerminal = vi.fn((_terminalId: string) => sessionId) as unknown as (
    terminalId: string
  ) => string | null;
  const getRecentAuditRecords = vi.fn(
    () => opts?.auditRecords ?? []
  ) as unknown as () => readonly McpAuditRecord[];
  const deps: TurnOutcomeServiceDeps = {
    saveConfig,
    readConfig: () => config,
    getSessionIdForTerminal,
    getRecentAuditRecords,
    logStore,
  };
  const service = new TurnOutcomeService(deps);
  return {
    config,
    service,
    saveConfig,
    logStore,
    getPersistedLog: () => persistedLog,
    getSessionIdForTerminal,
    getRecentAuditRecords,
    flushPersist: () => {
      service.flushNow();
    },
  };
}

describe("classifyTurnOutcome", () => {
  it("returns agent-stuck on watchdog-timeout waiting → idle regardless of buffer", () => {
    expect(
      classifyTurnOutcome({
        transition: makeTransition({
          previousState: "waiting",
          state: "idle",
          trigger: "timeout",
        }),
        recentOutput: "(empty)",
        recentAuditRecords: [],
        sessionId: "session-1",
      })
    ).toBe("agent-stuck");
  });

  it("returns tier-rejected when most recent session audit is unauthorized", () => {
    const audit = makeAuditRecord({
      sessionId: "session-1",
      result: "unauthorized",
      errorCode: "TIER_NOT_PERMITTED",
    });
    expect(
      classifyTurnOutcome({
        transition: makeTransition(),
        recentOutput: "I cannot do that".padEnd(120, " "),
        recentAuditRecords: [audit],
        sessionId: "session-1",
      })
    ).toBe("tier-rejected");
  });

  it("returns tool-error when most recent session audit is error and not unauthorized", () => {
    const audit = makeAuditRecord({
      sessionId: "session-1",
      result: "error",
      errorCode: "DISPATCH_THREW",
    });
    expect(
      classifyTurnOutcome({
        transition: makeTransition(),
        recentOutput: "Done.".padEnd(120, " "),
        recentAuditRecords: [audit],
        sessionId: "session-1",
      })
    ).toBe("tool-error");
  });

  it("returns reasoning-loop when 3+ identical (toolId, argsSummary) calls exist in the turn window", () => {
    const records = [
      makeAuditRecord({ id: "r1", toolId: "agent.getState", argsSummary: "{}" }),
      makeAuditRecord({ id: "r2", toolId: "agent.getState", argsSummary: "{}" }),
      makeAuditRecord({ id: "r3", toolId: "agent.getState", argsSummary: "{}" }),
    ];
    expect(
      classifyTurnOutcome({
        transition: makeTransition(),
        recentOutput: "Let me check the state again.".padEnd(120, " "),
        recentAuditRecords: records,
        sessionId: "session-1",
      })
    ).toBe("reasoning-loop");
  });

  it("does not trigger reasoning-loop below the threshold (2 identical calls)", () => {
    const records = [
      makeAuditRecord({ id: "r1", toolId: "agent.getState", argsSummary: "{}" }),
      makeAuditRecord({ id: "r2", toolId: "agent.getState", argsSummary: "{}" }),
    ];
    expect(
      classifyTurnOutcome({
        transition: makeTransition(),
        recentOutput: "Here is the answer you asked for: the file was updated and tests pass.",
        recentAuditRecords: records,
        sessionId: "session-1",
      })
    ).toBe("answered");
  });

  it("counts interleaved identical calls toward the reasoning-loop threshold", () => {
    const records = [
      makeAuditRecord({ id: "r5", toolId: "agent.getState", argsSummary: "{}" }),
      makeAuditRecord({ id: "r4", toolId: "files.list", argsSummary: '{"path":"/foo"}' }),
      makeAuditRecord({ id: "r3", toolId: "agent.getState", argsSummary: "{}" }),
      makeAuditRecord({ id: "r2", toolId: "terminal.run", argsSummary: '{"cmd":"ls"}' }),
      makeAuditRecord({ id: "r1", toolId: "agent.getState", argsSummary: "{}" }),
    ];
    expect(
      classifyTurnOutcome({
        transition: makeTransition(),
        recentOutput: "Let me check once more.".padEnd(120, " "),
        recentAuditRecords: records,
        sessionId: "session-1",
      })
    ).toBe("reasoning-loop");
  });

  it("returns tool-error over reasoning-loop when the most recent record is an error", () => {
    const records = [
      makeAuditRecord({
        id: "r4",
        toolId: "agent.getState",
        argsSummary: "{}",
        result: "error",
        errorCode: "DISPATCH_THREW",
      }),
      makeAuditRecord({ id: "r3", toolId: "agent.getState", argsSummary: "{}" }),
      makeAuditRecord({ id: "r2", toolId: "agent.getState", argsSummary: "{}" }),
      makeAuditRecord({ id: "r1", toolId: "agent.getState", argsSummary: "{}" }),
    ];
    expect(
      classifyTurnOutcome({
        transition: makeTransition(),
        recentOutput: "Let me try again.".padEnd(120, " "),
        recentAuditRecords: records,
        sessionId: "session-1",
      })
    ).toBe("tool-error");
  });

  it("ignores audit records from other sessions", () => {
    const audit = makeAuditRecord({
      helpSessionId: "session-other",
      result: "error",
    });
    expect(
      classifyTurnOutcome({
        transition: makeTransition(),
        recentOutput: "Here is the answer you asked for: the file was updated and tests pass.",
        recentAuditRecords: [audit],
        sessionId: "session-1",
      })
    ).toBe("answered");
  });

  it("ignores audit records from prior turns (turnStartTimestamp filter)", () => {
    // Newest-first ordering as produced by AuditService.getRecords().
    const records = [
      makeAuditRecord({ id: "r-current", timestamp: 1100, result: "success" }),
      makeAuditRecord({ id: "r-prior", timestamp: 500, result: "error" }),
    ];
    expect(
      classifyTurnOutcome({
        transition: makeTransition({ timestamp: 1200 }),
        recentOutput:
          "Done — the requested change has been applied to the file. Anything else to fix?",
        recentAuditRecords: records,
        sessionId: "session-1",
        turnStartTimestamp: 1000,
      })
    ).toBe("answered");
  });

  it("uses the most recent (newest-first) record, not the oldest", () => {
    // If the classifier picked the array-tail (oldest) record, this would
    // return "tool-error" — guarding against the array-ordering regression.
    const records = [
      makeAuditRecord({ id: "r-newest", timestamp: 1100, result: "success" }),
      makeAuditRecord({ id: "r-oldest", timestamp: 1050, result: "error" }),
    ];
    expect(
      classifyTurnOutcome({
        transition: makeTransition({ timestamp: 1200 }),
        recentOutput:
          "Done — the requested change has been applied to the file. Anything else to fix?",
        recentAuditRecords: records,
        sessionId: "session-1",
        turnStartTimestamp: 1000,
      })
    ).toBe("answered");
  });

  it("classifies refused output", () => {
    const out = "Sorry, I cannot do that — it goes against my guidelines.".padEnd(200, " ");
    expect(
      classifyTurnOutcome({
        transition: makeTransition(),
        recentOutput: out,
        recentAuditRecords: [],
        sessionId: "session-1",
      })
    ).toBe("refused");
  });

  it("classifies hedged output", () => {
    const out = "I'm not sure about that — I don't have enough information.".padEnd(200, " ");
    expect(
      classifyTurnOutcome({
        transition: makeTransition(),
        recentOutput: out,
        recentAuditRecords: [],
        sessionId: "session-1",
      })
    ).toBe("hedged");
  });

  it("classifies docs-empty output", () => {
    const out = "No matching documentation found in the local index.".padEnd(200, " ");
    expect(
      classifyTurnOutcome({
        transition: makeTransition(),
        recentOutput: out,
        recentAuditRecords: [],
        sessionId: "session-1",
      })
    ).toBe("docs-empty");
  });

  it("classifies hibernate-resume-stale from leading buffer", () => {
    const head = "No conversations to resume in this directory.".padEnd(80, " ");
    const tail = "Here is some later output that should not match.".padEnd(200, " ");
    expect(
      classifyTurnOutcome({
        transition: makeTransition(),
        recentOutput: head + "\n" + tail,
        recentAuditRecords: [],
        sessionId: "session-1",
      })
    ).toBe("hibernate-resume-stale");
  });

  it("falls through to answered with non-trivial output and no failure signal", () => {
    expect(
      classifyTurnOutcome({
        transition: makeTransition(),
        recentOutput:
          "Done — the file has been updated as requested. Let me know if anything else needs to change.".padEnd(
            200,
            " "
          ),
        recentAuditRecords: [],
        sessionId: "session-1",
      })
    ).toBe("answered");
  });

  it("falls through to unknown when output is too short", () => {
    expect(
      classifyTurnOutcome({
        transition: makeTransition(),
        recentOutput: "ok",
        recentAuditRecords: [],
        sessionId: "session-1",
      })
    ).toBe("unknown");
  });

  it("strips ANSI escapes before matching", () => {
    // ANSI-wrapped refusal long enough to clear MIN_CLASSIFY_LENGTH after strip.
    const ansiRefusal = "\x1b[31mI cannot do that — it goes against my guidelines for now.\x1b[0m";
    expect(
      classifyTurnOutcome({
        transition: makeTransition(),
        recentOutput: ansiRefusal,
        recentAuditRecords: [],
        sessionId: "session-1",
      })
    ).toBe("refused");
  });
});

describe("TurnOutcomeService.handleTransition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records one outcome on active → passive transition", () => {
    const f = makeFixture();
    f.service.appendOutput(
      "term-1",
      "Done with the requested change. The file has been updated and saved successfully."
    );
    f.service.handleTransition(
      makeTransition({ previousState: "working", state: "idle", trigger: "output" })
    );
    f.flushPersist();
    const records = f.service.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe("answered");
    expect(records[0]?.terminalId).toBe("term-1");
    expect(records[0]?.sessionId).toBe("session-1");
  });

  it("ignores passive → passive transitions that aren't watchdog timeouts", () => {
    const f = makeFixture();
    f.service.handleTransition(
      makeTransition({ previousState: "idle", state: "waiting", trigger: "activity" })
    );
    expect(f.service.getRecords()).toHaveLength(0);
  });

  it("records agent-stuck on waiting → idle with timeout trigger", () => {
    const f = makeFixture();
    f.service.handleTransition(
      makeTransition({ previousState: "waiting", state: "idle", trigger: "timeout" })
    );
    expect(f.service.getRecords()[0]?.outcome).toBe("agent-stuck");
  });

  it("does not double-record agent-stuck without an intervening active transition", () => {
    const f = makeFixture();
    f.service.handleTransition(
      makeTransition({ previousState: "waiting", state: "idle", trigger: "timeout" })
    );
    f.service.handleTransition(
      makeTransition({ previousState: "waiting", state: "idle", trigger: "timeout" })
    );
    expect(f.service.getRecords()).toHaveLength(1);
  });

  it("re-records agent-stuck after a new active turn", () => {
    const f = makeFixture();
    f.service.handleTransition(
      makeTransition({ previousState: "waiting", state: "idle", trigger: "timeout" })
    );
    f.service.handleTransition(
      makeTransition({ previousState: "idle", state: "working", trigger: "output" })
    );
    f.service.handleTransition(
      makeTransition({ previousState: "waiting", state: "idle", trigger: "timeout" })
    );
    expect(f.service.getRecords().filter((r) => r.outcome === "agent-stuck")).toHaveLength(2);
  });

  it("skips when the terminal has no help session binding", () => {
    const f = makeFixture({ sessionId: null });
    f.service.appendOutput(
      "term-1",
      "Done with the requested change. The file has been updated and saved successfully."
    );
    f.service.handleTransition(
      makeTransition({ previousState: "working", state: "idle", trigger: "output" })
    );
    expect(f.service.getRecords()).toHaveLength(0);
  });

  it("skips entirely when auditEnabled is false", () => {
    const f = makeFixture({ initialConfig: { auditEnabled: false, auditMaxRecords: 500 } });
    f.service.handleTransition(
      makeTransition({ previousState: "working", state: "idle", trigger: "output" })
    );
    expect(f.service.getRecords()).toHaveLength(0);
  });

  it("clears the recent-output ring after recording so the next turn classifies fresh", () => {
    const f = makeFixture();
    f.service.appendOutput("term-1", "I cannot do that — it goes against my guidelines for now.");
    f.service.handleTransition(
      makeTransition({ previousState: "working", state: "idle", trigger: "output" })
    );
    expect(f.service.getRecentOutput("term-1")).toBe("");
    expect(f.service.getRecords()[0]?.outcome).toBe("refused");
  });

  it("trims the records ring to the configured cap (clamped to MIN_RECORDS)", () => {
    // auditMaxRecords below MIN gets clamped to 50
    const f = makeFixture({
      initialConfig: { auditEnabled: true, auditMaxRecords: 5 },
    });
    for (let i = 0; i < 60; i++) {
      f.service.handleTransition(
        makeTransition({
          terminalId: `term-${i}`,
          previousState: "working",
          state: "idle",
          trigger: "output",
          timestamp: Date.now() + i,
        })
      );
    }
    // 50 is the floor (MCP_AUDIT_MIN_RECORDS), so 60 records get trimmed to 50.
    expect(f.service.getRecords().length).toBeLessThanOrEqual(50);
  });

  it("uses the recorded turn-start timestamp to scope audit lookups", () => {
    // Audit record from BEFORE the new turn started — must be ignored.
    const auditRecords = [
      makeAuditRecord({
        id: "r-prior-error",
        timestamp: 500,
        sessionId: "session-1",
        result: "error",
      }),
    ];
    const f = makeFixture({ auditRecords });
    // Enter active state at t=1000 — this is the turn-start lower bound.
    f.service.handleTransition(
      makeTransition({
        previousState: "idle",
        state: "working",
        trigger: "input",
        timestamp: 1000,
      })
    );
    f.service.appendOutput("term-1", "Done — the file was updated and the tests pass cleanly.");
    // Exit active state at t=1100 — classifier should ignore the prior
    // error (timestamp 500 < turnStart 1000) and report `answered`.
    f.service.handleTransition(
      makeTransition({
        previousState: "working",
        state: "idle",
        trigger: "output",
        timestamp: 1100,
      })
    );
    expect(f.service.getRecords()[0]?.outcome).toBe("answered");
  });

  it("flushNow persists pending records synchronously to the log store", () => {
    const f = makeFixture();
    f.service.appendOutput("term-1", "Done — the file was updated and the tests pass cleanly.");
    f.service.handleTransition(
      makeTransition({ previousState: "working", state: "idle", trigger: "output" })
    );
    expect(f.logStore.write).not.toHaveBeenCalled();
    f.flushPersist();
    expect(f.logStore.write).toHaveBeenCalledTimes(1);
    expect(f.getPersistedLog()).toHaveLength(1);
    // The ring never travels through the config patch.
    expect(f.saveConfig).not.toHaveBeenCalled();
  });

  it("hydrates persisted records on first read", () => {
    const persisted: AssistantTurnRecord[] = [
      {
        id: "rec-1",
        timestamp: 1,
        terminalId: "term-x",
        sessionId: "sess-x",
        outcome: "answered",
      },
    ];
    const f = makeFixture({ initialLog: persisted });
    expect(f.service.getRecords()).toHaveLength(1);
    expect(f.service.getRecords()[0]?.id).toBe("rec-1");
  });
});

describe("TurnOutcomeService.setNotifyTurnOutcomeAlert", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the alert callback for agent-stuck with the help-session id", () => {
    const f = makeFixture();
    const alert = vi.fn();
    f.service.setNotifyTurnOutcomeAlert(alert);
    f.service.handleTransition(
      makeTransition({ previousState: "waiting", state: "idle", trigger: "timeout" })
    );
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith("agent-stuck", "session-1", undefined);
  });

  it("fires the alert callback for reasoning-loop with the turn id", () => {
    const now = Date.now();
    const auditRecords = [
      makeAuditRecord({ id: "r1", timestamp: now, toolId: "agent.getState", argsSummary: "{}" }),
      makeAuditRecord({ id: "r2", timestamp: now, toolId: "agent.getState", argsSummary: "{}" }),
      makeAuditRecord({ id: "r3", timestamp: now, toolId: "agent.getState", argsSummary: "{}" }),
    ];
    const f = makeFixture({ auditRecords });
    const alert = vi.fn();
    f.service.setNotifyTurnOutcomeAlert(alert);
    // Enter active to mint a turn id, then close the turn so the loop classifies.
    f.service.handleTransition(
      makeTransition({ previousState: "idle", state: "working", trigger: "input", timestamp: now })
    );
    f.service.appendOutput("term-1", "Looping through agent.getState repeatedly without progress.");
    f.service.handleTransition(
      makeTransition({ previousState: "working", state: "idle", trigger: "output", timestamp: now })
    );
    expect(alert).toHaveBeenCalledTimes(1);
    const [outcome, helpSessionId, turnId] = alert.mock.calls[0]!;
    expect(outcome).toBe("reasoning-loop");
    expect(helpSessionId).toBe("session-1");
    expect(typeof turnId).toBe("string");
  });

  it("does not fire the alert callback for non-alertable outcomes", () => {
    const f = makeFixture();
    const alert = vi.fn();
    f.service.setNotifyTurnOutcomeAlert(alert);
    f.service.appendOutput("term-1", "Done — the file was updated and the tests pass cleanly.");
    f.service.handleTransition(
      makeTransition({ previousState: "working", state: "idle", trigger: "output" })
    );
    expect(f.service.getRecords()[0]?.outcome).toBe("answered");
    expect(alert).not.toHaveBeenCalled();
  });

  it("respects the stuck debounce — no second alert without an intervening active turn", () => {
    const f = makeFixture();
    const alert = vi.fn();
    f.service.setNotifyTurnOutcomeAlert(alert);
    f.service.handleTransition(
      makeTransition({ previousState: "waiting", state: "idle", trigger: "timeout" })
    );
    f.service.handleTransition(
      makeTransition({ previousState: "waiting", state: "idle", trigger: "timeout" })
    );
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("never blocks record persistence when the alert callback throws", () => {
    const f = makeFixture();
    f.service.setNotifyTurnOutcomeAlert(() => {
      throw new Error("renderer gone");
    });
    expect(() =>
      f.service.handleTransition(
        makeTransition({ previousState: "waiting", state: "idle", trigger: "timeout" })
      )
    ).not.toThrow();
    expect(f.service.getRecords()[0]?.outcome).toBe("agent-stuck");
  });
});

describe("TurnOutcomeService.recordDirectOutcome", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("appends a mcp-not-ready record without an FSM transition", () => {
    const f = makeFixture();
    f.service.recordDirectOutcome({
      outcome: "mcp-not-ready",
      sessionId: "sess-failed",
      detail: "Probe failed",
    });
    const records = f.service.getRecords();
    expect(records[0]?.outcome).toBe("mcp-not-ready");
    expect(records[0]?.sessionId).toBe("sess-failed");
    expect(records[0]?.detail).toBe("Probe failed");
    expect(records[0]?.terminalId).toBeNull();
  });

  it("respects auditEnabled=false for direct records", () => {
    const f = makeFixture({
      initialConfig: { auditEnabled: false, auditMaxRecords: 500 },
    });
    f.service.recordDirectOutcome({ outcome: "mcp-not-ready" });
    expect(f.service.getRecords()).toHaveLength(0);
  });
});

describe("TurnOutcomeService.appendOutput / dropTerminal", () => {
  it("does not buffer for terminals without a help-session binding", () => {
    const f = makeFixture({ sessionId: null });
    f.service.appendOutput("term-1", "abc");
    expect(f.service.getRecentOutput("term-1")).toBe("");
  });

  it("rolls the buffer at the ring size", () => {
    const f = makeFixture();
    f.service.appendOutput("term-1", "x".repeat(8000));
    expect(f.service.getRecentOutput("term-1").length).toBe(4000);
  });

  it("clears per-terminal buffers on dropTerminal", () => {
    const f = makeFixture();
    f.service.appendOutput("term-1", "abc");
    f.service.dropTerminal("term-1");
    expect(f.service.getRecentOutput("term-1")).toBe("");
  });
});

describe("TurnOutcomeService.clear", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("empties records but preserves live classifier state", () => {
    const f = makeFixture();
    f.service.appendOutput("term-1", "x".repeat(80));
    f.service.handleTransition(
      makeTransition({ previousState: "waiting", state: "idle", trigger: "timeout" })
    );
    expect(f.service.getRecords()).toHaveLength(1);
    f.service.clear();
    expect(f.service.getRecords()).toHaveLength(0);
    // Stuck guard preserved — duplicate timeout does not re-record
    f.service.handleTransition(
      makeTransition({ previousState: "waiting", state: "idle", trigger: "timeout" })
    );
    expect(f.service.getRecords()).toHaveLength(0);
  });
});

describe("TurnOutcomeService turnId lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mints a turnId on active entry and stamps the outcome record", () => {
    const f = makeFixture();
    f.service.appendOutput("term-1", "Done — the file was updated and tests pass cleanly.");
    f.service.handleTransition(
      makeTransition({ previousState: "idle", state: "working", trigger: "input" })
    );
    f.service.handleTransition(
      makeTransition({ previousState: "working", state: "idle", trigger: "output" })
    );
    f.flushPersist();
    const records = f.service.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.turnId).toBeDefined();
    expect(records[0]?.turnId?.length).toBeGreaterThan(0);
  });

  it("getCurrentTurnIdForSession returns the active turnId", () => {
    const f = makeFixture();
    f.service.handleTransition(
      makeTransition({ previousState: "idle", state: "working", trigger: "input" })
    );
    const turnId = f.service.getCurrentTurnIdForSession("session-1");
    expect(turnId).toBeDefined();
    expect(typeof turnId).toBe("string");
  });

  it("getCurrentTurnIdForSession returns null for unknown session", () => {
    const f = makeFixture();
    f.service.handleTransition(
      makeTransition({ previousState: "idle", state: "working", trigger: "input" })
    );
    expect(f.service.getCurrentTurnIdForSession("nonexistent")).toBeNull();
  });

  it("getCurrentTurnIdForSession returns null when session not bound at mint time", () => {
    const f = makeFixture({ sessionId: null });
    f.service.handleTransition(
      makeTransition({ previousState: "idle", state: "working", trigger: "input" })
    );
    expect(f.service.getCurrentTurnIdForSession("session-1")).toBeNull();
  });

  it("rapid consecutive active transitions produce distinct turnIds", () => {
    const f = makeFixture();
    f.service.appendOutput("term-1", "Done — the file was updated and the tests pass cleanly.");
    // First turn
    f.service.handleTransition(
      makeTransition({ previousState: "idle", state: "working", trigger: "input" })
    );
    f.service.handleTransition(
      makeTransition({ previousState: "working", state: "idle", trigger: "output" })
    );
    // Second turn
    f.service.handleTransition(
      makeTransition({ previousState: "idle", state: "working", trigger: "input" })
    );
    f.service.handleTransition(
      makeTransition({ previousState: "working", state: "idle", trigger: "output" })
    );
    const records = f.service.getRecords();
    expect(records).toHaveLength(2);
    expect(records[0]?.turnId).toBeDefined();
    expect(records[1]?.turnId).toBeDefined();
    expect(records[0]?.turnId).not.toBe(records[1]?.turnId);
  });

  it("dropTerminal clears turnId entries", () => {
    const f = makeFixture();
    f.service.handleTransition(
      makeTransition({ previousState: "idle", state: "working", trigger: "input" })
    );
    expect(f.service.getCurrentTurnIdForSession("session-1")).toBeDefined();
    f.service.dropTerminal("term-1");
    expect(f.service.getCurrentTurnIdForSession("session-1")).toBeNull();
  });

  it("clear preserves active turnId so in-progress turns survive log wipe", () => {
    const f = makeFixture();
    f.service.handleTransition(
      makeTransition({ previousState: "idle", state: "working", trigger: "input" })
    );
    const beforeClear = f.service.getCurrentTurnIdForSession("session-1");
    expect(beforeClear).toBeDefined();
    f.service.clear();
    // Live classifier state is preserved across clear() — the active turn
    // continues to be stamped so dispatches mid-turn stay correlated.
    expect(f.service.getCurrentTurnIdForSession("session-1")).toBe(beforeClear);
  });

  it("turnId is absent on recordDirectOutcome (pre-turn failures)", () => {
    const f = makeFixture();
    f.service.recordDirectOutcome({
      outcome: "mcp-not-ready",
      sessionId: "sess-failed",
      detail: "Probe failed",
    });
    const records = f.service.getRecords();
    expect(records[0]?.outcome).toBe("mcp-not-ready");
    expect(records[0]?.turnId).toBeUndefined();
  });

  it("clears turnIdBySession after turn end so post-turn dispatches are not stamped", () => {
    const f = makeFixture();
    f.service.appendOutput("term-1", "Done — the file was updated and the tests pass cleanly.");
    // Turn start
    f.service.handleTransition(
      makeTransition({ previousState: "idle", state: "working", trigger: "input" })
    );
    expect(f.service.getCurrentTurnIdForSession("session-1")).toBeDefined();
    // Turn end
    f.service.handleTransition(
      makeTransition({ previousState: "working", state: "idle", trigger: "output" })
    );
    // After turn ends, session should have no active turnId
    expect(f.service.getCurrentTurnIdForSession("session-1")).toBeNull();
  });
});

describe("TurnOutcomeService.pruneByAge (#10776)", () => {
  const DAY = 86_400_000;

  function seedRecord(timestamp: unknown): Record<string, unknown> {
    return {
      id: `r-${String(timestamp)}`,
      timestamp,
      terminalId: "term-1",
      sessionId: "session-1",
      outcome: "answered",
    };
  }

  it("drops records older than the retention window and keeps newer ones", () => {
    const now = Date.now();
    const f = makeFixture({
      initialLog: [
        seedRecord(now - 40 * DAY),
        seedRecord(now - 20 * DAY),
        seedRecord(now - 1 * DAY),
      ],
    });
    f.service.pruneByAge(30);
    const ids = f.service.getRecords().map((r) => r.id);
    // getRecords is newest-first; the 40-day-old record is gone.
    expect(ids).toEqual([`r-${now - 1 * DAY}`, `r-${now - 20 * DAY}`]);
    expect(f.logStore.write).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when retentionDays <= 0 (Off keeps everything)", () => {
    const now = Date.now();
    const f = makeFixture({
      initialLog: [seedRecord(now - 365 * DAY), seedRecord(now - 1 * DAY)],
    });
    f.service.pruneByAge(0);
    expect(f.service.getRecords()).toHaveLength(2);
    expect(f.logStore.write).not.toHaveBeenCalled();
  });

  it("does not flush when nothing falls outside the window", () => {
    const now = Date.now();
    const f = makeFixture({
      initialLog: [seedRecord(now - 2 * DAY), seedRecord(now - 1 * DAY)],
    });
    f.service.pruneByAge(30);
    expect(f.service.getRecords()).toHaveLength(2);
    expect(f.logStore.write).not.toHaveBeenCalled();
  });

  it("retains records with a non-finite timestamp rather than dropping them", () => {
    const now = Date.now();
    const f = makeFixture({
      initialLog: [
        seedRecord(undefined),
        seedRecord(-Infinity),
        seedRecord(now - 90 * DAY),
        seedRecord(now - 1 * DAY),
      ],
    });
    f.service.pruneByAge(30);
    const ids = f.service.getRecords().map((r) => r.id);
    expect(ids).toContain("r-undefined");
    expect(ids).toContain("r--Infinity");
    expect(ids).toContain(`r-${now - 1 * DAY}`);
    expect(ids).not.toContain(`r-${now - 90 * DAY}`);
  });
});
