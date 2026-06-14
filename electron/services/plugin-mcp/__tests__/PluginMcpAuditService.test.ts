import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginMcpAuditService } from "../PluginMcpAuditService.js";

function makeConfig(initial: Record<string, unknown> = {}) {
  let config: Record<string, unknown> = { auditEnabled: true, auditMaxRecords: 500, ...initial };
  return {
    save: (patch: Record<string, unknown>) => {
      config = { ...config, ...patch };
    },
    read: () => config,
    raw: () => config,
    // The ring is kept under the same `auditLog` key so seeding and
    // assertions read naturally, but it round-trips through the injected
    // log store (the real ring lives in the audit-logs store since
    // migration023).
    logStore: {
      read: () => config.auditLog,
      write: (records: unknown[]) => {
        config = { ...config, auditLog: records };
      },
    },
  };
}

describe("PluginMcpAuditService", () => {
  let cfg: ReturnType<typeof makeConfig>;
  let service: PluginMcpAuditService;

  beforeEach(() => {
    cfg = makeConfig();
    service = new PluginMcpAuditService(cfg.save, cfg.read, cfg.logStore);
  });

  afterEach(() => {
    service._resetForTest();
  });

  it("appends a record with hashed fields and the expected shape", () => {
    service.append({
      pluginId: "acme",
      serverId: "main",
      toolName: "do_thing",
      dangerTier: "D1",
      descriptionRaw: "A test description.",
      inputSchema: { type: "object", properties: {} },
      rawArgs: { x: 1 },
      durationMs: 12,
      result: "success",
    });
    const records = service.getRecords();
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r).toMatchObject({
      pluginId: "acme",
      serverId: "main",
      toolName: "do_thing",
      dangerTier: "D1",
      durationMs: 12,
      result: "success",
      schemaVersion: 1,
    });
    expect(r.tool_description_sha).toMatch(/^[0-9a-f]{64}$/);
    expect(r.input_schema_sha).toMatch(/^[0-9a-f]{64}$/);
    expect(r.arg_sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never persists raw call arguments — only the arg_sha", () => {
    service.append({
      pluginId: "acme",
      serverId: "main",
      toolName: "do_thing",
      dangerTier: "D1",
      descriptionRaw: "desc",
      inputSchema: null,
      rawArgs: { token: "VERY_SECRET_VALUE_DO_NOT_LEAK" },
      durationMs: 1,
      result: "success",
    });
    service.flushNow();
    const persisted = JSON.stringify(cfg.raw().auditLog ?? []);
    expect(persisted).not.toContain("VERY_SECRET_VALUE_DO_NOT_LEAK");
    expect(persisted).toContain("arg_sha");
  });

  it("emits arg_sha='' for calls with no args", () => {
    service.append({
      pluginId: "acme",
      serverId: "main",
      toolName: "ping",
      dangerTier: "D0",
      descriptionRaw: "x",
      inputSchema: null,
      rawArgs: undefined,
      durationMs: 0,
      result: "success",
    });
    expect(service.getRecords()[0]?.arg_sha).toBe("");
  });

  it("does not append when auditEnabled is false", () => {
    cfg.save({ auditEnabled: false });
    service.append({
      pluginId: "x",
      serverId: "s",
      toolName: "t",
      dangerTier: "D0",
      descriptionRaw: "",
      inputSchema: null,
      rawArgs: undefined,
      durationMs: 0,
      result: "success",
    });
    expect(service.getRecords()).toEqual([]);
  });

  it("trims to the configured max records (oldest evicted)", () => {
    cfg.save({ auditMaxRecords: 50 });
    for (let i = 0; i < 60; i++) {
      service.append({
        pluginId: "p",
        serverId: "s",
        toolName: `tool-${i}`,
        dangerTier: "D0",
        descriptionRaw: "",
        inputSchema: null,
        rawArgs: undefined,
        durationMs: 0,
        result: "success",
      });
    }
    const records = service.getRecords();
    expect(records).toHaveLength(50);
    expect(records[0]?.toolName).toBe("tool-59");
    expect(records.at(-1)?.toolName).toBe("tool-10");
  });

  it("classifies invisible-Unicode rug-pull descriptions with a different tool_description_sha", () => {
    service.append({
      pluginId: "p",
      serverId: "s",
      toolName: "t",
      dangerTier: "D0",
      descriptionRaw: "Read the file.",
      inputSchema: null,
      rawArgs: undefined,
      durationMs: 0,
      result: "success",
    });
    service.append({
      pluginId: "p",
      serverId: "s",
      toolName: "t",
      dangerTier: "D0",
      // eslint-disable-next-line no-irregular-whitespace
      descriptionRaw: `Read the file.​`, // appended zero-width space
      inputSchema: null,
      rawArgs: undefined,
      durationMs: 0,
      result: "success",
    });
    const [b, a] = service.getRecords();
    expect(a?.tool_description_sha).not.toEqual(b?.tool_description_sha);
  });

  it("hydration strips unknown fields — tampered records cannot smuggle a rawArgs payload", () => {
    const tampered = {
      id: "fake-id",
      ts: 0,
      pluginId: "p",
      serverId: "s",
      toolName: "t",
      dangerTier: "D1",
      tool_description_sha: "x".repeat(64),
      input_schema_sha: "y".repeat(64),
      arg_sha: "z".repeat(64),
      durationMs: 1,
      result: "success",
      schemaVersion: 1,
      // Forbidden plaintext fields a future schema or attacker might add:
      rawArgs: { token: "SHOULD_BE_DROPPED" },
      descriptionRaw: "SHOULD_BE_DROPPED",
    };
    const cfgTampered = makeConfig({ auditLog: [tampered] });
    const rebuilt = new PluginMcpAuditService(
      cfgTampered.save,
      cfgTampered.read,
      cfgTampered.logStore
    );
    rebuilt.hydrate();
    // Append a record to trigger a flush, then check the persisted JSON.
    rebuilt.append({
      pluginId: "p",
      serverId: "s",
      toolName: "t",
      dangerTier: "D0",
      descriptionRaw: "",
      inputSchema: null,
      rawArgs: undefined,
      durationMs: 0,
      result: "success",
    });
    rebuilt.flushNow();
    const persisted = JSON.stringify(cfgTampered.raw().auditLog ?? []);
    expect(persisted).not.toContain("SHOULD_BE_DROPPED");
    rebuilt._resetForTest();
  });

  it("records consentReason/consentDecision/errorCode when supplied", () => {
    service.append({
      pluginId: "p",
      serverId: "s",
      toolName: "t",
      dangerTier: "D1",
      descriptionRaw: "x",
      inputSchema: null,
      rawArgs: undefined,
      durationMs: 0,
      result: "rejected",
      consentReason: "first-use",
      consentDecision: "rejected",
      errorCode: "PLUGIN_MCP_USER_REJECTED",
    });
    const r = service.getRecords()[0]!;
    expect(r.consentReason).toBe("first-use");
    expect(r.consentDecision).toBe("rejected");
    expect(r.errorCode).toBe("PLUGIN_MCP_USER_REJECTED");
  });
});
