import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(() => "/fake/userData"),
  getVersion: vi.fn(() => "1.0.0"),
  isPackaged: false as boolean,
}));

const browserWindowMock = vi.hoisted(() => ({
  getAllWindows: vi.fn(() => [{}]),
}));

vi.mock("../../store.js", () => ({
  store: storeMock,
}));

vi.mock("electron", () => ({
  app: appMock,
  BrowserWindow: browserWindowMock,
}));

vi.mock("../GpuCrashMonitorService.js", () => ({
  isGpuDisabledByFlag: vi.fn(() => false),
}));

import { CrashRecoveryService } from "../CrashRecoveryService.js";

function makeService(): CrashRecoveryService {
  return new CrashRecoveryService();
}

function writeBackup(userData: string, snapshot: unknown): void {
  const backupDir = path.join(userData, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, "session-state.json"), JSON.stringify(snapshot));
}

function writeMarker(userData: string, overrides?: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(userData, "running.lock"),
    JSON.stringify({
      sessionStartMs: Date.now() - 5_000,
      appVersion: "1.0.0",
      platform: "darwin",
      ...overrides,
    })
  );
}

describe("CrashRecoveryService adversarial", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T10:00:00.000Z"));
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-recovery-adversarial-"));
    appMock.getPath.mockReturnValue(tmpDir);
    appMock.isPackaged = false;
    storeMock.get.mockImplementation((key: string) => {
      if (key === "crashRecovery") {
        return { autoRestoreOnCrash: false };
      }
      if (key === "appState") {
        return { terminals: [] };
      }
      return undefined;
    });
    storeMock.set.mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("TRUNCATED_BACKUP_JSON_FAILS_CLOSED", () => {
    const backupDir = path.join(tmpDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "session-state.json"), '{"appState":');

    const service = makeService();

    expect(service.restoreBackup()).toBe(false);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("INVALID_SNAPSHOT_SHAPE_NO_GARBAGE_WRITES", () => {
    writeBackup(tmpDir, {
      capturedAt: Date.now(),
      windowStates: "oops",
      appState: {
        terminals: {},
      },
    });

    const service = makeService();

    expect(service.restoreBackup()).toBe(false);
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("CACHED_PRE_CRASH_SNAPSHOT_WINS", () => {
    writeBackup(tmpDir, {
      capturedAt: Date.now(),
      appState: {
        terminals: [{ id: "agent-1", kind: "agent", title: "Recovered" }],
      },
      windowState: {
        width: 1200,
      },
    });
    writeMarker(tmpDir);

    const service = makeService();
    service.initialize();

    writeBackup(tmpDir, {
      capturedAt: Date.now(),
      appState: {
        terminals: [],
      },
    });

    expect(service.restoreBackup()).toBe(true);
    expect(storeMock.set).toHaveBeenCalledWith("appState", {
      terminals: [{ id: "agent-1", kind: "agent", title: "Recovered" }],
    });
    expect(storeMock.set).toHaveBeenCalledWith("windowState", {
      width: 1200,
    });
  });

  it("STARTBACKUPTIMER_IDEMPOTENT", () => {
    const service = makeService();
    const takeBackup = vi.spyOn(service, "takeBackup").mockImplementation(() => {});

    service.startBackupTimer();
    service.startBackupTimer();
    vi.advanceTimersByTime(60_000);

    expect(takeBackup).toHaveBeenCalledTimes(2);
  });

  it("NESTED_STATE_ROUND_TRIPS", () => {
    writeBackup(tmpDir, {
      capturedAt: Date.now(),
      appState: {
        terminals: [
          {
            id: "panel-1",
            kind: "agent",
            meta: {
              badges: ["active", "pinned"],
              layout: {
                docked: true,
                column: 2,
              },
            },
          },
        ],
      },
      windowStates: {
        main: {
          bounds: { width: 1440, height: 900 },
          tabs: [{ id: "panel-1", kind: "agent" }],
        },
      },
      windowState: {
        x: 10,
        y: 20,
      },
    });

    const service = makeService();

    expect(service.restoreBackup()).toBe(true);
    expect(storeMock.set).toHaveBeenCalledWith("appState", {
      terminals: [
        {
          id: "panel-1",
          kind: "agent",
          meta: {
            badges: ["active", "pinned"],
            layout: {
              docked: true,
              column: 2,
            },
          },
        },
      ],
    });
    expect(storeMock.set).toHaveBeenCalledWith("windowStates", {
      main: {
        bounds: { width: 1440, height: 900 },
        tabs: [{ id: "panel-1", kind: "agent" }],
      },
    });
    expect(storeMock.set).toHaveBeenCalledWith("windowState", {
      x: 10,
      y: 20,
    });
  });

  it("CORRUPT_CRASH_LOG_FALLS_BACK", () => {
    const crashDir = path.join(tmpDir, "crashes");
    fs.mkdirSync(crashDir, { recursive: true });
    const crashLogPath = path.join(crashDir, "crash-bad.json");
    fs.writeFileSync(crashLogPath, "{bad json");
    writeMarker(tmpDir, { crashLogPath });

    const service = makeService();
    service.initialize();

    const pending = service.getPendingCrash();
    expect(pending).not.toBeNull();
    expect(pending?.entry.appVersion).toBe("1.0.0");
    expect(typeof pending?.entry.timestamp).toBe("number");
    expect(typeof pending?.entry.windowCount).toBe("number");
  });

  it("MARKER_PLUS_BAD_BACKUP_DOES_NOT_BRICK", () => {
    const backupDir = path.join(tmpDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "session-state.json"), "{bad json");
    writeMarker(tmpDir);

    const service = makeService();
    service.initialize();

    const pending = service.getPendingCrash();
    expect(pending).not.toBeNull();
    expect(pending?.hasBackup).toBe(true);
    expect(pending?.panels).toEqual([]);
    expect(service.restoreBackup()).toBe(false);
  });

  it("PANEL_FILTER_ONE_SHOT_AFTER_FAILED_RESTORE", () => {
    const backupDir = path.join(tmpDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "session-state.json"), "not json");
    const service = makeService();

    service.setPanelFilter(["a", "b"]);

    expect(service.restoreBackup()).toBe(false);
    expect(service.consumePanelFilter()).toEqual(["a", "b"]);
    expect(service.consumePanelFilter()).toBeNull();
  });
});
