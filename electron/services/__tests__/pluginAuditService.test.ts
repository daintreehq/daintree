import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module instantiates a `store`-backed singleton at import; stub the store
// so importing the class doesn't pull in electron-store. The tests below
// construct their own service instances with explicit config fixtures.
vi.mock("../../store.js", () => ({
  store: { get: vi.fn(() => ({})), set: vi.fn() },
}));

import { PluginAuditService } from "../pluginAuditService.js";
import {
  PLUGIN_AUDIT_DEFAULT_MAX_RECORDS,
  PLUGIN_AUDIT_MIN_RECORDS,
  PLUGIN_AUDIT_SCHEMA_VERSION,
} from "../../../shared/types/ipc/plugin.js";

function makeFixture(initialConfig: Record<string, unknown> = {}) {
  const config: Record<string, unknown> = {
    auditEnabled: true,
    auditMaxRecords: 500,
    ...initialConfig,
  };
  const saveConfig = vi.fn((patch: Record<string, unknown>) => {
    Object.assign(config, patch);
  });
  const service = new PluginAuditService(saveConfig, () => config);
  return { service, saveConfig, config };
}

const baseInput = {
  pluginId: "acme.my-plugin",
  channel: "get-data",
  argsSummary: '["arg1"]',
  durationMs: 12,
} as const;

describe("PluginAuditService.appendRecord", () => {
  it("stamps source, schemaVersion, severity, and rounds duration", () => {
    const { service } = makeFixture();
    service.appendRecord({ ...baseInput, result: "success", durationMs: 12.7 });
    const [record] = service.getRecords();
    expect(record).toMatchObject({
      source: "plugin",
      pluginId: "acme.my-plugin",
      channel: "get-data",
      result: "success",
      severity: "info",
      schemaVersion: PLUGIN_AUDIT_SCHEMA_VERSION,
      durationMs: 13,
    });
    expect(record!.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("derives critical severity for a thrown dispatch", () => {
    const { service } = makeFixture();
    service.appendRecord({
      ...baseInput,
      result: "error",
      errorCode: "DISPATCH_THREW",
      webContentsId: 9,
    });
    const [record] = service.getRecords();
    expect(record).toMatchObject({
      result: "error",
      errorCode: "DISPATCH_THREW",
      severity: "critical",
      webContentsId: 9,
    });
  });

  it("records contributionId and scope for decoration failures", () => {
    const { service } = makeFixture();
    service.appendRecord({
      pluginId: "acme.deco",
      channel: "plugin:file-decorations-get",
      contributionId: "diff",
      scope: "worktree-diff:/r",
      argsSummary: "worktree-diff:/r",
      result: "error",
      errorCode: "TIMEOUT",
      durationMs: 3000,
    });
    const [record] = service.getRecords();
    expect(record).toMatchObject({
      contributionId: "diff",
      scope: "worktree-diff:/r",
      errorCode: "TIMEOUT",
      severity: "warning",
    });
  });

  it("omits optional fields when not provided", () => {
    const { service } = makeFixture();
    service.appendRecord({ ...baseInput, result: "success" });
    const [record] = service.getRecords();
    expect(record).not.toHaveProperty("errorCode");
    expect(record).not.toHaveProperty("webContentsId");
    expect(record).not.toHaveProperty("contributionId");
    expect(record).not.toHaveProperty("scope");
  });

  it("skips writing when auditEnabled is false", () => {
    const { service } = makeFixture({ auditEnabled: false });
    service.appendRecord({ ...baseInput, result: "success" });
    expect(service.getRecords()).toHaveLength(0);
  });

  it("trims the ring buffer to the configured cap", () => {
    const { service } = makeFixture({ auditMaxRecords: PLUGIN_AUDIT_MIN_RECORDS });
    for (let i = 0; i < PLUGIN_AUDIT_MIN_RECORDS + 10; i++) {
      service.appendRecord({ ...baseInput, channel: `c${i}`, result: "success" });
    }
    const records = service.getRecords();
    expect(records).toHaveLength(PLUGIN_AUDIT_MIN_RECORDS);
    // Newest-first: the most recent channel survives, the oldest is evicted.
    expect(records[0]!.channel).toBe(`c${PLUGIN_AUDIT_MIN_RECORDS + 9}`);
    expect(records.some((r) => r.channel === "c0")).toBe(false);
  });
});

describe("PluginAuditService hydration", () => {
  it("backfills source/schemaVersion/severity on legacy records", () => {
    const { service } = makeFixture({
      auditLog: [{ id: "x", timestamp: 1, pluginId: "p", channel: "c", result: "error" }],
    });
    const [record] = service.getRecords();
    expect(record).toMatchObject({
      source: "plugin",
      schemaVersion: PLUGIN_AUDIT_SCHEMA_VERSION,
      severity: "error",
    });
  });

  it("drops non-object persisted entries", () => {
    const { service } = makeFixture({
      auditLog: [null, 5, "bad", { id: "ok", result: "success" }],
    });
    expect(service.getRecords()).toHaveLength(1);
  });

  it("falls back to a valid severity when a persisted result is unrecognized", () => {
    const { service } = makeFixture({
      auditLog: [{ id: "x", timestamp: 1, pluginId: "p", channel: "c", result: "bogus" }],
    });
    const [record] = service.getRecords();
    expect(record!.severity).toBe("info");
  });
});

describe("PluginAuditService flushing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("flushes the ring buffer to saveConfig after the debounce window", () => {
    const { service, saveConfig } = makeFixture();
    service.appendRecord({ ...baseInput, result: "success" });
    expect(saveConfig).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(saveConfig).toHaveBeenCalledWith({ auditLog: expect.any(Array) });
  });

  it("flushNow writes immediately and cancels the pending timer", () => {
    const { service, saveConfig } = makeFixture();
    service.appendRecord({ ...baseInput, result: "success" });
    service.flushNow();
    expect(saveConfig).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(saveConfig).toHaveBeenCalledTimes(1);
  });
});

describe("PluginAuditService config", () => {
  it("normalizes max records and reports enabled state", () => {
    const { service } = makeFixture({ auditMaxRecords: 1 });
    expect(service.getAuditConfig()).toEqual({
      enabled: true,
      maxRecords: PLUGIN_AUDIT_MIN_RECORDS,
    });
  });

  it("falls back to the default cap for a non-numeric value", () => {
    const { service } = makeFixture({ auditMaxRecords: "nope" });
    expect(service.getAuditConfig().maxRecords).toBe(PLUGIN_AUDIT_DEFAULT_MAX_RECORDS);
  });
});
