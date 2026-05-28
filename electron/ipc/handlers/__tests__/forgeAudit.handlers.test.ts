import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForgeAuditRecord, ForgeAuditStats } from "../../../../shared/types/ipc/forge.js";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const showSaveDialogMock = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  dialog: { showSaveDialog: showSaveDialogMock },
}));

const writeFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ writeFile: writeFileMock }));

const auditServiceMock = vi.hoisted(() => ({
  getRecords: vi.fn<() => ForgeAuditRecord[]>(() => []),
  getAuditConfig: vi.fn<() => { enabled: boolean; maxRecords: number }>(() => ({
    enabled: true,
    maxRecords: 500,
  })),
  getAuditStats: vi.fn<() => ForgeAuditStats>(() => ({
    anomalySignals: [],
    anomalySuppressed: true,
    anomalyRecordFloor: 10,
  })),
  clear: vi.fn(),
  setEnabled: vi.fn<(enabled: boolean) => { enabled: boolean; maxRecords: number }>(() => ({
    enabled: false,
    maxRecords: 500,
  })),
}));

vi.mock("../../../services/forge/forgeAuditService.js", () => ({
  forgeAuditService: auditServiceMock,
}));

import { registerForgeAuditHandlers } from "../forgeAudit.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn as Handler;
}

function fakeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} as Electron.WebContents } as Electron.IpcMainInvokeEvent;
}

describe("registerForgeAuditHandlers", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    auditServiceMock.getRecords.mockReturnValue([]);
    auditServiceMock.getAuditConfig.mockReturnValue({ enabled: true, maxRecords: 500 });
    auditServiceMock.getAuditStats.mockReturnValue({
      anomalySignals: [],
      anomalySuppressed: true,
      anomalyRecordFloor: 10,
    });
    auditServiceMock.setEnabled.mockReturnValue({ enabled: false, maxRecords: 500 });
    cleanup = registerForgeAuditHandlers();
  });

  afterEach(() => {
    cleanup();
  });

  it("registers all six forge audit channels", () => {
    expect(ipcMainMock.handle).toHaveBeenCalledTimes(6);
    expect(ipcHandlers.has("forge-audit:get-records")).toBe(true);
    expect(ipcHandlers.has("forge-audit:get-config")).toBe(true);
    expect(ipcHandlers.has("forge-audit:get-stats")).toBe(true);
    expect(ipcHandlers.has("forge-audit:clear-log")).toBe(true);
    expect(ipcHandlers.has("forge-audit:set-enabled")).toBe(true);
    expect(ipcHandlers.has("forge-audit:export-log")).toBe(true);
  });

  it("get-audit-records delegates to service.getRecords", async () => {
    const sample: ForgeAuditRecord[] = [
      {
        id: "1",
        timestamp: 1,
        providerId: "builtin.github",
        methodName: "listIssues",
        result: "success",
        durationMs: 10,
        schemaVersion: 1,
        severity: "info",
      },
    ];
    auditServiceMock.getRecords.mockReturnValue(sample);
    await expect(getHandler("forge-audit:get-records")(fakeEvent())).resolves.toEqual(sample);
    expect(auditServiceMock.getRecords).toHaveBeenCalledTimes(1);
  });

  it("get-audit-config delegates to service.getAuditConfig", async () => {
    auditServiceMock.getAuditConfig.mockReturnValue({ enabled: false, maxRecords: 1000 });
    await expect(getHandler("forge-audit:get-config")(fakeEvent())).resolves.toEqual({
      enabled: false,
      maxRecords: 1000,
    });
  });

  it("get-audit-stats delegates to service.getAuditStats", async () => {
    const stats: ForgeAuditStats = {
      anomalySignals: [
        {
          id: "first-seen:builtin.github:listIssues",
          kind: "first-seen-method",
          providerId: "builtin.github",
          methodName: "listIssues",
          severity: "danger",
          timestamp: 1,
          recordIds: ["1"],
        },
      ],
      anomalySuppressed: false,
      anomalyRecordFloor: 10,
    };
    auditServiceMock.getAuditStats.mockReturnValue(stats);
    await expect(getHandler("forge-audit:get-stats")(fakeEvent())).resolves.toEqual(stats);
  });

  it("clear-audit-log delegates to service.clear", async () => {
    await getHandler("forge-audit:clear-log")(fakeEvent());
    expect(auditServiceMock.clear).toHaveBeenCalledTimes(1);
  });

  it("set-audit-enabled forwards boolean and returns config", async () => {
    auditServiceMock.setEnabled.mockReturnValue({ enabled: false, maxRecords: 500 });
    await expect(getHandler("forge-audit:set-enabled")(fakeEvent(), false)).resolves.toEqual({
      enabled: false,
      maxRecords: 500,
    });
    expect(auditServiceMock.setEnabled).toHaveBeenCalledWith(false);
  });

  it("set-audit-enabled rejects non-boolean input", async () => {
    await expect(getHandler("forge-audit:set-enabled")(fakeEvent(), "true")).rejects.toThrow(
      "enabled must be a boolean"
    );
    expect(auditServiceMock.setEnabled).not.toHaveBeenCalled();
  });

  it("export-audit-log writes NDJSON when dialog confirms", async () => {
    showSaveDialogMock.mockResolvedValue({
      canceled: false,
      filePath: "/tmp/forge-audit.ndjson",
    });
    const records: ForgeAuditRecord[] = [
      {
        id: "a",
        timestamp: 1,
        providerId: "builtin.github",
        methodName: "listIssues",
        result: "success",
        durationMs: 5,
        schemaVersion: 1,
        severity: "info",
      },
      {
        id: "b",
        timestamp: 2,
        providerId: "builtin.github",
        methodName: "getIssue",
        result: "error",
        durationMs: 12,
        schemaVersion: 1,
        severity: "error",
        errorMessage: "404",
      },
    ];
    await expect(getHandler("forge-audit:export-log")(fakeEvent(), records)).resolves.toBe(true);
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [path, content] = writeFileMock.mock.calls[0]!;
    expect(path).toBe("/tmp/forge-audit.ndjson");
    expect(content).toBe(JSON.stringify(records[0]) + "\n" + JSON.stringify(records[1]) + "\n");
  });

  it("export-audit-log returns false when dialog is canceled", async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: undefined });
    await expect(getHandler("forge-audit:export-log")(fakeEvent(), [])).resolves.toBe(false);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("export-audit-log rejects non-array input", async () => {
    await expect(getHandler("forge-audit:export-log")(fakeEvent(), "not an array")).rejects.toThrow(
      "records must be an array"
    );
  });
});
