import { describe, expect, it, vi } from "vitest";
import { AuditService, type AuditOutcome, type McpAuditLogStore } from "../auditLog.js";
import {
  type McpAuditResult,
  isAuditRecord,
  isGrantRecord,
} from "../../../../shared/types/ipc/mcpServer.js";

function makeFixture(initialConfig: Record<string, unknown> = {}, initialLog: unknown[] = []) {
  const config: Record<string, unknown> = {
    auditEnabled: true,
    auditMaxRecords: 500,
    ...initialConfig,
  };
  const saveConfig = vi.fn((patch: Record<string, unknown>) => {
    Object.assign(config, patch);
  });
  let persistedLog: unknown[] = [...initialLog];
  const logStore = {
    read: vi.fn(() => persistedLog),
    write: vi.fn((records: unknown[]) => {
      persistedLog = records;
    }),
  };
  const service = new AuditService(saveConfig, () => config, logStore as McpAuditLogStore);
  return { service, saveConfig, config, logStore, getPersistedLog: () => persistedLog };
}

const successOutcome: AuditOutcome = {
  kind: "result",
  value: { ok: true, result: null },
};

const unauthorizedOutcome: AuditOutcome = { kind: "unauthorized" };

describe("AuditService.appendRecord", () => {
  it("stores the caller-provided argsSummary verbatim", () => {
    // Redaction lives in the call-site `summarizeMcpArgs` pipeline; the
    // service trusts what it's handed.
    const { service } = makeFixture();
    service.appendRecord({
      toolId: "files.search",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 10,
      outcome: successOutcome,
      argsSummary: '{"q":"<redacted>"}',
    });
    const [record] = service.getRecords();
    expect(record!.argsSummary).toBe('{"q":"<redacted>"}');
  });

  it("populates tierHint on unauthorized records using the static allowlist", () => {
    const { service } = makeFixture();
    // `agent.terminal` is in the action tier; from a workbench session
    // attempting to invoke it, the minimum permitting tier is `action`.
    service.appendRecord({
      toolId: "agent.terminal",
      sessionId: "sess-1",
      tier: "workbench",
      args: {},
      durationMs: 0,
      outcome: unauthorizedOutcome,
      argsSummary: "{}",
    });
    const [actionTierRecord] = service.getRecords();
    expect(actionTierRecord!.result).toBe("unauthorized");
    expect(actionTierRecord!.tierHint).toBe("action");

    // `git.commit` is gated by the system tier; even an action-tier
    // session needs to be elevated to system.
    service.appendRecord({
      toolId: "git.commit",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 0,
      outcome: unauthorizedOutcome,
      argsSummary: "{}",
    });
    const records = service.getRecords();
    expect(records[0]!.tierHint).toBe("system");
  });

  it("sets tierHint to null for unknown tools on unauthorized records", () => {
    const { service } = makeFixture();
    service.appendRecord({
      toolId: "definitely.notATool",
      sessionId: "sess-1",
      tier: "workbench",
      args: {},
      durationMs: 0,
      outcome: unauthorizedOutcome,
      argsSummary: "{}",
    });
    const [record] = service.getRecords();
    expect(record!.tierHint).toBeNull();
  });

  it("does not set tierHint on success outcomes", () => {
    const { service } = makeFixture();
    service.appendRecord({
      toolId: "agent.launch",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 5,
      outcome: successOutcome,
      argsSummary: "{}",
    });
    const [record] = service.getRecords();
    expect(record!.tierHint).toBeUndefined();
  });

  it("respects the auditEnabled kill switch", () => {
    const { service } = makeFixture({ auditEnabled: false });
    service.appendRecord({
      toolId: "agent.launch",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 5,
      outcome: successOutcome,
      argsSummary: "{}",
    });
    expect(service.getRecords()).toHaveLength(0);
  });
});

describe("AuditService.appendRecord — turnId, severity, schemaVersion", () => {
  it("persists turnId when provided", () => {
    const { service } = makeFixture();
    service.appendRecord({
      toolId: "agent.terminal",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 10,
      outcome: successOutcome,
      argsSummary: "{}",
      turnId: "turn-uuid-123",
    });
    const [record] = service.getRecords();
    expect(record!.turnId).toBe("turn-uuid-123");
  });

  it("turnId is absent when not provided", () => {
    const { service } = makeFixture();
    service.appendRecord({
      toolId: "agent.terminal",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 10,
      outcome: successOutcome,
      argsSummary: "{}",
    });
    const [record] = service.getRecords();
    expect(record!.turnId).toBeUndefined();
  });

  it("stamps schemaVersion on every record", () => {
    const { service } = makeFixture();
    service.appendRecord({
      toolId: "agent.launch",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 5,
      outcome: successOutcome,
      argsSummary: "{}",
    });
    const [record] = service.getRecords();
    expect(record!.schemaVersion).toBe(1);
  });

  it.each([
    ["success", undefined, "info"],
    ["dedup", undefined, "info"],
    ["confirmation-pending", "CONFIRMATION_REQUIRED", "info"],
    ["unauthorized", "TIER_NOT_PERMITTED", "error"],
    ["error", "EXECUTION_ERROR", "critical"],
    ["error", "USER_REJECTED", "warning"],
    ["error", "CONFIRMATION_TIMEOUT", "warning"],
    ["error", "DISPATCH_THREW", "critical"],
    ["error", "ELICITATION_FAILED", "error"],
  ])("result=%s errorCode=%s → severity=%s", (result, errorCode, expectedSeverity) => {
    const { service } = makeFixture();
    let outcome: AuditOutcome;
    if (result === "unauthorized") {
      outcome = { kind: "unauthorized" };
    } else if (result === "dedup") {
      outcome = { kind: "dedup" };
    } else if (errorCode === "DISPATCH_THREW") {
      outcome = { kind: "throw", error: new Error("boom") };
    } else if (errorCode === undefined) {
      outcome = { kind: "result", value: { ok: true, result: null } };
    } else {
      outcome = {
        kind: "result",
        value: {
          ok: false,
          result: null,
          error: { code: errorCode, message: "" },
        },
      } as AuditOutcome;
    }

    service.appendRecord({
      toolId: "agent.launch",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 5,
      outcome,
      argsSummary: "{}",
    });
    const [record] = service.getRecords();
    // The result may differ from the input when classifyDispatchResult
    // transforms it (e.g. CONFIRMATION_REQUIRED → confirmation-pending).
    // We verify severity matches the computed value.
    expect(record!.severity).toBe(expectedSeverity);
  });
});

