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
  flushLogFileWritesForTesting,
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

afterEach(async () => {
  // Drain any buffered async writes to the test dir before tearing it down so a
  // deferred flush can't race the cleanup and write to a fallback path.
  await flushLogFileWritesForTesting();
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
    it("does not rotate when file size is below threshold", async () => {
      initializeLogger(TEST_LOG_DIR);
      logInfo("Small log entry");
      await flushLogFileWritesForTesting();

      const logFile = getLogFilePath();
      expect(existsSync(logFile)).toBe(true);
      expect(existsSync(join(TEST_LOG_DIR, "logs", "daintree.log.1"))).toBe(false);
    });

    it("rotates log file when size exceeds threshold", async () => {
      const logFile = join(TEST_LOG_DIR, "logs", "daintree.log");
      mkdirSync(join(TEST_LOG_DIR, "logs"), { recursive: true });
      const largeLine = `[2026-01-01T00:00:00.000Z] [INFO] ${"x".repeat(1024)}`;
      const lines = Array.from({ length: ROTATION_MAX_SIZE / 1024 + 100 }, () => largeLine).join(
        "\n"
      );
      writeFileSync(logFile, lines, "utf8");

      initializeLogger(TEST_LOG_DIR);
      logInfo("This should trigger rotation");
      await flushLogFileWritesForTesting();

      expect(existsSync(logFile)).toBe(true);
      const rotatedFile = join(TEST_LOG_DIR, "logs", "daintree.log.1");
      expect(existsSync(rotatedFile)).toBe(true);

      const rotatedContent = readFileSync(rotatedFile, "utf8");
      expect(rotatedContent.length).toBeGreaterThan(ROTATION_MAX_SIZE);

      const currentContent = readFileSync(logFile, "utf8");
      expect(currentContent).toContain("This should trigger rotation");
    });

    it("shuffles rotated files correctly", async () => {
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
      await flushLogFileWritesForTesting();

      expect(existsSync(join(TEST_LOG_DIR, "logs", "daintree.log.1"))).toBe(true);
      expect(existsSync(join(TEST_LOG_DIR, "logs", "daintree.log.2"))).toBe(true);
      expect(existsSync(join(TEST_LOG_DIR, "logs", "daintree.log.3"))).toBe(true);
      expect(existsSync(join(TEST_LOG_DIR, "logs", "daintree.log.4"))).toBe(true);

      const file2Content = readFileSync(join(TEST_LOG_DIR, "logs", "daintree.log.2"), "utf8");
      expect(file2Content).toContain("Rotated file 1");

      const file3Content = readFileSync(join(TEST_LOG_DIR, "logs", "daintree.log.3"), "utf8");
      expect(file3Content).toContain("Rotated file 2");
    });

    it("deletes oldest rotated file when max files exceeded", async () => {
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
      await flushLogFileWritesForTesting();

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
    it("does not append to the log file when writes are suppressed", async () => {
      initializeLogger(TEST_LOG_DIR);
      const logFile = getLogFilePath();

      logInfo("baseline write before suppression");
      await flushLogFileWritesForTesting();
      const beforeSize = existsSync(logFile) ? readFileSync(logFile, "utf8").length : 0;
      expect(beforeSize).toBeGreaterThan(0);

      setWritesSuppressed(true);
      logInfo("suppressed entry should not reach disk");
      logWarn("another suppressed entry");
      await flushLogFileWritesForTesting();

      const afterSize = readFileSync(logFile, "utf8").length;
      expect(afterSize).toBe(beforeSize);
      const content = readFileSync(logFile, "utf8");
      expect(content).not.toContain("suppressed entry should not reach disk");
      expect(content).not.toContain("another suppressed entry");
    });

    it("resumes writing once disk pressure clears", async () => {
      initializeLogger(TEST_LOG_DIR);
      const logFile = getLogFilePath();

      setWritesSuppressed(true);
      logInfo("dropped during suppression");

      setWritesSuppressed(false);
      logInfo("written after recovery");
      await flushLogFileWritesForTesting();

      const content = readFileSync(logFile, "utf8");
      expect(content).not.toContain("dropped during suppression");
      expect(content).toContain("written after recovery");
    });
  });

  describe("async batched file writes (#10769)", () => {
    it("buffers non-error lines until flushed", async () => {
      initializeLogger(TEST_LOG_DIR);
      const logFile = getLogFilePath();

      logInfo("buffered line");
      // Not yet on disk — the write is deferred off the synchronous hot path.
      const beforeFlush = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
      expect(beforeFlush).not.toContain("buffered line");

      await flushLogFileWritesForTesting();
      expect(readFileSync(logFile, "utf8")).toContain("buffered line");
    });

    it("writes error lines synchronously without a flush (crash safety)", () => {
      initializeLogger(TEST_LOG_DIR);
      const logFile = getLogFilePath();

      logError("immediate error", new Error("boom"));
      // Readable right away — errors bypass the async buffer.
      expect(readFileSync(logFile, "utf8")).toContain("immediate error");
    });

    it("flushes buffered lines ahead of a synchronous error so on-disk order matches emit order", () => {
      initializeLogger(TEST_LOG_DIR);
      const logFile = getLogFilePath();

      logInfo("first buffered");
      logError("then error", new Error("boom"));
      // The error path drains the buffer before its own sync write.
      const content = readFileSync(logFile, "utf8");
      expect(content).toContain("first buffered");
      expect(content).toContain("then error");
      expect(content.indexOf("first buffered")).toBeLessThan(content.indexOf("then error"));
    });

    it("flushes buffered lines via the scheduled setImmediate (not just the test helper)", async () => {
      initializeLogger(TEST_LOG_DIR);
      const logFile = getLogFilePath();

      logInfo("scheduled line");
      // Poll for the write to land without calling the test-only drain — proves
      // the production setImmediate→drain scheduling path actually writes. The
      // async appendFile completes off the threadpool, so its arrival isn't
      // bounded by a fixed number of ticks; poll until it shows up.
      const deadline = Date.now() + 2000;
      let content = "";
      while (Date.now() < deadline) {
        content = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
        if (content.includes("scheduled line")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(content).toContain("scheduled line");
    });

    it("coalesces a burst of lines into the file after a single flush", async () => {
      initializeLogger(TEST_LOG_DIR);
      const logFile = getLogFilePath();

      for (let i = 0; i < 50; i++) {
        logInfo(`burst line ${i}`);
      }
      await flushLogFileWritesForTesting();

      const content = readFileSync(logFile, "utf8");
      expect(content).toContain("burst line 0");
      expect(content).toContain("burst line 49");
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

    it("scrubs secrets in the message before writing to the log file", async () => {
      initializeLogger(TEST_LOG_DIR);
      logInfo(`auth header set with token ${GITHUB_PAT}`);
      await flushLogFileWritesForTesting();

      const content = readFileSync(getLogFilePath(), "utf8");
      expect(content).toContain("[REDACTED]");
      expect(content).not.toContain(GITHUB_PAT);
    });

    it("scrubs secrets that appear in the context payload", async () => {
      initializeLogger(TEST_LOG_DIR);
      // SENSITIVE_KEYS doesn't catch arbitrary string fields — pattern scrub is the safety net
      logInfo("request received", { traceLine: `Bearer ${"x".repeat(40)}` });
      await flushLogFileWritesForTesting();

      const content = readFileSync(getLogFilePath(), "utf8");
      expect(content).toContain("Bearer [REDACTED]");
      expect(content).not.toMatch(/Bearer x{40}/);
    });

    it("scrubs secrets from error.message when logging via logError", () => {
      initializeLogger(TEST_LOG_DIR);
      // Errors are written synchronously (crash-safety path) — no flush needed.
      logError("auth failure", new Error(`bad key ${ANTHROPIC_KEY}`));

      const content = readFileSync(getLogFilePath(), "utf8");
      expect(content).toContain("[REDACTED]");
      expect(content).not.toContain(ANTHROPIC_KEY);
    });

    it("does not leak a secret straddling the context string-length cap", async () => {
      initializeLogger(TEST_LOG_DIR);
      // Place a recognizable GitHub PAT so its BODY straddles the 2000-char
      // clamp boundary: 1979 filler chars + a space (the `\b` the pattern's
      // leading anchor needs) put `ghp_` at char 1980, so the 40-char body
      // occupies chars 1984–2023 and the cut at char 2000 lands ~16 chars into
      // the token. If the clamp ran before content-scrubbing, truncation would
      // sever the high-entropy tail and leave a `ghp_AAA…` prefix too short for
      // the scrubber to match — leaking the secret's leading bytes. Scrub-
      // before-clamp must redact the whole token first, so neither the full
      // token nor any recognizable prefix survives.
      const token = `ghp_${"A".repeat(40)}`;
      logInfo("long trace", { traceLine: `${"x".repeat(1979)} ${token}` });
      await flushLogFileWritesForTesting();

      const content = readFileSync(getLogFilePath(), "utf8");
      // The full token must never appear on disk.
      expect(content).not.toContain(token);
      // Nor may any leading prefix of the secret survive the clamp: the
      // `ghp_` sigil and the body bytes preceding the cut must be gone, not
      // merely the dropped tail. A surviving `ghp_AAA…` prefix is the leak.
      expect(content).not.toMatch(/ghp_A+/);
      // The scrubber ran on the value before truncation, redacting the secret.
      expect(content).toContain("[REDACTED]");
    });

    it("preserves merged context fields while redacting sensitive keys in logError", () => {
      initializeLogger(TEST_LOG_DIR);
      logError("request failed", new Error("boom"), { requestId: "r1", token: "secret123" });

      const content = readFileSync(getLogFilePath(), "utf8");
      // Legitimate context survives the emitError dedup...
      expect(content).toContain("r1");
      expect(content).toContain("boom");
      // ...and the sensitive key is still redacted, never raw.
      expect(content).not.toContain("secret123");
      expect(content).toContain("[redacted]");
    });
  });

  describe("redactSensitiveData bounds", () => {
    beforeEach(() => {
      logBuffer.clear();
    });

    function lastContext(): Record<string, unknown> | undefined {
      const entries = logBuffer.getAll();
      return entries[entries.length - 1]?.context as Record<string, unknown> | undefined;
    }

    it("truncates long string values and the dropped count accounts for the whole string", () => {
      const original = "a".repeat(5000);
      logInfo("trace captured", { stack: original });

      const stack = lastContext()?.stack as string;
      const match = stack.match(/^(a+)\[…\+(\d+)\]$/);
      expect(match).not.toBeNull();
      const keptLength = match![1].length;
      const dropped = Number(match![2]);
      // Invariant: kept prefix + reported dropped count === original length.
      expect(keptLength + dropped).toBe(original.length);
      expect(stack.length).toBeLessThan(original.length);
    });

    it("leaves short string values untouched", () => {
      logInfo("ok", { note: "short value" });
      expect(lastContext()?.note).toBe("short value");
    });

    it("replaces objects nested beyond the depth limit with a sentinel", () => {
      let node: Record<string, unknown> = { leaf: "value" };
      for (let i = 0; i < 12; i++) {
        node = { child: node };
      }
      logInfo("deep", node);

      // Walk down until the recursion was cut; the sentinel must appear before
      // we reach the original 12-deep leaf.
      let current: unknown = lastContext();
      let walked = 0;
      while (
        current !== null &&
        typeof current === "object" &&
        "child" in (current as Record<string, unknown>)
      ) {
        current = (current as Record<string, unknown>).child;
        walked++;
        if (walked > 20) break;
      }
      expect(current).toBe("[MaxDepth]");
      expect(walked).toBeLessThan(12);
    });

    it("caps long arrays and the remaining-count marker matches what was dropped", () => {
      const items = Array.from({ length: 50 }, (_, i) => `item-${i}`);
      logInfo("list", { items });

      const capped = lastContext()?.items as unknown[];
      const marker = capped[capped.length - 1] as string;
      const match = marker.match(/^\[\.\.\.(\d+) more\]$/);
      expect(match).not.toBeNull();
      const dropped = Number(match![1]);
      const kept = capped.length - 1;
      // Invariant: kept items + reported dropped count === original length.
      expect(kept + dropped).toBe(items.length);
      expect(capped.length).toBeLessThan(items.length);
    });

    it("truncates long string values inside arrays", () => {
      const original = "b".repeat(5000);
      logInfo("array strings", { lines: [original] });

      const lines = lastContext()?.lines as string[];
      expect(lines[0]).toMatch(/^b+\[…\+\d+\]$/);
      expect(lines[0].length).toBeLessThan(original.length);
    });

    it("still redacts sensitive keys even when their value is long", () => {
      logInfo("auth", { token: "x".repeat(5000) });
      expect(lastContext()?.token).toBe("[redacted]");
    });

    it("stops recursion through deeply nested arrays without overflowing", () => {
      let value: unknown = "leaf";
      for (let i = 0; i < 20; i++) {
        value = [value];
      }
      expect(() => logInfo("nested arrays", { value })).not.toThrow();

      // Walk down the nested arrays; the sentinel must appear before the leaf.
      let current: unknown = lastContext()?.value;
      let walked = 0;
      while (Array.isArray(current) && current[0] !== "[MaxDepth]") {
        current = current[0];
        walked++;
        if (walked > 30) break;
      }
      expect(Array.isArray(current) ? current[0] : current).toBe("[MaxDepth]");
      expect(walked).toBeLessThan(20);
    });

    it("keeps an array at the exact cap whole but marks one beyond it", () => {
      logInfo("at cap", { items: Array.from({ length: 20 }, (_, i) => i) });
      const atCap = lastContext()?.items as unknown[];
      expect(atCap).toHaveLength(20);
      expect(atCap[atCap.length - 1]).toBe(19);

      logBuffer.clear();
      logInfo("over cap", { items: Array.from({ length: 21 }, (_, i) => i) });
      const overCap = lastContext()?.items as unknown[];
      expect(overCap).toHaveLength(21);
      expect(overCap[overCap.length - 1]).toBe("[...1 more]");
    });

    it("keeps a string at the exact char cap but marks one beyond it", () => {
      logInfo("at cap", { note: "a".repeat(2000) });
      expect(lastContext()?.note).toBe("a".repeat(2000));

      logBuffer.clear();
      logInfo("over cap", { note: "a".repeat(2001) });
      expect(lastContext()?.note).toBe(`${"a".repeat(2000)}[…+1]`);
    });
  });

  describe("Errors inside a log context (#11777)", () => {
    beforeEach(() => {
      logBuffer.clear();
    });

    function lastContext(): Record<string, unknown> | undefined {
      const entries = logBuffer.getAll();
      return entries[entries.length - 1]?.context as Record<string, unknown> | undefined;
    }

    it("keeps the identity of an Error passed at a non-error level", () => {
      const error = new TypeError("wake failed");
      logWarn("wake failed", { id: "terminal-1", error });

      const captured = lastContext()?.error as Record<string, unknown>;
      // Own-property enumeration alone yields `{}` — that was the bug.
      expect(Object.keys(error)).toHaveLength(0);
      expect(captured.name).toBe(error.name);
      expect(captured.message).toBe(error.message);
      expect(captured.stack).toBeTypeOf("string");
    });

    it("reaches Errors nested in objects and inside arrays", () => {
      logWarn("batch failed", {
        task: { error: new Error("nested failure") },
        failures: [new Error("listed failure")],
      });

      const context = lastContext() ?? {};
      const task = context.task as { error: Record<string, unknown> };
      expect(task.error.message).toBe("nested failure");
      const failures = context.failures as Array<Record<string, unknown>>;
      expect(failures[0]?.message).toBe("listed failure");
    });

    it("preserves the cause chain of a wrapped Error", () => {
      const error = new Error("outer", { cause: new Error("root cause") });
      logWarn("wrapped", { error });

      const captured = lastContext()?.error as { cause?: { message?: string } };
      expect(captured.cause?.message).toBe("root cause");
    });

    it("still redacts an Error stored under a sensitive key", () => {
      logWarn("auth", { apiKey: new Error("s3cret-in-the-message") });
      expect(lastContext()?.apiKey).toBe("[redacted]");
    });

    it("clamps a long stack instead of retaining it whole", () => {
      const error = new Error("long trace");
      error.stack = `Error: long trace\n${"    at frame\n".repeat(1000)}`;
      logWarn("long", { error });

      const captured = lastContext()?.error as { stack: string };
      expect(captured.stack.length).toBeLessThan(error.stack.length);
      const match = captured.stack.match(/\[…\+(\d+)\]$/);
      expect(match).not.toBeNull();
      // Invariant: the kept prefix plus the reported dropped count is the whole
      // stack, so nothing is silently unaccounted for.
      const dropped = Number(match![1]);
      const kept = captured.stack.length - match![0].length;
      expect(kept + dropped).toBe(error.stack.length);
    });

    it("scrubs a secret out of a stack before it is clamped", () => {
      const secret = `ghp_${"b".repeat(36)}`;
      const error = new Error("token leak");
      error.stack = `Error: token leak\n    at auth (${secret})\n${"    at frame\n".repeat(500)}`;
      logWarn("leaky", { error });

      const captured = lastContext()?.error as { stack: string };
      expect(captured.stack).not.toContain(secret);
    });

    it("does not throw on an Error whose cause chain is circular", () => {
      const first = new Error("first");
      const second = new Error("second", { cause: first });
      (first as Error & { cause?: unknown }).cause = second;

      expect(() => logWarn("cyclic", { error: first })).not.toThrow();
      expect((lastContext()?.error as { message?: string }).message).toBe("first");
    });

    it("writes the flattened Error to the log file, not an empty object", async () => {
      initializeLogger(TEST_LOG_DIR);
      logWarn("disk trace", { error: new Error("landed-on-disk") });
      await flushLogFileWritesForTesting();

      const content = readFileSync(getLogFilePath(), "utf8");
      expect(content).toContain("landed-on-disk");
      expect(content).not.toContain('"error": {}');
    });

    it("keeps name and stack when an already-flattened error arrives from the renderer", () => {
      // `dispatchRendererLog` forwards `context.error` — a plain object by the
      // time it crosses the contextBridge — as logError's dedicated argument.
      const fromRenderer = {
        name: "TypeError",
        message: "renderer failure",
        stack: "TypeError: renderer failure\n    at Component",
      };
      logError("renderer said", fromRenderer, { source: "Renderer" });

      const captured = lastContext()?.error as Record<string, unknown>;
      expect(captured.name).toBe(fromRenderer.name);
      expect(captured.message).toBe(fromRenderer.message);
      expect(captured.stack).toBe(fromRenderer.stack);
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
