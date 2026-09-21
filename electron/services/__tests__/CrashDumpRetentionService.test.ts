import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const appMock = vi.hoisted(() => ({
  getPath: vi.fn<(name: string) => string>(),
}));

const loggerMock = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("electron", () => ({ app: appMock }));
vi.mock("../../utils/logger.js", () => loggerMock);

import {
  _resetCrashDumpRetentionForTests,
  requestNativeCrashDumpPrune,
} from "../CrashDumpRetentionService.js";
import {
  _resetCrashRecoveryInspectionForTests,
  markCrashRecoveryInspectionComplete,
} from "../../utils/crashDumpRetention.js";

const DAY = 24 * 60 * 60 * 1000;

describe("requestNativeCrashDumpPrune", () => {
  let dumpsDir: string;

  function writeDump(relPath: string, ageMs: number): string {
    const filePath = path.join(dumpsDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "fake-minidump");
    const mtime = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, mtime, mtime);
    return filePath;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _resetCrashDumpRetentionForTests();
    _resetCrashRecoveryInspectionForTests();
    dumpsDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-dump-service-"));
    appMock.getPath.mockImplementation((name) => {
      if (name === "crashDumps") return dumpsDir;
      throw new Error(`unexpected path ${name}`);
    });
  });

  afterEach(() => {
    fs.rmSync(dumpsDir, { recursive: true, force: true });
  });

  it("refuses to prune before crash recovery has inspected the dumps", async () => {
    const dump = writeDump("pending/old.dmp", 90 * DAY);

    await expect(requestNativeCrashDumpPrune()).resolves.toBeNull();

    expect(fs.existsSync(dump)).toBe(true);
    expect(appMock.getPath).not.toHaveBeenCalled();
    expect(loggerMock.logWarn).toHaveBeenCalledWith(expect.stringContaining("Skipped"));
  });

  it("prunes once inspection is complete and logs aggregates without paths", async () => {
    markCrashRecoveryInspectionComplete();
    const old = writeDump("pending/old.dmp", 90 * DAY);
    const recent = writeDump("pending/recent.dmp", 2 * DAY);

    const result = await requestNativeCrashDumpPrune();

    expect(result).toMatchObject({ count: 2, deletedCount: 1 });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(loggerMock.logInfo).toHaveBeenCalledTimes(1);
    const [, context] = loggerMock.logInfo.mock.calls[0];
    expect(context).toMatchObject({ count: 2, deletedCount: 1, oldestAgeHours: 90 * 24 });
    expect(JSON.stringify(loggerMock.logInfo.mock.calls)).not.toContain(dumpsDir);
  });

  it("shares one in-flight pass between concurrent callers", async () => {
    markCrashRecoveryInspectionComplete();
    writeDump("pending/old.dmp", 90 * DAY);

    const first = requestNativeCrashDumpPrune();
    const second = requestNativeCrashDumpPrune();

    expect(second).toBe(first);
    await first;
    expect(appMock.getPath).toHaveBeenCalledTimes(1);

    await requestNativeCrashDumpPrune();
    expect(appMock.getPath).toHaveBeenCalledTimes(2);
  });

  it("resolves null instead of rejecting when the dumps path cannot be resolved", async () => {
    markCrashRecoveryInspectionComplete();
    appMock.getPath.mockImplementation(() => {
      throw Object.assign(new Error("no path"), { code: "ENOTSUP" });
    });

    await expect(requestNativeCrashDumpPrune()).resolves.toBeNull();

    expect(loggerMock.logWarn).toHaveBeenCalledWith(expect.stringContaining("failed"), {
      code: "ENOTSUP",
    });
  });

  it("logs cleanup failures as a warning", async () => {
    markCrashRecoveryInspectionComplete();
    writeDump("pending/old.dmp", 90 * DAY);
    fs.writeFileSync(path.join(dumpsDir, "completed"), "not a directory");

    await requestNativeCrashDumpPrune();

    expect(loggerMock.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("with failures"),
      expect.objectContaining({ failures: { "scan:ENOTDIR": 1 }, deletedCount: 1 })
    );
    expect(loggerMock.logInfo).not.toHaveBeenCalled();
  });

  it("logs at debug level when there are no dumps on disk", async () => {
    markCrashRecoveryInspectionComplete();

    await requestNativeCrashDumpPrune();

    expect(loggerMock.logDebug).toHaveBeenCalledTimes(1);
    expect(loggerMock.logInfo).not.toHaveBeenCalled();
  });
});