describe("AuditService.appendRecord — resultMeta (#10014)", () => {
  it("persists retryAfter on rate_limited records and round-trips through getRecords", () => {
    const { service } = makeFixture();
    service.appendRecord({
      toolId: "agent.terminal",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 0,
      outcome: { kind: "rate_limited", retryAfter: 5 },
      argsSummary: "{}",
      resultMeta: { retryAfter: 5 },
    });
    const [record] = service.getRecords();
    expect(record!.result).toBe("rate_limited");
    expect(record!.resultMeta).toEqual({ retryAfter: 5 });
  });

  it("leaves resultMeta undefined on records that do not provide it", () => {
    const { service } = makeFixture();
    service.appendRecord({
      toolId: "agent.launch",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 5,
      outcome: successOutcome,
      argsSummary: "{}",
    });
    const [record] = service.getRecords();
    expect("resultMeta" in record!).toBe(false);
  });

  it("does not backfill resultMeta on gate outcomes that omit it (unauthorized / dedup / collision)", () => {
    const { service } = makeFixture();
    service.appendRecord({
      toolId: "agent.terminal",
      sessionId: "sess-1",
      tier: "workbench",
      args: {},
      durationMs: 0,
      outcome: { kind: "unauthorized" },
      argsSummary: "{}",
    });
    service.appendRecord({
      toolId: "agent.terminal",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 0,
      outcome: { kind: "dedup" },
      argsSummary: "{}",
    });
    service.appendRecord({
      toolId: "agent.terminal",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 0,
      outcome: { kind: "collision" },
      argsSummary: "{}",
    });
    const records = service.getRecords();
    expect(records).toHaveLength(3);
    for (const r of records) {
      expect("resultMeta" in r!).toBe(false);
    }
  });
});

describe("AuditService.appendRecord — startedAt (#12122)", () => {
  it("persists the caller's startedAt verbatim and reads it back unchanged", () => {
    const { service } = makeFixture();
    // A real epoch reading, not a small sentinel: the service must not clamp,
    // round, or re-derive it the way it normalises `durationMs`.
    const startedAt = 1_767_225_600_123;
    service.appendRecord({
      toolId: "worktree.list",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 40,
      startedAt,
      outcome: successOutcome,
      argsSummary: "{}",
    });
    const [record] = service.getRecords();
    expect(record!.startedAt).toBe(startedAt);
  });

  it("carries start information that timestamp and durationMs cannot express", () => {
    // The point of the field (#12122): two calls can settle into identical
    // `timestamp`/`durationMs` shapes and still have begun at different
    // moments. Recording distinct starts under an identical duration is what
    // proves the record now carries ordering information it did not before —
    // and it fails outright if the field stops being persisted.
    const { service } = makeFixture();
    const first = 1_767_225_600_000;
    const second = 1_767_225_604_000;
    for (const startedAt of [first, second]) {
      service.appendRecord({
        toolId: "worktree.list",
        sessionId: "sess-1",
        tier: "action",
        args: {},
        durationMs: 250,
        startedAt,
        outcome: successOutcome,
        argsSummary: "{}",
      });
    }
    const records = service.getRecords();
    expect(records.map((r) => r.startedAt).sort((a, b) => a! - b!)).toEqual([first, second]);
    // Same duration on both, so `durationMs` alone orders nothing.
    expect(new Set(records.map((r) => r.durationMs)).size).toBe(1);
  });

  it("keeps startedAt on gate outcomes, which are real dispatch attempts", () => {
    // Unlike `resultMeta`, absence is NOT the right behaviour for gates: an
    // unauthorized / dedup / collision row is a call the backend actually
    // issued, so it must count when measuring concurrency.
    const { service } = makeFixture();
    const outcomes: AuditOutcome[] = [
      { kind: "unauthorized" },
      { kind: "dedup" },
      { kind: "collision" },
    ];
    outcomes.forEach((outcome, i) => {
      service.appendRecord({
        toolId: "agent.terminal",
        sessionId: "sess-1",
        tier: "action",
        args: {},
        durationMs: 0,
        startedAt: 1_767_225_600_000 + i,
        outcome,
        argsSummary: "{}",
      });
    });
    const records = service.getRecords();
    expect(records).toHaveLength(3);
    // Newest-first, so the starts run back down the sequence.
    expect(records.map((r) => r.startedAt).sort((a, b) => a! - b!)).toEqual([
      1_767_225_600_000, 1_767_225_600_001, 1_767_225_600_002,
    ]);
  });

  it("omits startedAt as a key entirely when the caller supplies none", () => {
    const { service } = makeFixture();
    service.appendRecord({
      toolId: "agent.launch",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 5,
      outcome: successOutcome,
      argsSummary: "{}",
    });
    const [record] = service.getRecords();
    // Absent as a key, not present-and-undefined — persisted JSON must not
    // carry a stray `startedAt: undefined`.
    expect("startedAt" in record!).toBe(false);
  });
});

