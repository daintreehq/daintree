import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(() => "/fake/userData"),
}));

vi.mock("electron", () => ({
  app: appMock,
}));

import { getMainCrashLogPath, appendMainCrashLog, emergencyLogMainFatal } from "../emergencyLog.js";

describe("emergencyLog", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "emergency-log-test-"));
    appMock.getPath.mockReturnValue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("getMainCrashLogPath", () => {
    it("returns path under userData/crashes", () => {
      const logPath = getMainCrashLogPath();
      expect(logPath).toBe(path.join(tmpDir, "crashes", "main-crash.log"));
    });

    it("falls back to cwd when app.getPath throws", () => {
      appMock.getPath.mockImplementation(() => {
        throw new Error("not ready");
      });
      const logPath = getMainCrashLogPath();
      expect(logPath).toBe(path.join(process.cwd(), "crashes", "main-crash.log"));
    });
  });

  describe("appendMainCrashLog", () => {
    it("creates the log file if it does not exist", () => {
      appendMainCrashLog("test line\n");
      const logPath = getMainCrashLogPath();
      expect(fs.existsSync(logPath)).toBe(true);
      expect(fs.readFileSync(logPath, "utf8")).toBe("test line\n");
    });

    it("appends to existing log file", () => {
      appendMainCrashLog("line 1\n");
      appendMainCrashLog("line 2\n");
      const logPath = getMainCrashLogPath();
      expect(fs.readFileSync(logPath, "utf8")).toBe("line 1\nline 2\n");
    });

    it("does not throw when fs operations fail", () => {
      appMock.getPath.mockReturnValue("/nonexistent/readonly/path");
      expect(() => appendMainCrashLog("test\n")).not.toThrow();
    });
  });

  describe("emergencyLogMainFatal", () => {
    it("logs Error objects with name, message, and stack", () => {
      const err = new Error("test error");
      err.name = "TestError";
      emergencyLogMainFatal("UNCAUGHT_EXCEPTION", err);

      const logPath = getMainCrashLogPath();
      const content = fs.readFileSync(logPath, "utf8");
      expect(content).toContain("[UNCAUGHT_EXCEPTION]");
      expect(content).toContain('"name":"TestError"');
      expect(content).toContain('"message":"test error"');
      expect(content).toContain('"stack"');
    });

    it("logs non-Error values as string", () => {
      emergencyLogMainFatal("UNHANDLED_REJECTION", "string reason");

      const logPath = getMainCrashLogPath();
      const content = fs.readFileSync(logPath, "utf8");
      expect(content).toContain("[UNHANDLED_REJECTION]");
      expect(content).toContain('"message":"string reason"');
    });

    it("includes process metadata", () => {
      emergencyLogMainFatal("TEST", new Error("test"));

      const logPath = getMainCrashLogPath();
      const content = fs.readFileSync(logPath, "utf8");
      expect(content).toContain(`pid=${process.pid}`);
      expect(content).toContain(`node=${process.version}`);
      expect(content).toContain(`platform=${process.platform}`);
      expect(content).toContain("memory.rss=");
    });
  });
});
