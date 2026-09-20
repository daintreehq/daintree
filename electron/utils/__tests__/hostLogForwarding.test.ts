/**
 * #12544 — a structured host event must produce exactly one file record.
 *
 * Both utility hosts and Main append to the same `daintree.log`. The host
 * writes its own entry (synchronously for errors, so it survives a crash) and
 * hands Main a typed copy over the host event channel; Main mirrors that copy
 * into its buffer and the renderer without writing it again. These tests drive
 * a real logger module in each role against one real log directory, so the
 * "one record" claim is read back off disk rather than asserted on a spy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import type { HostLogEvent } from "../../../shared/types/host-log.js";

const TEST_LOG_DIR = join(process.cwd(), "test-logs-host-forwarding");

type LoggerModule = typeof import("../logger.js");

/**
 * Every logger instance loaded during a test. `vi.resetModules()` hands each
 * role its own module (and its own write buffer), so a later import would
 * flush the wrong one — they have to be drained by reference.
 */
const loaded: LoggerModule[] = [];

/** Physical lines are not records — a pretty-printed context spans several. */
const RECORD_PREFIX = /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[(DEBUG|INFO|WARN|ERROR)\] /;

function readLogFile(): string {
  const file = join(TEST_LOG_DIR, "logs", "daintree.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function readRecords(): string[] {
  return readLogFile()
    .split("\n")
    .filter((line) => RECORD_PREFIX.test(line));
}

function recordsMatching(marker: string): string[] {
  return readRecords().filter((line) => line.includes(marker));
}

/** Load a fresh logger module that believes it runs inside a utility host. */
async function loadHostLogger(
  kind: "pty-host" | "workspace-host",
  postMessage: (value: unknown) => void
): Promise<LoggerModule> {
  vi.resetModules();
  Object.defineProperty(process, "parentPort", {
    value: { postMessage },
    configurable: true,
    writable: true,
  });
  process.env.DAINTREE_UTILITY_PROCESS_KIND = kind;
  const logger = await import("../logger.js");
  logger.initializeLogger(TEST_LOG_DIR);
  loaded.push(logger);
  return logger;
}

/** Load a fresh logger module that believes it is the main process. */
async function loadMainLogger(): Promise<LoggerModule> {
  vi.resetModules();
  delete (process as { parentPort?: unknown }).parentPort;
  delete process.env.DAINTREE_UTILITY_PROCESS_KIND;
  const logger = await import("../logger.js");
  logger.initializeLogger(TEST_LOG_DIR);
  loaded.push(logger);
  return logger;
}

function captureSentEvents(): { events: HostLogEvent[]; postMessage: (value: unknown) => void } {
  const events: HostLogEvent[] = [];
  return {
    events,
    postMessage: (value) => {
      events.push(value as HostLogEvent);
    },
  };
}

beforeEach(() => {
  rmSync(TEST_LOG_DIR, { recursive: true, force: true });
  mkdirSync(TEST_LOG_DIR, { recursive: true });
  // Both roles resolve the same file — a host through the environment, main
  // through `initializeLogger`. That shared target is the whole premise.
  process.env.DAINTREE_USER_DATA = TEST_LOG_DIR;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const logger of loaded) {
    await logger.flushLogFileWritesForTesting();
    logger.resetLoggerStateForTesting();
  }
  loaded.length = 0;
  vi.restoreAllMocks();
  delete (process as { parentPort?: unknown }).parentPort;
  delete process.env.DAINTREE_UTILITY_PROCESS_KIND;
  delete process.env.DAINTREE_USER_DATA;
  rmSync(TEST_LOG_DIR, { recursive: true, force: true });
  vi.resetModules();
});