describe("AuditService.recordAuth401 pre-auth records", () => {
  it("emits a pre-auth record alongside the counter increment", () => {
    const { service } = makeFixture();
    service.recordAuth401();
    const stats = service.getAuditStats();
    expect(stats.auth401Count).toBe(1);

    const records = service.getRecords();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record!.toolId).toBe("mcp.pre-auth");
    expect(record!.sessionId).toBe("");
    expect(record!.result).toBe("unauthorized");
    expect(record!.errorCode).toBe("PRE_AUTH_FAILED");
    expect(record!.severity).toBe("error");
    expect(record!.schemaVersion).toBe(1);
    expect(record!.durationMs).toBe(0);
    expect(record!.argsSummary).toBe("pre-auth request rejected");
    expect(record!.repeatCount).toBeUndefined();
    // A 401 is rejected before any CallTool handler exists, so there is no
    // start to record — the key must stay absent rather than be invented
    // from the write time (#12122).
    expect("startedAt" in record!).toBe(false);
  });

  it("coalesces bursts within 1s by incrementing repeatCount", () => {
    const { service } = makeFixture();
    // Fire 3 401s in rapid succession.
    service.recordAuth401();
    service.recordAuth401();
    service.recordAuth401();

    const records = service.getRecords();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record!.errorCode).toBe("PRE_AUTH_FAILED");
    // repeatCount starts at undefined for the first, then 2 for the first
    // coalesced hit, then 3. Final should be 3.
    expect(record!.repeatCount).toBe(3);
    // Counter still tracks each individual call.
    expect(service.getAuditStats().auth401Count).toBe(3);
  });

  it("writes a new record after the coalesce window expires", () => {
    const { service } = makeFixture();
    const now = Date.now();

    // First record at t=0.
    service.recordAuth401();

    // Coalesce timer: fast-forward mock. Since we can't safely mock Date.now
    // across the tight coalesce logic without controlling the clock, verify
    // that two calls separated by a real wait produce two records.
    // We'll test the window contract via the coalesced test above + the
    // separate-call test below; for multi-record proof, force the coalesce
    // state to expire.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).lastPreAuthRecordAt = now - 2000;

    service.recordAuth401();
    const records = service.getRecords();
    // The first record (id from t=0) and the new record (id from t=2000)
    // should both exist because the coalesce window expired.
    expect(records.length).toBeGreaterThanOrEqual(2);
    const preAuthRecords = records.filter((r) => r.errorCode === "PRE_AUTH_FAILED");
    expect(preAuthRecords.length).toBe(2);
    // The newest record should NOT have repeatCount (first in its own window).
    expect(preAuthRecords[0]!.repeatCount).toBeUndefined();
  });

  it("respects auditEnabled kill switch for pre-auth records", () => {
    const { service } = makeFixture({ auditEnabled: false });
    service.recordAuth401();
    service.recordAuth401();
    expect(service.getAuditStats().auth401Count).toBe(0);
    expect(service.getRecords()).toHaveLength(0);
  });

  it("does not corrupt the ring when non-pre-auth records interleave", () => {
    const { service } = makeFixture();
    service.recordAuth401();
    service.appendRecord({
      toolId: "agent.launch",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 5,
      outcome: successOutcome,
      argsSummary: "{}",
    });
    service.recordAuth401();

    const records = service.getRecords();
    // Two pre-auth calls coalesce into one record, plus the success record = 2.
    expect(records.length).toBe(2);
    const preAuthRecord = records.find((r) => r.errorCode === "PRE_AUTH_FAILED");
    expect(preAuthRecord).toBeDefined();
    expect(preAuthRecord!.repeatCount).toBe(2);
  });
});

