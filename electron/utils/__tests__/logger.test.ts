import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import {
  initializeLogger,
  getLogFilePath,
  logInfo,
  logWarn,
  logError,
  getPreviousSessionTail,
  ROTATION_MAX_SIZE,
  ROTATION_MAX_FILES,
  resetLoggerStateForTesting,
} from "../logger.js";

const TEST_LOG_DIR = join(process.cwd(), "test-logs");

function cleanupTestLogs() {
  if (existsSync(TEST_LOG_DIR)) {
    try {
      rmSync(TEST_LOG_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

beforeEach(() => {
  resetLoggerStateForTesting();
  cleanupTestLogs();
  mkdirSync(TEST_LOG_DIR, { recursive: true });
  process.env.DAINTREE_USER_DATA = TEST_LOG_DIR;
});

afterEach(() => {
  resetLoggerStateForTesting();
  delete process.env.DAINTREE_USER_DATA;
  cleanupTestLogs();
});

describe("logger", () => {
  describe("preservePreviousSessionTail", () => {
    it("captures tail from existing log file", () => {
      const logFile = join(TEST_LOG_DIR, "logs", "daintree.log");
      mkdirSync(join(TEST_LOG_DIR, "logs"), { recursive: true });
      const logLines = Array.from(
        { length: 150 },
        (_, i) => `[2026-01-01T00:00:00.000Z] [INFO] Log line ${i + 1}`
      ).join("\n");
      writeFileSync(logFile, logLines, "utf8");

      initializeLogger(TEST_LOG_DIR);

      const tail = getPreviousSessionTail();
      expect(tail).toBeTruthy();
      const tailLines = tail?.split("\n").filter((line) => line.trim() !== "");
      expect(tailLines?.length).toBe(100);
      expect(tailLines?.[0]).toContain("Log line 51");
      expect(tailLines?.[tailLines.length - 1]).toContain("Log line 150");
    });

    it("returns null when log file does not exist", () => {
      cleanupTestLogs();
      mkdirSync(TEST_LOG_DIR, { recursive: true });
      initializeLogger(TEST_LOG_DIR);
      expect(getPreviousSessionTail()).toBeNull();
    });

    it("returns null when log file is empty", () => {
      const logFile = join(TEST_LOG_DIR, "logs", "daintree.log");
      mkdirSync(join(TEST_LOG_DIR, "logs"), { recursive: true });
      writeFileSync(logFile, "", "utf8");

      initializeLogger(TEST_LOG_DIR);
      expect(getPreviousSessionTail()).toBeNull();
    });

    it("handles files smaller than tail limit", () => {
      const logFile = join(TEST_LOG_DIR, "logs", "daintree.log");
      mkdirSync(join(TEST_LOG_DIR, "logs"), { recursive: true });
      const logLines = Array.from(
        { length: 10 },
        (_, i) => `[2026-01-01T00:00:00.000Z] [INFO] Log line ${i + 1}`
      ).join("\n");
      writeFileSync(logFile, logLines, "utf8");

      initializeLogger(TEST_LOG_DIR);

      const tail = getPreviousSessionTail();
      expect(tail).toBeTruthy();
      const tailLines = tail?.split("\n").filter((line) => line.trim() !== "");
      expect(tailLines?.length).toBe(10);
    });
  });

  describe("rotateLogsIfNeeded", () => {
    it("does not rotate when file size is below threshold", () => {
      initializeLogger(TEST_LOG_DIR);
      logInfo("Small log entry");

      const logFile = getLogFilePath();
      expect(existsSync(logFile)).toBe(true);
      expect(existsSync(join(TEST_LOG_DIR, "logs", "daintree.log.1"))).toBe(false);
    });

    it("rotates log file when size exceeds threshold", () => {
      const logFile = join(TEST_LOG_DIR, "logs", "daintree.log");
      mkdirSync(join(TEST_LOG_DIR, "logs"), { recursive: true });
      const largeLine = `[2026-01-01T00:00:00.000Z] [INFO] ${"x".repeat(1024)}`;
      const lines = Array.from({ length: ROTATION_MAX_SIZE / 1024 + 100 }, () => largeLine).join(
        "\n"
      );
      writeFileSync(logFile, lines, "utf8");

      initializeLogger(TEST_LOG_DIR);
      logInfo("This should trigger rotation");

      expect(existsSync(logFile)).toBe(true);
      const rotatedFile = join(TEST_LOG_DIR, "logs", "daintree.log.1");
      expect(existsSync(rotatedFile)).toBe(true);

      const rotatedContent = readFileSync(rotatedFile, "utf8");
      expect(rotatedContent.length).toBeGreaterThan(ROTATION_MAX_SIZE);

      const currentContent = readFileSync(logFile, "utf8");
      expect(currentContent).toContain("This should trigger rotation");
    });

    it("shuffles rotated files correctly", () => {
      const logFile = join(TEST_LOG_DIR, "logs", "daintree.log");
      mkdirSync(join(TEST_LOG_DIR, "logs"), { recursive: true });
      const largeLine = `[2026-01-01T00:00:00.000Z] [INFO] ${"x".repeat(1024)}`;
      const lines = Array.from({ length: ROTATION_MAX_SIZE / 1024 + 100 }, () => largeLine).join(
        "\n"
      );

      writeFileSync(logFile, lines, "utf8");
      for (let i = 1; i <= 3; i++) {
        writeFileSync(join(TEST_LOG_DIR, "logs", `daintree.log.${i}`), `Rotated file ${i}`, "utf8");
      }

      initializeLogger(TEST_LOG_DIR);
      logInfo("Trigger rotation");

      expect(existsSync(join(TEST_LOG_DIR, "logs", "daintree.log.1"))).toBe(true);
      expect(existsSync(join(TEST_LOG_DIR, "logs", "daintree.log.2"))).toBe(true);
      expect(existsSync(join(TEST_LOG_DIR, "logs", "daintree.log.3"))).toBe(true);
      expect(existsSync(join(TEST_LOG_DIR, "logs", "daintree.log.4"))).toBe(true);

      const file2Content = readFileSync(join(TEST_LOG_DIR, "logs", "daintree.log.2"), "utf8");
      expect(file2Content).toContain("Rotated file 1");

      const file3Content = readFileSync(join(TEST_LOG_DIR, "logs", "daintree.log.3"), "utf8");
      expect(file3Content).toContain("Rotated file 2");
    });

    it("deletes oldest rotated file when max files exceeded", () => {
      const logFile = join(TEST_LOG_DIR, "logs", "daintree.log");
      mkdirSync(join(TEST_LOG_DIR, "logs"), { recursive: true });
      const largeLine = `[2026-01-01T00:00:00.000Z] [INFO] ${"x".repeat(1024)}`;
      const lines = Array.from({ length: ROTATION_MAX_SIZE / 1024 + 100 }, () => largeLine).join(
        "\n"
      );

      writeFileSync(logFile, lines, "utf8");
      for (let i = 1; i <= ROTATION_MAX_FILES; i++) {
        writeFileSync(join(TEST_LOG_DIR, "logs", `daintree.log.${i}`), `Rotated file ${i}`, "utf8");
      }

      initializeLogger(TEST_LOG_DIR);
      logInfo("Trigger rotation");

      expect(existsSync(join(TEST_LOG_DIR, "logs", `daintree.log.${ROTATION_MAX_FILES + 1}`))).toBe(
        false
      );
    });

    it("handles errors during rotation gracefully", () => {
      initializeLogger(TEST_LOG_DIR);
      logInfo("Test log");
      logWarn("Warning log");
      logError("Error log", new Error("Test error"));

      expect(getLogFilePath()).toBeTruthy();
    });
  });
});
