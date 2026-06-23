import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, utimesSync } from "fs";
import {
  initializeLogger,
  getLogFilePath,
  pruneOldLogsAsync,
  pruneHeapSnapshots,
  pruneHeapSnapshotsAsync,
  MAX_HEAP_SNAPSHOTS,
  logInfo,
  logWarn,
  logError,
  getPreviousSessionTail,
  ROTATION_MAX_SIZE,
  ROTATION_MAX_FILES,
  resetLoggerStateForTesting,
  createLogger,
  setLogLevelOverrides,
  getLogLevelOverrides,
  getRegisteredLoggerNames,
  isValidLogOverrideLevel,
  isVerboseLogging,
  setVerboseLogging,
} from "../logger.js";
import { logBuffer } from "../../services/LogBuffer.js";
import {
  setWritesSuppressed,
  resetWritesSuppressedForTesting,
} from "../../services/diskPressureState.js";

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
  resetWritesSuppressedForTesting();
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

  describe("clearDebugLogs", () => {
    it("truncates .log files in debug/ on boot", () => {
      const debugDir = join(TEST_LOG_DIR, "debug");
      mkdirSync(debugDir, { recursive: true });
      const debugFile = join(debugDir, "frame-sequences.log");
      writeFileSync(debugFile, "stale session data\n".repeat(100), "utf8");

      initializeLogger(TEST_LOG_DIR);

      expect(existsSync(debugFile)).toBe(true);
      expect(readFileSync(debugFile, "utf8")).toBe("");
    });

    it("leaves non-.log files in debug/ untouched", () => {
      const debugDir = join(TEST_LOG_DIR, "debug");
      mkdirSync(debugDir, { recursive: true });
      const keepFile = join(debugDir, "snapshot.json");
      writeFileSync(keepFile, '{"keep":true}', "utf8");

      initializeLogger(TEST_LOG_DIR);

      expect(readFileSync(keepFile, "utf8")).toBe('{"keep":true}');
    });

    it("does nothing when debug/ does not exist", () => {
      expect(() => initializeLogger(TEST_LOG_DIR)).not.toThrow();
      expect(existsSync(join(TEST_LOG_DIR, "debug"))).toBe(false);
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

  describe("disk pressure suppression", () => {
    it("does not append to the log file when writes are suppressed", () => {
      initializeLogger(TEST_LOG_DIR);
      const logFile = getLogFilePath();

      logInfo("baseline write before suppression");
      const beforeSize = existsSync(logFile) ? readFileSync(logFile, "utf8").length : 0;
      expect(beforeSize).toBeGreaterThan(0);

      setWritesSuppressed(true);
      logInfo("suppressed entry should not reach disk");
      logWarn("another suppressed entry");

      const afterSize = readFileSync(logFile, "utf8").length;
      expect(afterSize).toBe(beforeSize);
      const content = readFileSync(logFile, "utf8");
      expect(content).not.toContain("suppressed entry should not reach disk");
      expect(content).not.toContain("another suppressed entry");
    });

    it("resumes writing once disk pressure clears", () => {
      initializeLogger(TEST_LOG_DIR);
      const logFile = getLogFilePath();

      setWritesSuppressed(true);
      logInfo("dropped during suppression");

      setWritesSuppressed(false);
      logInfo("written after recovery");

      const content = readFileSync(logFile, "utf8");
      expect(content).not.toContain("dropped during suppression");
      expect(content).toContain("written after recovery");
    });
  });

  describe("createLogger and level overrides", () => {
    beforeEach(() => {
      logBuffer.clear();
    });

    it("routes log.source to the stable logger name", () => {
      const logger = createLogger("main:SampleService");
      setLogLevelOverrides({ "*": "debug" });
      logger.info("hello");
      const entries = logBuffer.getAll();
      expect(entries[entries.length - 1].source).toBe("main:SampleService");
      expect(entries[entries.length - 1].message).toBe("hello");
    });

    it("registers logger names for introspection", () => {
      createLogger("main:Alpha");
      createLogger("main:Beta");
      const names = getRegisteredLoggerNames();
      expect(names).toContain("main:Alpha");
      expect(names).toContain("main:Beta");
    });

    it("exact override takes precedence over wildcards", () => {
      const logger = createLogger("main:Alpha");
      setLogLevelOverrides({ "*": "error", "main:*": "warn", "main:Alpha": "debug" });
      logger.debug("debug1");
      logger.info("info1");
      const entries = logBuffer.getAll();
      const messages = entries.map((e) => e.message);
      expect(messages).toContain("debug1");
      expect(messages).toContain("info1");
    });

    it("process-wildcard override falls back when no exact match", () => {
      const logger = createLogger("main:Beta");
      setLogLevelOverrides({ "*": "error", "main:*": "warn" });
      logger.info("info_should_be_suppressed");
      logger.warn("warn_should_emit");
      const messages = logBuffer.getAll().map((e) => e.message);
      expect(messages).not.toContain("info_should_be_suppressed");
      expect(messages).toContain("warn_should_emit");
    });

    it('"off" level suppresses all messages from a logger', () => {
      const logger = createLogger("main:Silent");
      setLogLevelOverrides({ "main:Silent": "off" });
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");
      const messages = logBuffer.getAll().map((e) => e.message);
      expect(messages).not.toContain("d");
      expect(messages).not.toContain("i");
      expect(messages).not.toContain("w");
      expect(messages).not.toContain("e");
    });

    it("setLogLevelOverrides replaces the whole map atomically", () => {
      setLogLevelOverrides({ "main:A": "debug", "main:B": "warn" });
      expect(getLogLevelOverrides()).toEqual({ "main:A": "debug", "main:B": "warn" });
      setLogLevelOverrides({ "main:C": "error" });
      expect(getLogLevelOverrides()).toEqual({ "main:C": "error" });
      setLogLevelOverrides({});
      expect(getLogLevelOverrides()).toEqual({});
    });

    it("rejects invalid override levels without corrupting the map", () => {
      setLogLevelOverrides({ "main:A": "debug", "main:B": "not-a-level" });
      expect(getLogLevelOverrides()).toEqual({ "main:A": "debug" });
    });

    it("isValidLogOverrideLevel accepts known levels only", () => {
      for (const level of ["debug", "info", "warn", "error", "off"]) {
        expect(isValidLogOverrideLevel(level)).toBe(true);
      }
      expect(isValidLogOverrideLevel("trace")).toBe(false);
      expect(isValidLogOverrideLevel("")).toBe(false);
      expect(isValidLogOverrideLevel(42)).toBe(false);
    });

    it("setVerboseLogging toggles the * wildcard override", () => {
      setLogLevelOverrides({});
      setVerboseLogging(true);
      expect(getLogLevelOverrides()["*"]).toBe("debug");
      expect(isVerboseLogging()).toBe(true);
      setVerboseLogging(false);
      expect(getLogLevelOverrides()["*"]).toBeUndefined();
      expect(isVerboseLogging()).toBe(false);
    });

    it("resetLoggerStateForTesting clears overrides and registry", () => {
      createLogger("main:ShouldClear");
      setLogLevelOverrides({ "main:X": "debug" });
      resetLoggerStateForTesting();
      expect(getLogLevelOverrides()).toEqual({});
      expect(getRegisteredLoggerNames()).not.toContain("main:ShouldClear");
    });
  });

  describe("secret scrubbing at outbound boundaries", () => {
    const GITHUB_PAT = `ghp_${"A".repeat(40)}`;
    const ANTHROPIC_KEY = `sk-ant-${"a".repeat(95)}`;

    it("scrubs secrets in the message before writing to the log file", () => {
      initializeLogger(TEST_LOG_DIR);
      logInfo(`auth header set with token ${GITHUB_PAT}`);

      const content = readFileSync(getLogFilePath(), "utf8");
      expect(content).toContain("[REDACTED]");
      expect(content).not.toContain(GITHUB_PAT);
    });

    it("scrubs secrets that appear in the context payload", () => {
      initializeLogger(TEST_LOG_DIR);
      // SENSITIVE_KEYS doesn't catch arbitrary string fields — pattern scrub is the safety net
      logInfo("request received", { traceLine: `Bearer ${"x".repeat(40)}` });

      const content = readFileSync(getLogFilePath(), "utf8");
      expect(content).toContain("Bearer [REDACTED]");
      expect(content).not.toMatch(/Bearer x{40}/);
    });

    it("scrubs secrets from error.message when logging via logError", () => {
      initializeLogger(TEST_LOG_DIR);
      logError("auth failure", new Error(`bad key ${ANTHROPIC_KEY}`));

      const content = readFileSync(getLogFilePath(), "utf8");
      expect(content).toContain("[REDACTED]");
      expect(content).not.toContain(ANTHROPIC_KEY);
    });
  });

  describe("pruneOldLogsAsync", () => {
    const logsDir = join(TEST_LOG_DIR, "logs");
    const debugDir = join(TEST_LOG_DIR, "debug");
    const DAY_MS = 24 * 60 * 60 * 1000;

    function seedFile(dir: string, name: string, ageDays: number): string {
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, name);
      writeFileSync(filePath, "x");
      const mtimeSeconds = (Date.now() - ageDays * DAY_MS) / 1000;
      utimesSync(filePath, mtimeSeconds, mtimeSeconds);
      return filePath;
    }

    it("deletes files older than the retention window and keeps newer ones", async () => {
      const stale = seedFile(logsDir, "stale.log", 40);
      const fresh = seedFile(logsDir, "fresh.log", 1);
      const staleDebug = seedFile(debugDir, "stale-debug.log", 40);

      await pruneOldLogsAsync(TEST_LOG_DIR, 30);

      expect(existsSync(stale)).toBe(false);
      expect(existsSync(staleDebug)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    });

    it("is a no-op when retentionDays is 0 (retention disabled)", async () => {
      const stale = seedFile(logsDir, "stale.log", 999);

      await pruneOldLogsAsync(TEST_LOG_DIR, 0);

      expect(existsSync(stale)).toBe(true);
    });

    it("resolves without throwing when the log directories don't exist", async () => {
      const missingBase = join(TEST_LOG_DIR, "does-not-exist");
      await expect(pruneOldLogsAsync(missingBase, 30)).resolves.toBeUndefined();
    });

    it("skips non-file entries (subdirectories) without deleting them", async () => {
      const nestedDir = join(logsDir, "archive");
      mkdirSync(nestedDir, { recursive: true });
      // Backdate the directory so an age-only check would target it.
      const oldSeconds = (Date.now() - 40 * DAY_MS) / 1000;
      utimesSync(nestedDir, oldSeconds, oldSeconds);

      await expect(pruneOldLogsAsync(TEST_LOG_DIR, 30)).resolves.toBeUndefined();

      expect(existsSync(nestedDir)).toBe(true);
    });
  });

  describe.each([
    [
      "pruneHeapSnapshots (sync)",
      (dir: string, max: number) => Promise.resolve(pruneHeapSnapshots(dir, max)),
    ],
    ["pruneHeapSnapshotsAsync", (dir: string, max: number) => pruneHeapSnapshotsAsync(dir, max)],
  ])("%s", (_label, prune) => {
    // Heap snapshots land directly in app.getPath("logs"), so the prune target
    // is the dir itself — not a userData base with logs/ + debug/ subdirs.
    const snapDir = join(TEST_LOG_DIR, "heap");
    const MINUTE_MS = 60 * 1000;

    function seedSnapshot(name: string, ageMinutes: number): string {
      mkdirSync(snapDir, { recursive: true });
      const filePath = join(snapDir, name);
      writeFileSync(filePath, "x");
      const mtimeSeconds = (Date.now() - ageMinutes * MINUTE_MS) / 1000;
      utimesSync(filePath, mtimeSeconds, mtimeSeconds);
      return filePath;
    }

    it("keeps the newest maxCount snapshots and deletes the rest", async () => {
      // Ages 1..6 minutes — older = larger ageMinutes.
      const files = Array.from({ length: 6 }, (_, i) =>
        seedSnapshot(`Heap.2026.${i}.heapsnapshot`, i + 1)
      );

      await prune(snapDir, 3);

      // Newest 3 (ages 1,2,3 → indices 0,1,2) survive; oldest 3 deleted.
      expect(existsSync(files[0])).toBe(true);
      expect(existsSync(files[1])).toBe(true);
      expect(existsSync(files[2])).toBe(true);
      expect(existsSync(files[3])).toBe(false);
      expect(existsSync(files[4])).toBe(false);
      expect(existsSync(files[5])).toBe(false);
    });

    it("is a no-op when the snapshot count is at or below maxCount", async () => {
      const a = seedSnapshot("Heap.a.heapsnapshot", 1);
      const b = seedSnapshot("Heap.b.heapsnapshot", 2);

      await prune(snapDir, 3);

      expect(existsSync(a)).toBe(true);
      expect(existsSync(b)).toBe(true);
    });

    it("never touches files without the .heapsnapshot extension", async () => {
      const log = seedSnapshot("daintree.log", 100);
      const looksClose = seedSnapshot("heap.heapsnapshot.log", 100);
      const txt = seedSnapshot("notes.txt", 100);
      // Enough real snapshots to force deletion past maxCount.
      const snaps = Array.from({ length: 4 }, (_, i) =>
        seedSnapshot(`Heap.${i}.heapsnapshot`, i + 1)
      );

      await prune(snapDir, 1);

      // Non-snapshot siblings always survive regardless of age/count.
      expect(existsSync(log)).toBe(true);
      expect(existsSync(looksClose)).toBe(true);
      expect(existsSync(txt)).toBe(true);
      // Only the single newest snapshot remains.
      expect(existsSync(snaps[0])).toBe(true);
      expect(existsSync(snaps[1])).toBe(false);
      expect(existsSync(snaps[2])).toBe(false);
      expect(existsSync(snaps[3])).toBe(false);
    });

    it("ignores subdirectories that end in .heapsnapshot", async () => {
      mkdirSync(snapDir, { recursive: true });
      const dirNamedLikeSnapshot = join(snapDir, "weird.heapsnapshot");
      mkdirSync(dirNamedLikeSnapshot, { recursive: true });
      const realSnaps = Array.from({ length: 3 }, (_, i) =>
        seedSnapshot(`Heap.${i}.heapsnapshot`, i + 1)
      );

      await prune(snapDir, 1);

      expect(existsSync(dirNamedLikeSnapshot)).toBe(true);
      expect(existsSync(realSnaps[0])).toBe(true);
      expect(existsSync(realSnaps[1])).toBe(false);
      expect(existsSync(realSnaps[2])).toBe(false);
    });

    it("is idempotent across repeated runs", async () => {
      const files = Array.from({ length: 5 }, (_, i) =>
        seedSnapshot(`Heap.${i}.heapsnapshot`, i + 1)
      );

      await prune(snapDir, 2);
      await prune(snapDir, 2);

      expect(existsSync(files[0])).toBe(true);
      expect(existsSync(files[1])).toBe(true);
      expect(existsSync(files[2])).toBe(false);
    });

    it("resolves without throwing when the directory does not exist", async () => {
      const missing = join(TEST_LOG_DIR, "no-such-dir");
      await expect(prune(missing, MAX_HEAP_SNAPSHOTS)).resolves.toBeUndefined();
    });

    it("does not delete anything when maxCount is negative", async () => {
      const a = seedSnapshot("Heap.a.heapsnapshot", 1);
      const b = seedSnapshot("Heap.b.heapsnapshot", 2);

      await prune(snapDir, -1);

      expect(existsSync(a)).toBe(true);
      expect(existsSync(b)).toBe(true);
    });
  });
});