describe("AuditService hydrate — backward compat", () => {
  it("tolerates persisted records missing schemaVersion and severity", () => {
    const { service } = makeFixture({}, [
      {
        id: "old-1",
        timestamp: 1000,
        toolId: "agent.terminal",
        sessionId: "sess-1",
        tier: "action",
        argsSummary: "{}",
        result: "success",
        durationMs: 5,
      },
    ]);
    const records = service.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe("old-1");
  });

  it("leaves startedAt absent on rows written before the field existed (#12122)", () => {
    // hydrate() backfills only schemaVersion/severity. An old row has no start
    // to recover, and inferring one from `timestamp - durationMs` would be a
    // fabricated value a concurrency reader would silently trust.
    const { service } = makeFixture({}, [
      {
        id: "old-1",
        timestamp: 1000,
        toolId: "agent.terminal",
        sessionId: "sess-1",
        tier: "action",
        argsSummary: "{}",
        result: "success",
        durationMs: 5,
      },
    ]);
    const [record] = service.getRecords();
    expect("startedAt" in record!).toBe(false);
  });

  it("backfills schemaVersion and severity on old persisted records", () => {
    const oldRecord = {
      id: "old-1",
      timestamp: 1000,
      toolId: "agent.launch",
      sessionId: "sess-1",
      tier: "action",
      argsSummary: "{}",
      result: "error",
      errorCode: "EXECUTION_ERROR",
      durationMs: 50,
    };
    const { service } = makeFixture({}, [oldRecord]);
    // hydrate() is called lazily — trigger it via getRecords.
    const records = service.getRecords();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record!.schemaVersion).toBe(1);
    expect(record!.severity).toBe("critical");
  });

  it("preserves schemaVersion and severity on records that already have them", () => {
    const currentRecord = {
      id: "cur-1",
      timestamp: 1000,
      toolId: "agent.launch",
      sessionId: "sess-1",
      tier: "action",
      argsSummary: "{}",
      result: "success",
      durationMs: 50,
      schemaVersion: 1,
      severity: "info",
    };
    const { service } = makeFixture({}, [currentRecord]);
    const records = service.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.schemaVersion).toBe(1);
    expect(records[0]!.severity).toBe("info");
  });

  it("reclassifies a malformed persisted record with `type: 'dispatch'` as audit (#10027)", () => {
    // A forward-compat dispatch-record discriminator on a persisted row
    // would otherwise be misclassified as a grant and bypass severity
    // backfill. Lock down the hydrate-path guard to match the
    // `isGrantRecord` literal-union check.
    const malformed = {
      id: "mal-1",
      timestamp: 1000,
      toolId: "agent.launch",
      sessionId: "sess-1",
      tier: "action",
      argsSummary: "{}",
      result: "success",
      durationMs: 50,
      type: "dispatch",
    };
    const { service } = makeFixture({}, [malformed]);
    const records = service.getLogRecords();
    expect(records).toHaveLength(1);
    // The record survives hydrate (the string `type` field is preserved),
    // but isAuditRecord narrows it to the dispatch kind — getRecords() sees it.
    expect(service.getRecords()).toHaveLength(1);
    // "type" stays in the persisted shape for round-trip safety; the
    // union consumer narrows by isGrantRecord at read time.
    expect((records[0] as { type?: unknown }).type).toBe("dispatch");
  });
});

