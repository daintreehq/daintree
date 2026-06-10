import { beforeEach, describe, expect, it, vi } from "vitest";
import { migration022 } from "../022-audit-logs-store.js";

const auditLogsStoreMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
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
  } as unknown as Parameters<typeof migration022.up>[0];
}

const auditRecord = {
  id: "audit-1",
  timestamp: 1000,
  toolId: "actions.list",
  sessionId: "sess-1",
  tier: "action",
  argsSummary: "{}",
  result: "success",
  durationMs: 5,
};

const turnRecord = {
  id: "turn-1",
  timestamp: 2000,
  terminalId: "term-1",
  sessionId: "help-1",
  outcome: "answered",
};

describe("migration022 — audit logs store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditLogsStoreMock.get.mockReturnValue([]);
  });

  it("moves auditLog and turnOutcomeLog records to the audit-logs store and strips the old keys", () => {
    const data: Record<string, unknown> = {
      mcpServer: {
        enabled: true,
        port: 45454,
        apiKey: "key",
        auditEnabled: true,
        auditMaxRecords: 500,
        auditLog: [auditRecord],
        turnOutcomeLog: [turnRecord],
      },
    };
    const store = makeStoreMock(data);

    migration022.up(store);

    expect(auditLogsStoreMock.set).toHaveBeenCalledWith("mcpAuditLog", [auditRecord]);
    expect(auditLogsStoreMock.set).toHaveBeenCalledWith("mcpTurnOutcomeLog", [turnRecord]);
    const after = data.mcpServer as Record<string, unknown>;
    expect("auditLog" in after).toBe(false);
    expect("turnOutcomeLog" in after).toBe(false);
    // Config flags stay in config.json.
    expect(after).toMatchObject({
      enabled: true,
      port: 45454,
      apiKey: "key",
      auditEnabled: true,
      auditMaxRecords: 500,
    });
  });

  it("prepends migrated records before any already in the audit-logs store", () => {
    const existing = [{ ...auditRecord, id: "newer-1", timestamp: 5000 }];
    auditLogsStoreMock.get.mockImplementation((key: string) =>
      key === "mcpAuditLog" ? [...existing] : []
    );
    const store = makeStoreMock({
      mcpServer: { auditLog: [auditRecord] },
    });

    migration022.up(store);

    expect(auditLogsStoreMock.set).toHaveBeenCalledWith("mcpAuditLog", [auditRecord, ...existing]);
  });

  it("strips empty-array rings without writing to the audit-logs store", () => {
    const data: Record<string, unknown> = {
      mcpServer: { auditEnabled: true, auditLog: [], turnOutcomeLog: [] },
    };
    const store = makeStoreMock(data);

    migration022.up(store);

    expect(auditLogsStoreMock.set).not.toHaveBeenCalled();
    const after = data.mcpServer as Record<string, unknown>;
    expect("auditLog" in after).toBe(false);
    expect("turnOutcomeLog" in after).toBe(false);
    expect(after.auditEnabled).toBe(true);
  });

  it("leaves the store untouched when neither ring key is present", () => {
    const store = makeStoreMock({
      mcpServer: { enabled: false, auditEnabled: true },
    });

    migration022.up(store);

    expect(auditLogsStoreMock.set).not.toHaveBeenCalled();
    expect((store as unknown as { set: ReturnType<typeof vi.fn> }).set).not.toHaveBeenCalled();
  });

  it("handles a missing mcpServer object gracefully", () => {
    const store = makeStoreMock({});

    migration022.up(store);

    expect(auditLogsStoreMock.set).not.toHaveBeenCalled();
    expect((store as unknown as { set: ReturnType<typeof vi.fn> }).set).not.toHaveBeenCalled();
  });

  it("tolerates a corrupt audit-logs store value when merging", () => {
    auditLogsStoreMock.get.mockReturnValue("not-an-array");
    const store = makeStoreMock({
      mcpServer: { auditLog: [auditRecord] },
    });

    migration022.up(store);

    expect(auditLogsStoreMock.set).toHaveBeenCalledWith("mcpAuditLog", [auditRecord]);
  });

  it("has version 22", () => {
    expect(migration022.version).toBe(22);
  });
});