describe("structured host log forwarding (#12544)", () => {
  for (const kind of ["workspace-host", "pty-host"] as const) {
    describe(kind, () => {
      it("writes one file record and sends the entry to main instead of the console", async () => {
        const { events, postMessage } = captureSentEvents();
        const host = await loadHostLogger(kind, postMessage);

        host
          .createLogger(`${kind}:Test`)
          .info("PR detected for worktree MARKER_ONE", { worktree: "feature/x", prNumber: 42 });
        await host.flushLogFileWritesForTesting();

        expect(recordsMatching("MARKER_ONE")).toHaveLength(1);
        // The console mirror is what Main used to line-scrape back into a
        // second record; a managed host must not produce it at all.
        expect(console.log).not.toHaveBeenCalled();

        expect(events).toHaveLength(1);
        expect(events[0].type).toBe("log");
        expect(events[0].level).toBe("info");
        expect(events[0].source).toBe(`${kind}:Test`);
        expect(events[0].message).toBe("PR detected for worktree MARKER_ONE");
        expect(JSON.parse(events[0].contextJson!)).toEqual({
          worktree: "feature/x",
          prNumber: 42,
        });
      });

      it("ingesting the entry in main adds no second record but does reach the buffer", async () => {
        const { events, postMessage } = captureSentEvents();
        const host = await loadHostLogger(kind, postMessage);
        host
          .createLogger(`${kind}:Test`)
          .info("Graceful shutdown capture outcome MARKER_TWO", { captured: 3, drained: true });
        await host.flushLogFileWritesForTesting();
        expect(recordsMatching("MARKER_TWO")).toHaveLength(1);

        const main = await loadMainLogger();
        const broadcasts: unknown[][] = [];
        main.registerLoggerTransport(
          (_channel, ...args) => broadcasts.push(args),
          () => true
        );
        const { logBuffer } = await import("../../services/LogBuffer.js");

        main.ingestHostLogEvent(events[0]);
        await main.flushLogFileWritesForTesting();

        // The acceptance criterion: still exactly one record, and its JSON
        // context produced no extra records of its own — the expanded context
        // lines belong to that one record, they are not records themselves.
        expect(recordsMatching("MARKER_TWO")).toHaveLength(1);
        expect(recordsMatching("captured")).toHaveLength(0);
        expect(readLogFile()).toContain('"captured": 3');

        const ingested = logBuffer.getAll().filter((e) => e.message.includes("MARKER_TWO"));
        expect(ingested).toHaveLength(1);
        expect(ingested[0].level).toBe("info");
        expect(ingested[0].source).toBe(`${kind}:Test`);
        // Structured context survives as an object, not flattened into text.
        expect(ingested[0].context).toEqual({ captured: 3, drained: true });
        expect(ingested[0].timestamp).toBe(events[0].timestamp);
      });
    });
  }

  it("keeps two genuinely repeated events as two records", async () => {
    const { events, postMessage } = captureSentEvents();
    const host = await loadHostLogger("workspace-host", postMessage);
    const log = host.createLogger("workspace-host:Test");

    log.info("Graceful capture drain ended MARKER_REPEAT", { attempt: 1 });
    log.info("Graceful capture drain ended MARKER_REPEAT", { attempt: 1 });
    await host.flushLogFileWritesForTesting();

    expect(recordsMatching("MARKER_REPEAT")).toHaveLength(2);
    expect(events).toHaveLength(2);
  });

  it("writes an error to disk before the entry is handed to main", async () => {
    let recordsAtSendTime: string[] = [];
    const host = await loadHostLogger("pty-host", () => {
      recordsAtSendTime = recordsMatching("MARKER_ERROR");
    });

    host.createLogger("pty-host:Test").error("Host died MARKER_ERROR", new Error("boom"));

    // Errors are written synchronously so they survive a crash — the send must
    // not be able to get ahead of that write.
    expect(recordsAtSendTime).toHaveLength(1);
  });

  it("does not fall back to the console when the send throws", async () => {
    const host = await loadHostLogger("workspace-host", () => {
      throw new Error("parent port is gone");
    });

    expect(() =>
      host.createLogger("workspace-host:Test").warn("MARKER_THROW", { a: 1 })
    ).not.toThrow();
    await host.flushLogFileWritesForTesting();

    // The file record is the surviving copy. Echoing to the console here would
    // put the duplicate back precisely while main is still draining stdout.
    expect(recordsMatching("MARKER_THROW")).toHaveLength(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("keeps the console mirror for main and for a host running without a parent", async () => {
    const main = await loadMainLogger();
    main.createLogger("main:Test").info("MARKER_MAIN");
    await main.flushLogFileWritesForTesting();

    // `detectProcessTag` keys off `parentPort`, so a host started standalone
    // reports "main" and keeps its console output rather than posting into
    // the void.
    expect(console.log).toHaveBeenCalled();
    expect(recordsMatching("MARKER_MAIN")).toHaveLength(1);
  });

  it("preserves a context that does not parse back to an object", async () => {
    const main = await loadMainLogger();
    const { logBuffer } = await import("../../services/LogBuffer.js");

    main.ingestHostLogEvent({
      type: "log",
      timestamp: Date.now(),
      level: "warn",
      source: "pty-host:Test",
      message: "MARKER_BAD_CONTEXT",
      contextJson: "[Unable to stringify: TypeError]",
    });

    const entry = logBuffer.getAll().find((e) => e.message === "MARKER_BAD_CONTEXT");
    // Malformed context is still evidence — kept verbatim rather than dropped.
    expect(entry?.context).toEqual({ serializedContext: "[Unable to stringify: TypeError]" });
  });

  it("builds a cloneable envelope from a context holding a function", async () => {
    const { events, postMessage } = captureSentEvents();
    const host = await loadHostLogger("pty-host", postMessage);

    host.createLogger("pty-host:Test").info("MARKER_FN", {
      callback: () => "nope",
      id: "t1",
    });

    expect(events).toHaveLength(1);
    // A raw object would throw on postMessage (#1232); the wire carries the
    // already-stringified context instead, so every field is a primitive.
    expect(typeof events[0].contextJson).toBe("string");
    expect(() => structuredClone(events[0])).not.toThrow();
    expect(JSON.parse(events[0].contextJson!).id).toBe("t1");
  });

  it("ingests without re-applying main's level overrides", async () => {
    const main = await loadMainLogger();
    const { logBuffer } = await import("../../services/LogBuffer.js");
    // The host already made the level decision using main's replayed
    // overrides; filtering again here could only discard an accepted entry.
    main.setLogLevelOverrides({ "*": "error" });

    main.ingestHostLogEvent({
      type: "log",
      timestamp: Date.now(),
      level: "debug",
      source: "workspace-host:Test",
      message: "MARKER_DEBUG",
    });

    expect(logBuffer.getAll().some((e) => e.message === "MARKER_DEBUG")).toBe(true);
  });
});