describe("AuditService persistence routing", () => {
  it("flushes the ring to the audit-logs store, never into the config patch", () => {
    const { service, saveConfig, logStore, getPersistedLog } = makeFixture();
    service.appendRecord({
      toolId: "agent.launch",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 5,
      outcome: successOutcome,
      argsSummary: "{}",
    });
    service.flushNow();
    expect(logStore.write).toHaveBeenCalledTimes(1);
    expect(getPersistedLog()).toHaveLength(1);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("setEnabled/setMaxRecords still persist config flags via saveConfig", () => {
    const { service, saveConfig, config } = makeFixture();
    service.setEnabled(false);
    expect(saveConfig).toHaveBeenCalledWith({ auditEnabled: false });
    service.setMaxRecords(250);
    expect(saveConfig).toHaveBeenCalledWith({ auditMaxRecords: 250 });
    expect("auditLog" in config).toBe(false);
  });
});

describe("AuditService.appendGrantRecord — tier records (#9151)", () => {
  it("persists tier.elevated with tier/previousTier and surfaces it in getLogRecords", () => {
    const { service } = makeFixture();
    service.appendGrantRecord({
      type: "tier.elevated",
      sessionId: "sess-1",
      toolId: "*",
      ttlMs: 1800000,
      expiresAt: 5000,
      tier: "action",
      previousTier: "workbench",
    });
    const logRecords = service.getLogRecords();
    expect(logRecords).toHaveLength(1);
    const [record] = logRecords;
    expect(record).toMatchObject({
      type: "tier.elevated",
      sessionId: "sess-1",
      toolId: "*",
      ttlMs: 1800000,
      expiresAt: 5000,
      tier: "action",
      previousTier: "workbench",
    });
    // Tier records are grant records — excluded from the dispatch-only view.
    expect(service.getRecords()).toHaveLength(0);
  });

  it("persists tier.decayed with the baseline it decayed to", () => {
    const { service } = makeFixture();
    service.appendGrantRecord({
      type: "tier.decayed",
      sessionId: "sess-2",
      toolId: "*",
      ttlMs: 0,
      previousTier: "action",
      tier: "workbench",
    });
    const [record] = service.getLogRecords();
    expect(record).toMatchObject({
      type: "tier.decayed",
      sessionId: "sess-2",
      previousTier: "action",
      tier: "workbench",
    });
    // No expiresAt on decay — the elevation window already closed.
    expect("expiresAt" in record!).toBe(false);
  });

  it("omits tier fields on grant.* records so legacy shapes are unchanged", () => {
    const { service } = makeFixture();
    service.appendGrantRecord({
      type: "grant.issued",
      sessionId: "sess-3",
      toolId: "files.search",
      ttlMs: 60000,
      expiresAt: 9000,
    });
    const [record] = service.getLogRecords();
    expect("tier" in record!).toBe(false);
    expect("previousTier" in record!).toBe(false);
  });
});

describe("AuditService.recordAuth401 / getAuditStats", () => {
  it("starts at zero", () => {
    const { service } = makeFixture();
    expect(service.getAuditStats().auth401Count).toBe(0);
  });

  it("increments on each call", () => {
    const { service } = makeFixture();
    service.recordAuth401();
    service.recordAuth401();
    service.recordAuth401();
    expect(service.getAuditStats().auth401Count).toBe(3);
  });

  it("does not increment when audit is disabled", () => {
    const { service } = makeFixture({ auditEnabled: false });
    service.recordAuth401();
    service.recordAuth401();
    expect(service.getAuditStats().auth401Count).toBe(0);
  });

  it("is not reset by clear() — counter is session-scoped, not log-scoped", () => {
    const { service } = makeFixture();
    service.recordAuth401();
    service.recordAuth401();
    service.clear();
    const stats = service.getAuditStats();
    expect(stats.auth401Count).toBe(2);
  });
});

describe("AuditService anomaly detection", () => {
  function makeRecords(
    count: number,
    factory: (i: number) => Partial<{
      toolId: string;
      sessionId: string;
      tier: string;
      durationMs: number;
      result: McpAuditResult;
    }>
  ) {
    const { service } = makeFixture();
    for (let i = 0; i < count; i++) {
      const opts = factory(i);
      service.appendRecord({
        toolId: opts.toolId ?? "test.tool",
        sessionId: opts.sessionId ?? "sess-1",
        tier: (opts.tier as "workbench" | "action" | "system" | "external") ?? "action",
        args: {},
        durationMs: opts.durationMs ?? 10,
        outcome:
          opts.result === "error"
            ? {
                kind: "result",
                value: {
                  ok: false,
                  error: { code: "EXECUTION_ERROR", message: "fail" },
                } as import("../../../../shared/types/actions.js").ActionDispatchResult,
              }
            : opts.result === "unauthorized"
              ? { kind: "unauthorized" }
              : successOutcome,
        argsSummary: "{}",
      });
    }
    return service;
  }

  it("first-run guard: returns zero signals and suppressed when under 50 records", () => {
    const service = makeRecords(49, () => ({ durationMs: 10 }));
    const stats = service.getAuditStats();
    expect(stats.anomalySuppressed).toBe(true);
    expect(stats.anomalySignals).toHaveLength(0);
  });

  it("first-run guard: not suppressed at 50 records", () => {
    const service = makeRecords(50, () => ({ durationMs: 10 }));
    const stats = service.getAuditStats();
    expect(stats.anomalySuppressed).toBe(false);
  });

  it("first-seen: seeds known combos from existing records on first call", () => {
    const service = makeRecords(50, (i) => ({
      toolId: i % 2 === 0 ? "tool.a" : "tool.b",
      tier: "action",
      durationMs: 10,
    }));
    const stats = service.getAuditStats();
    const firstSeen = stats.anomalySignals.filter((s) => s.kind === "first-seen-combination");
    expect(firstSeen).toHaveLength(0);
  });

  it("first-seen: emits signal for new combo added after first call", () => {
    const service = makeRecords(50, () => ({
      toolId: "tool.a",
      tier: "action",
      durationMs: 10,
    }));
    service.getAuditStats(); // seed known combos

    service.appendRecord({
      toolId: "tool.new",
      sessionId: "sess-1",
      tier: "external",
      args: {},
      durationMs: 5,
      outcome: successOutcome,
      argsSummary: "{}",
    });
    const stats = service.getAuditStats();
    const firstSeen = stats.anomalySignals.filter((s) => s.kind === "first-seen-combination");
    expect(firstSeen).toHaveLength(1);
    expect(firstSeen[0]!.toolId).toBe("tool.new");
    expect(firstSeen[0]!.tier).toBe("external");
  });

  it("first-seen: passive read (markSeen=false) does not consume the signal", () => {
    const service = makeRecords(50, () => ({
      toolId: "tool.a",
      tier: "action",
      durationMs: 10,
    }));
    service.getAuditStats(); // seed baseline known combos

    service.appendRecord({
      toolId: "tool.new",
      sessionId: "sess-1",
      tier: "external",
      args: {},
      durationMs: 5,
      outcome: successOutcome,
      argsSummary: "{}",
    });

    // Two passive reads in a row both still surface the new combo — a
    // background poll must not acknowledge it (#10022).
    const firstPassive = service
      .getAuditStats(false)
      .anomalySignals.filter((s) => s.kind === "first-seen-combination");
    expect(firstPassive).toHaveLength(1);
    const secondPassive = service
      .getAuditStats(false)
      .anomalySignals.filter((s) => s.kind === "first-seen-combination");
    expect(secondPassive).toHaveLength(1);

    // A user-facing read (default markSeen=true) acknowledges it...
    const acknowledged = service
      .getAuditStats()
      .anomalySignals.filter((s) => s.kind === "first-seen-combination");
    expect(acknowledged).toHaveLength(1);

    // ...so the next read (passive or not) sees it as known and stays quiet.
    const afterAck = service
      .getAuditStats(false)
      .anomalySignals.filter((s) => s.kind === "first-seen-combination");
    expect(afterAck).toHaveLength(0);
  });

  it("first-seen: knownCombinations survives clear()", () => {
    const service = makeRecords(50, () => ({
      toolId: "tool.a",
      tier: "action",
      durationMs: 10,
    }));
    service.getAuditStats(); // seed
    service.clear();

    service.appendRecord({
      toolId: "tool.a",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 5,
      outcome: successOutcome,
      argsSummary: "{}",
    });
    // Need 50 records again to pass the guard.
    for (let i = 0; i < 49; i++) {
      service.appendRecord({
        toolId: "tool.a",
        sessionId: "sess-1",
        tier: "action",
        args: {},
        durationMs: 5,
        outcome: successOutcome,
        argsSummary: "{}",
      });
    }
    const stats = service.getAuditStats();
    const firstSeen = stats.anomalySignals.filter((s) => s.kind === "first-seen-combination");
    expect(firstSeen).toHaveLength(0);
  });

  it("latency-drift: no signal when all durations are uniform", () => {
    const service = makeRecords(50, () => ({ durationMs: 10 }));
    const stats = service.getAuditStats();
    const drift = stats.anomalySignals.filter((s) => s.kind === "latency-drift");
    expect(drift).toHaveLength(0);
  });

  it("latency-drift: emits signal for outlier duration", () => {
    const { service } = makeFixture();
    // 49 records with some natural variance so MAD > 0.
    for (let i = 0; i < 49; i++) {
      service.appendRecord({
        toolId: "test.tool",
        sessionId: "sess-1",
        tier: "action",
        args: {},
        durationMs: 10 + (i % 5) * 2,
        outcome: successOutcome,
        argsSummary: "{}",
      });
    }
    // One extreme outlier.
    service.appendRecord({
      toolId: "test.tool",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 5000,
      outcome: successOutcome,
      argsSummary: "{}",
    });
    const stats = service.getAuditStats();
    const drift = stats.anomalySignals.filter((s) => s.kind === "latency-drift");
    expect(drift.length).toBeGreaterThanOrEqual(1);
    const outlier = drift.find((s) => s.recordIds.length > 0);
    expect(outlier).toBeDefined();
    expect(outlier!.zScore).toBeGreaterThanOrEqual(3);
  });

  it("latency-drift: excludes non-success records from baseline", () => {
    // 50 success records at 10ms, one error at 5000ms — error excluded.
    const { service } = makeFixture();
    for (let i = 0; i < 50; i++) {
      service.appendRecord({
        toolId: "test.tool",
        sessionId: "sess-1",
        tier: "action",
        args: {},
        durationMs: 10,
        outcome: successOutcome,
        argsSummary: "{}",
      });
    }
    service.appendRecord({
      toolId: "test.tool",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 5000,
      outcome: {
        kind: "result",
        value: {
          ok: false,
          error: { code: "EXECUTION_ERROR", message: "fail" },
        } as import("../../../../shared/types/actions.js").ActionDispatchResult,
      },
      argsSummary: "{}",
    });
    const stats = service.getAuditStats();
    const drift = stats.anomalySignals.filter((s) => s.kind === "latency-drift");
    // The 5000ms error is non-success, so it should NOT appear as latency drift.
    expect(drift).toHaveLength(0);
  });

  it("failure-cluster: fires when 3 failures in a 10-record window", () => {
    const { service } = makeFixture();
    for (let i = 0; i < 47; i++) {
      service.appendRecord({
        toolId: "test.tool",
        sessionId: "sess-1",
        tier: "action",
        args: {},
        durationMs: 10,
        outcome: successOutcome,
        argsSummary: "{}",
      });
    }
    // 3 consecutive failures.
    for (let i = 0; i < 3; i++) {
      service.appendRecord({
        toolId: "test.tool",
        sessionId: "sess-1",
        tier: "action",
        args: {},
        durationMs: 5,
        outcome: {
          kind: "result",
          value: {
            ok: false,
            error: { code: "EXECUTION_ERROR", message: "fail" },
          } as import("../../../../shared/types/actions.js").ActionDispatchResult,
        },
        argsSummary: "{}",
      });
    }
    const stats = service.getAuditStats();
    const clusters = stats.anomalySignals.filter((s) => s.kind === "failure-cluster");
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    expect(clusters[0]!.clusterSize).toBeGreaterThanOrEqual(3);
  });

  it("failure-cluster: does not fire for only 2 failures in a window", () => {
    const { service } = makeFixture();
    for (let i = 0; i < 48; i++) {
      service.appendRecord({
        toolId: "test.tool",
        sessionId: "sess-1",
        tier: "action",
        args: {},
        durationMs: 10,
        outcome: successOutcome,
        argsSummary: "{}",
      });
    }
    for (let i = 0; i < 2; i++) {
      service.appendRecord({
        toolId: "test.tool",
        sessionId: "sess-1",
        tier: "action",
        args: {},
        durationMs: 5,
        outcome: {
          kind: "result",
          value: {
            ok: false,
            error: { code: "EXECUTION_ERROR", message: "fail" },
          } as import("../../../../shared/types/actions.js").ActionDispatchResult,
        },
        argsSummary: "{}",
      });
    }
    const stats = service.getAuditStats();
    const clusters = stats.anomalySignals.filter((s) => s.kind === "failure-cluster");
    expect(clusters).toHaveLength(0);
  });

  it("failure-cluster: separates counts by toolId", () => {
    const { service } = makeFixture();
    for (let i = 0; i < 48; i++) {
      service.appendRecord({
        toolId: "tool.b",
        sessionId: "sess-1",
        tier: "action",
        args: {},
        durationMs: 10,
        outcome: successOutcome,
        argsSummary: "{}",
      });
    }
    // 2 failures for tool.a, 2 failures for tool.b — neither hits threshold.
    for (const toolId of ["tool.a", "tool.a", "tool.b", "tool.b"]) {
      service.appendRecord({
        toolId,
        sessionId: "sess-1",
        tier: "action",
        args: {},
        durationMs: 5,
        outcome: {
          kind: "result",
          value: {
            ok: false,
            error: { code: "EXECUTION_ERROR", message: "fail" },
          } as import("../../../../shared/types/actions.js").ActionDispatchResult,
        },
        argsSummary: "{}",
      });
    }
    const stats = service.getAuditStats();
    const clusters = stats.anomalySignals.filter((s) => s.kind === "failure-cluster");
    expect(clusters).toHaveLength(0);
  });

  it("p95-z-score: skipped when fewer than 5 distinct tools", () => {
    const service = makeRecords(50, (i) => ({
      toolId: `tool.${i % 3}`,
      durationMs: 10 + i,
    }));
    const stats = service.getAuditStats();
    const p95 = stats.anomalySignals.filter((s) => s.kind === "p95-z-score");
    expect(p95).toHaveLength(0);
  });

  it("p95-z-score: emits signal for tool with extreme p95", () => {
    const { service } = makeFixture();
    // 5+ tools each with a distinct latency baseline so p95 MAD > 0.
    const toolBases: [string, number][] = [
      ["tool.a", 10],
      ["tool.b", 30],
      ["tool.c", 50],
      ["tool.d", 70],
      ["tool.f", 90],
    ];
    for (const [toolId, base] of toolBases) {
      for (let i = 0; i < 15; i++) {
        service.appendRecord({
          toolId,
          sessionId: "sess-1",
          tier: "action",
          args: {},
          durationMs: base + i,
          outcome: successOutcome,
          argsSummary: "{}",
        });
      }
    }
    // Tool.e has extreme p95.
    for (let i = 0; i < 15; i++) {
      service.appendRecord({
        toolId: "tool.e",
        sessionId: "sess-1",
        tier: "action",
        args: {},
        durationMs: 5000 + i * 50,
        outcome: successOutcome,
        argsSummary: "{}",
      });
    }
    const stats = service.getAuditStats();
    const p95 = stats.anomalySignals.filter((s) => s.kind === "p95-z-score");
    expect(p95.length).toBeGreaterThanOrEqual(1);
    expect(p95[0]!.toolId).toBe("tool.e");
  });
});

describe("shared narrowers — isGrantRecord / isAuditRecord (#10027)", () => {
  it("classifies a legacy dispatch record (no `type` field) as audit", () => {
    const record = {
      id: "audit-1",
      timestamp: 1,
      toolId: "agent.launch",
      sessionId: "sess-1",
      tier: "action",
      argsSummary: "{}",
      result: "success" as const,
      durationMs: 5,
      schemaVersion: 1,
      severity: "info" as const,
    };
    expect(isGrantRecord(record)).toBe(false);
    expect(isAuditRecord(record)).toBe(true);
  });

  it("classifies a grant record (with `type`) as grant", () => {
    const record = {
      type: "grant.issued" as const,
      id: "grant-1",
      timestamp: 1,
      sessionId: "sess-1",
      toolId: "files.search",
      ttlMs: 60000,
    };
    expect(isGrantRecord(record)).toBe(true);
    expect(isAuditRecord(record)).toBe(false);
  });

  it("rejects a record with a non-string `type` discriminator", () => {
    // Defensive: a malformed on-disk record that survived hydration should
    // be treated as the implicit dispatch kind, not as a grant record.
    const record = {
      id: "x",
      timestamp: 1,
      toolId: "t",
      sessionId: "s",
      tier: "action",
      argsSummary: "{}",
      result: "success" as const,
      durationMs: 0,
      schemaVersion: 1,
      severity: "info" as const,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentionally malformed
      type: 123 as any,
    };
    expect(isGrantRecord(record as never)).toBe(false);
    expect(isAuditRecord(record as never)).toBe(true);
  });

  it("rejects a record with an unknown `type` discriminator value", () => {
    // Forward-compat hazard: a future dispatch-record discriminator (or a
    // malformed persisted row) would otherwise be misclassified as a grant
    // and misrendered with `undefined` for its `type` field.
    const record = {
      id: "x",
      timestamp: 1,
      toolId: "t",
      sessionId: "s",
      tier: "action",
      argsSummary: "{}",
      result: "success" as const,
      durationMs: 0,
      schemaVersion: 1,
      severity: "info" as const,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentionally unknown discriminator
      type: "dispatch" as any,
    };
    expect(isGrantRecord(record as never)).toBe(false);
    expect(isAuditRecord(record as never)).toBe(true);
  });

  it("rejects case-mismatched `type` discriminators (lowercase grant.issued only)", () => {
    const record = {
      id: "x",
      timestamp: 1,
      sessionId: "s",
      toolId: "*",
      ttlMs: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentionally case-mismatched
      type: "Grant.Expired" as any,
    };
    expect(isGrantRecord(record as never)).toBe(false);
  });

  it("accepts every McpGrantRecordType value", () => {
    const types = [
      "grant.issued",
      "grant.expired",
      "grant.revoked",
      "tier.elevated",
      "tier.decayed",
    ] as const;
    for (const t of types) {
      const record = {
        type: t,
        id: "g",
        timestamp: 1,
        sessionId: "s",
        toolId: "*",
        ttlMs: 0,
      };
      expect(isGrantRecord(record)).toBe(true);
    }
  });
});

describe("AuditService.getLogRecords — union preservation (#10027)", () => {
  it("returns grant and dispatch records interleaved chronologically (newest-first)", async () => {
    const { service } = makeFixture();
    service.appendRecord({
      toolId: "agent.launch",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 5,
      outcome: successOutcome,
      argsSummary: "{}",
    });
    // Wait a tick so timestamps differ — appendRecord stamps Date.now() each
    // call but rapid back-to-back calls can collide on coarse-resolution
    // clocks; the ordering assertion is structural, not timestamp-strict.
    await new Promise((resolve) => setTimeout(resolve, 5));
    service.appendGrantRecord({
      type: "tier.elevated",
      sessionId: "sess-1",
      toolId: "*",
      ttlMs: 1800000,
      tier: "action",
      previousTier: "workbench",
    });
    const log = service.getLogRecords();
    expect(log).toHaveLength(2);
    // Newest-first: the grant was appended last, so it leads.
    expect(isGrantRecord(log[0]!)).toBe(true);
    expect(isAuditRecord(log[1]!)).toBe(true);
  });
});

describe("AuditService.pruneByAge (#10776)", () => {
  const DAY = 86_400_000;

  function seedRecord(timestamp: unknown): Record<string, unknown> {
    return {
      id: `r-${String(timestamp)}`,
      timestamp,
      toolId: "files.search",
      sessionId: "sess-1",
      tier: "action",
      argsSummary: "{}",
      result: "success" as McpAuditResult,
      durationMs: 1,
    };
  }

  it("drops records older than the retention window and keeps newer ones", () => {
    const now = Date.now();
    const { service, logStore } = makeFixture({}, [
      seedRecord(now - 8 * DAY),
      seedRecord(now - 6 * DAY),
      seedRecord(now - 1 * DAY),
    ]);
    service.pruneByAge(7);
    const ids = service.getRecords().map((r) => r.id);
    // getRecords is newest-first; the 8-day-old record is gone.
    expect(ids).toEqual([`r-${now - 1 * DAY}`, `r-${now - 6 * DAY}`]);
    expect(logStore.write).toHaveBeenCalledTimes(1);
  });

  it("keeps a record exactly at the cutoff boundary (>= cutoff retained)", () => {
    vi.useFakeTimers();
    try {
      const now = 1_000_000_000_000;
      vi.setSystemTime(now);
      const cutoff = now - 7 * DAY;
      const { service } = makeFixture({}, [seedRecord(cutoff), seedRecord(cutoff - 1)]);
      service.pruneByAge(7);
      const ids = service.getRecords().map((r) => r.id);
      // The record at exactly the cutoff survives; the one 1ms older is dropped.
      expect(ids).toEqual([`r-${cutoff}`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op when retentionDays <= 0 (Off keeps everything)", () => {
    const now = Date.now();
    const { service, logStore } = makeFixture({}, [
      seedRecord(now - 90 * DAY),
      seedRecord(now - 1 * DAY),
    ]);
    service.pruneByAge(0);
    expect(service.getRecords()).toHaveLength(2);
    expect(logStore.write).not.toHaveBeenCalled();
  });

  it("does not flush when nothing falls outside the window", () => {
    const now = Date.now();
    const { service, logStore } = makeFixture({}, [
      seedRecord(now - 2 * DAY),
      seedRecord(now - 1 * DAY),
    ]);
    service.pruneByAge(7);
    expect(service.getRecords()).toHaveLength(2);
    expect(logStore.write).not.toHaveBeenCalled();
  });

  it("no-ops silently on an empty ring", () => {
    const { service, logStore } = makeFixture({}, []);
    service.pruneByAge(7);
    expect(service.getRecords()).toHaveLength(0);
    expect(logStore.write).not.toHaveBeenCalled();
  });

  it("retains records with a non-finite timestamp rather than dropping them", () => {
    const now = Date.now();
    const { service } = makeFixture({}, [
      seedRecord(undefined),
      seedRecord(-Infinity),
      seedRecord(NaN),
      seedRecord(now - 30 * DAY),
      seedRecord(now - 1 * DAY),
    ]);
    service.pruneByAge(7);
    const ids = service.getRecords().map((r) => r.id);
    // Malformed-timestamp records are kept (even -Infinity, which is typeof
    // "number" but not finite); only the genuinely-old one drops.
    expect(ids).toContain("r-undefined");
    expect(ids).toContain("r--Infinity"); // seedRecord(-Infinity) → `r-${String(-Infinity)}`
    expect(ids).toContain("r-NaN");
    expect(ids).toContain(`r-${now - 1 * DAY}`);
    expect(ids).not.toContain(`r-${now - 30 * DAY}`);
  });

  it("flushes the pruned ring to the log store, not just the in-memory view", () => {
    const now = Date.now();
    const { service, getPersistedLog } = makeFixture({}, [
      seedRecord(now - 40 * DAY),
      seedRecord(now - 1 * DAY),
    ]);
    service.pruneByAge(7);
    const persistedIds = getPersistedLog().map((r) => (r as { id: string }).id);
    // The flushed payload reflects the prune, so a reload won't resurrect the
    // dropped record.
    expect(persistedIds).toEqual([`r-${now - 1 * DAY}`]);
  });
});
