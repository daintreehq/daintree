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
    expect(service.getAuditStats()).toEqual({ auth401Count: 0 });
  });

  it("increments on each call", () => {
    const { service } = makeFixture();
    service.recordAuth401();
    service.recordAuth401();
    service.recordAuth401();
    expect(service.getAuditStats()).toEqual({ auth401Count: 3 });
  });

  it("does not increment when audit is disabled", () => {
    const { service } = makeFixture({ auditEnabled: false });
    service.recordAuth401();
    service.recordAuth401();
    expect(service.getAuditStats()).toEqual({ auth401Count: 0 });
  });

  it("is not reset by clear() — counter is session-scoped, not log-scoped", () => {
    const { service } = makeFixture();
    service.recordAuth401();
    service.recordAuth401();
    service.clear();
    expect(service.getAuditStats()).toEqual({ auth401Count: 2 });
  });
});
