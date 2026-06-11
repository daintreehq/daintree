import { beforeEach, describe, expect, it, vi } from "vitest";
import { migration023 } from "../023-audit-rings-to-audit-logs-store.js";

const auditLogsStoreMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  path: "/tmp/audit-logs.json",
}));

vi.mock("../../../store.js", () => ({
  auditLogsStore: auditLogsStoreMock,
}));

function makeStoreMock(data: Record<string, unknown>) {
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    delete: vi.fn((key: string) => {
      delete data[key];
    }),
  } as unknown as Parameters<typeof migration023.up>[0];
}

const pluginRecord = { id: "plugin-1", ts: 1000, pluginId: "acme", actionId: "acme.go" };
const forgeRecord = { id: "forge-1", timestamp: 2000, providerId: "builtin.github" };
const runRecord = { id: "run-1", kind: "recipe", timestamp: 3000 };
const mcpRecord = { id: "mcp-1", ts: 4000, pluginId: "acme", serverId: "main" };

describe("migration023 — audit rings to audit-logs store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditLogsStoreMock.path = "/tmp/audit-logs.json";
    auditLogsStoreMock.get.mockReturnValue([]);
  });

  it("moves all four rings to the audit-logs store and strips the old keys", () => {
    const data: Record<string, unknown> = {
      plugins: {
        disabled: [],
        auditEnabled: true,
        auditMaxRecords: 500,
        auditLog: [pluginRecord],
        installed: {},
      },
      forgeAudit: { auditEnabled: true, auditMaxRecords: 500, auditLog: [forgeRecord] },
      runHistory: { records: [runRecord] },
      pluginMcpAudit: { auditEnabled: true, auditMaxRecords: 500, auditLog: [mcpRecord] },
    };
    const store = makeStoreMock(data);

    migration023.up(store);

    expect(auditLogsStoreMock.set).toHaveBeenCalledWith("pluginAuditLog", [pluginRecord]);
    expect(auditLogsStoreMock.set).toHaveBeenCalledWith("forgeAuditLog", [forgeRecord]);
    expect(auditLogsStoreMock.set).toHaveBeenCalledWith("runHistoryRecords", [runRecord]);
    expect(auditLogsStoreMock.set).toHaveBeenCalledWith("pluginMcpAuditLog", [mcpRecord]);

    expect("auditLog" in (data.plugins as object)).toBe(false);
    expect("auditLog" in (data.forgeAudit as object)).toBe(false);
    expect("records" in (data.runHistory as object)).toBe(false);
    expect("auditLog" in (data.pluginMcpAudit as object)).toBe(false);

    // Config flags stay in config.json.
    expect(data.plugins).toMatchObject({ disabled: [], auditEnabled: true, auditMaxRecords: 500 });
    expect(data.forgeAudit).toMatchObject({ auditEnabled: true, auditMaxRecords: 500 });
    expect(data.pluginMcpAudit).toMatchObject({ auditEnabled: true, auditMaxRecords: 500 });
  });

  it("prepends migrated records before any already in the audit-logs store", () => {
    const existing = [{ ...pluginRecord, id: "newer-1", ts: 9000 }];
    auditLogsStoreMock.get.mockImplementation((key: string) =>
      key === "pluginAuditLog" ? [...existing] : []
    );
    const store = makeStoreMock({ plugins: { auditLog: [pluginRecord] } });

    migration023.up(store);

    expect(auditLogsStoreMock.set).toHaveBeenCalledWith("pluginAuditLog", [
      pluginRecord,
      ...existing,
    ]);
  });

  it("strips empty-array rings without writing to the audit-logs store", () => {
    const data: Record<string, unknown> = {
      plugins: { auditEnabled: true, auditLog: [] },
      runHistory: { records: [] },
    };
    const store = makeStoreMock(data);

    migration023.up(store);

    expect(auditLogsStoreMock.set).not.toHaveBeenCalled();
    expect("auditLog" in (data.plugins as object)).toBe(false);
    expect("records" in (data.runHistory as object)).toBe(false);
    expect((data.plugins as Record<string, unknown>).auditEnabled).toBe(true);
  });

  it("migrates a partial set when only some slices carry a ring", () => {
    const data: Record<string, unknown> = {
      plugins: { auditEnabled: true },
      forgeAudit: { auditEnabled: true, auditLog: [forgeRecord] },
    };
    const store = makeStoreMock(data);

    migration023.up(store);

    expect(auditLogsStoreMock.set).toHaveBeenCalledTimes(1);
    expect(auditLogsStoreMock.set).toHaveBeenCalledWith("forgeAuditLog", [forgeRecord]);
    // Untouched slices are not rewritten.
    const setMock = (store as unknown as { set: ReturnType<typeof vi.fn> }).set;
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith("forgeAudit", { auditEnabled: true });
  });

  it("leaves everything untouched when no ring key is present", () => {
    const store = makeStoreMock({
      plugins: { disabled: [], auditEnabled: true },
      forgeAudit: { auditEnabled: true },
      runHistory: {},
      pluginMcpAudit: { auditEnabled: true },
    });

    migration023.up(store);

    expect(auditLogsStoreMock.set).not.toHaveBeenCalled();
    expect((store as unknown as { set: ReturnType<typeof vi.fn> }).set).not.toHaveBeenCalled();
  });

  it("defers the move when the audit-logs store is not durable", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    auditLogsStoreMock.path = "";
    const data: Record<string, unknown> = { plugins: { auditLog: [pluginRecord] } };
    const store = makeStoreMock(data);

    migration023.up(store);

    expect(auditLogsStoreMock.set).not.toHaveBeenCalled();
    expect((store as unknown as { set: ReturnType<typeof vi.fn> }).set).not.toHaveBeenCalled();
    expect((data.plugins as Record<string, unknown>).auditLog).toEqual([pluginRecord]);
    warnSpy.mockRestore();
  });

  it("tolerates a corrupt audit-logs store value when merging", () => {
    auditLogsStoreMock.get.mockReturnValue("not-an-array");
    const store = makeStoreMock({ runHistory: { records: [runRecord] } });

    migration023.up(store);

    expect(auditLogsStoreMock.set).toHaveBeenCalledWith("runHistoryRecords", [runRecord]);
  });

  it("has version 23", () => {
    expect(migration023.version).toBe(23);
  });
});
