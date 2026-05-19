import { describe, expect, it, vi } from "vitest";
import { AuditService, type AuditOutcome } from "../auditLog.js";

function makeFixture(initialConfig: Record<string, unknown> = {}) {
  const config: Record<string, unknown> = {
    auditEnabled: true,
    auditMaxRecords: 500,
    ...initialConfig,
  };
  const saveConfig = vi.fn((patch: Record<string, unknown>) => {
    Object.assign(config, patch);
  });
  const service = new AuditService(saveConfig, () => config);
  return { service, saveConfig, config };
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

  it("new records carry schemaVersion 1", () => {
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
    expect(record!.schemaVersion).toBe(1);
  });

  it("derives severity: success → info", () => {
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
    expect(record!.severity).toBe("info");
  });

  it("derives severity: unauthorized → warning", () => {
    const { service } = makeFixture();
    service.appendRecord({
      toolId: "agent.terminal",
      sessionId: "sess-1",
      tier: "workbench",
      args: {},
      durationMs: 0,
      outcome: unauthorizedOutcome,
      argsSummary: "{}",
    });
    const [record] = service.getRecords();
    expect(record!.severity).toBe("warning");
  });

  it("derives severity: dedup → info", () => {
    const { service } = makeFixture();
    service.appendRecord({
      toolId: "agent.terminal",
      sessionId: "sess-1",
      tier: "action",
      args: {},
      durationMs: 10,
      outcome: { kind: "dedup" },
      argsSummary: "{}",
    });
    const [record] = service.getRecords();
    expect(record!.severity).toBe("info");
  });
});

describe("AuditService hydrate — backward compat", () => {
  it("tolerates persisted records missing schemaVersion and severity", () => {
    const { service } = makeFixture({
      auditLog: [
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
      ],
    });
    const records = service.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.id).toBe("old-1");
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
                  error: { code: "ERR", message: "fail" },
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
          error: { code: "ERR", message: "fail" },
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
            error: { code: "ERR", message: "fail" },
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
            error: { code: "ERR", message: "fail" },
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
            error: { code: "ERR", message: "fail" },
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
