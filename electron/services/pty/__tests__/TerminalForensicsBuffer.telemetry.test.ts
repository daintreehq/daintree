/**
 * #15558 — an agent's crash tail must never reach a Sentry event.
 *
 * Drives the real chain end to end: a pty-host-role logger, event bus and
 * exit observers handle a natural agent exit; everything the host sends its
 * parent (piped stdio and parent-port messages) is replayed into a real
 * `PtyHostLifecycle` feeding a main-role logger; every console call Main makes
 * becomes a breadcrumb the way Sentry's console integration builds one; and
 * the telemetry service's own `beforeBreadcrumb` and `beforeSend` hooks decide
 * what would be sent and what the telemetry preview shows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import { format } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import type { TerminalInfo } from "../types.js";

const shared = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("events") as typeof import("events");
  const appMock = Object.assign(new EventEmitter(), {
    getVersion: () => "1.0.0",
    isPackaged: true,
    getPath: () => "/mock/user/data",
  });
  return {
    appMock,
    forkMock: { current: null as unknown },
    sentryInit: { current: null as null | ((options: unknown) => void) },
  };
});

vi.mock("electron", () => ({
  app: shared.appMock,
  utilityProcess: { fork: () => shared.forkMock.current },
}));

vi.mock("../../../store.js", () => ({
  store: {
    get: (key: string) =>
      key === "privacy"
        ? { telemetryLevel: "errors", hasSeenPrompt: true, logRetentionDays: 30 }
        : undefined,
    set: () => {},
  },
}));

vi.mock("@sentry/electron/main", () => ({
  init: (options: unknown) => shared.sentryInit.current?.(options),
  captureEvent: () => "event-id",
  close: () => Promise.resolve(true),
  setTag: () => {},
  addBreadcrumb: () => {},
  makeElectronTransport: () => ({ send: () => Promise.resolve({}), flush: () => true }),
  makeElectronOfflineTransport: () => () => ({}),
  childProcessIntegration: () => ({ name: "ChildProcess" }),
}));

type LoggerModule = typeof import("../../../utils/logger.js");

interface Breadcrumb {
  category?: string;
  level?: string;
  message?: string;
  data?: Record<string, unknown>;
}

interface SentEvent {
  breadcrumbs?: Breadcrumb[];
  [key: string]: unknown;
}

interface SentryHooks {
  beforeBreadcrumb: (breadcrumb: Breadcrumb) => Breadcrumb | null;
  beforeSend: (event: SentEvent) => SentEvent | null;
}

interface HostOutput {
  stdout: Buffer;
  stderr: Buffer;
  messages: unknown[];
}

// Plain prose with no secret, path or email shape: nothing the scrubbers key on.
const MARKER = "violet lanterns drift over the quiet harbour";
// Raw host output that is not terminal content must keep reaching Main, or the
// replay below would prove nothing once the forensics block stops arriving.
const NATIVE_CRASH_LINE = "FATAL ERROR: positive control from the native layer";
const NATIVE_CRASH_TAIL = "Segmentation fault (positive control, no newline)";

const CONSOLE_METHODS = ["log", "info", "debug", "warn", "error", "trace"] as const;
const STDERR_METHODS = new Set<string>(["warn", "error", "trace"]);
const ENV_KEYS = [
  "DAINTREE_UTILITY_PROCESS_KIND",
  "DAINTREE_VERBOSE",
  "DAINTREE_USER_DATA",
  "SENTRY_DSN",
] as const;

let logDir: string;
let originalParentPort: PropertyDescriptor | undefined;
let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;
let exitListeners: Set<unknown>;
const loaded: LoggerModule[] = [];
const teardown: Array<() => Promise<unknown> | void> = [];

/** Deterministic PRNG so a failing split is reproducible from its seed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Seed 0 means one byte per chunk; any other seed splits at random byte offsets. */
function splitBytes(bytes: Buffer, seed: number): Buffer[] {
  const random = seeded(seed);
  const chunks: Buffer[] = [];
  let index = 0;
  while (index < bytes.length) {
    const size = seed === 0 ? 1 : 1 + Math.floor(random() * 97);
    chunks.push(bytes.subarray(index, index + size));
    index += size;
  }
  return chunks;
}

/** Sentry core's `safeJoin`: what `formatConsoleArgs` uses outside a REPL. */
function sentryJoin(args: unknown[]): string {
  return args
    .map((value) => {
      if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        return String(value);
      }
      if (value instanceof Error) {
        return value.message ? `${value.name}: ${value.message}` : value.name;
      }
      return JSON.stringify(value);
    })
    .join(" ");
}

/** Sentry core's `severityLevelFromString`. */
function sentrySeverity(method: string): string {
  if (method === "warn") return "warning";
  return ["fatal", "error", "warning", "log", "info", "debug"].includes(method) ? method : "log";
}

async function runHostExit(options: {
  verbose: boolean;
  exitCode: number;
  signal?: number;
  tail: string;
}): Promise<HostOutput> {
  vi.resetModules();
  const stdout: string[] = [];
  const stderr: string[] = [NATIVE_CRASH_LINE + "\n"];
  const messages: unknown[] = [];
  for (const method of CONSOLE_METHODS) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      (STDERR_METHODS.has(method) ? stderr : stdout).push(`${format(...args)}\n`);
    });
  }
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  Object.defineProperty(process, "parentPort", {
    value: { postMessage: (value: unknown) => messages.push(value) },
    configurable: true,
    writable: true,
  });
  process.env.DAINTREE_UTILITY_PROCESS_KIND = "pty-host";
  if (options.verbose) process.env.DAINTREE_VERBOSE = "1";
  else delete process.env.DAINTREE_VERBOSE;

  try {
    const logger = await import("../../../utils/logger.js");
    loaded.push(logger);
    logger.setVerboseLogging(options.verbose);
    const { TerminalForensicsBuffer } = await import("../TerminalForensicsBuffer.js");
    const { TerminalExitObservers } = await import("../TerminalExitObservers.js");

    const forensicsBuffer = new TerminalForensicsBuffer();
    forensicsBuffer.capture(options.tail);
    const terminalInfo = {
      spawnedAt: 1,
      launchAgentId: "claude",
      everDetectedAgent: true,
      detectedAgentId: "claude",
      wasKilled: false,
      cwd: "/workspace/project",
    } as unknown as TerminalInfo;
    const observers = new TerminalExitObservers({
      id: "term-15558",
      terminalInfo,
      forensicsBuffer,
      agentStateService: {
        updateAgentState: () => {},
        emitAgentCompleted: () => {},
      } as never,
    });
    observers.emit({
      code: options.exitCode,
      signal: options.signal,
      reason: "natural",
      recentOutput: forensicsBuffer.getRecentOutput(),
    });
    observers.dispose();
    await logger.flushLogFileWritesForTesting();
  } finally {
    vi.restoreAllMocks();
    delete (process as { parentPort?: unknown }).parentPort;
    delete process.env.DAINTREE_UTILITY_PROCESS_KIND;
    delete process.env.DAINTREE_VERBOSE;
  }

  stderr.push(NATIVE_CRASH_TAIL);
  return {
    stdout: Buffer.from(stdout.join(""), "utf8"),
    stderr: Buffer.from(stderr.join(""), "utf8"),
    messages,
  };
}

async function replayIntoMain(
  host: HostOutput,
  options: { verbose: boolean; seed: number }
): Promise<{ sent: SentEvent; preview: unknown[] }> {
  vi.resetModules();
  const breadcrumbs: Breadcrumb[] = [];
  for (const method of CONSOLE_METHODS) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      breadcrumbs.push({
        category: "console",
        level: sentrySeverity(method),
        message: sentryJoin(args),
        data: { arguments: args, logger: "console" },
      });
    });
  }

  const logger = await import("../../../utils/logger.js");
  loaded.push(logger);
  logger.initializeLogger(logDir);
  logger.setVerboseLogging(options.verbose);

  let hooks: SentryHooks | null = null;
  shared.sentryInit.current = (sentryOptions) => {
    hooks = sentryOptions as SentryHooks;
  };
  process.env.SENTRY_DSN = "https://public@sentry.example/1";
  const telemetry = await import("../../TelemetryService.js");
  teardown.push(() => telemetry.closeTelemetry());
  await telemetry.initializeTelemetry();
  if (!hooks) throw new Error("telemetry did not initialize Sentry");
  const { beforeBreadcrumb, beforeSend } = hooks as SentryHooks;

  const preview: unknown[] = [];
  const broadcaster = await import("../../TelemetryPreviewBroadcaster.js");
  broadcaster.setTelemetryPreviewEnqueue((record) => preview.push(record));
  broadcaster.setTelemetryPreviewActive(true);
  teardown.push(() => {
    broadcaster.setTelemetryPreviewActive(false);
    broadcaster.setTelemetryPreviewEnqueue(null);
  });

  const { PtyHostLifecycle } = await import("../PtyHostLifecycle.js");
  const child = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 4242,
  });
  shared.forkMock.current = child;
  let disposed = false;
  const lifecycle = new PtyHostLifecycle(
    { memoryLimitMb: 256, electronDir: "/tmp/electron" },
    {
      onMessage: () => {},
      onExitSync: () => {},
      onCrashClassified: () => {},
      onMaxRestartsReached: () => {},
      onForkFailed: () => {},
      onBeforeRestart: () => {},
      isDisposed: () => disposed,
      onHostLog: (event) => logger.ingestHostLogEvent(event),
      logInfo: (message) => logger.logInfo(message),
      logWarn: (message) => logger.logWarn(message),
    }
  );
  lifecycle.start();
  teardown.push(async () => {
    disposed = true;
    const exited = lifecycle.dispose();
    child.emit("exit", 0);
    await exited;
  });

  for (const message of host.messages) child.emit("message", message);
  for (const chunk of splitBytes(host.stderr, options.seed)) child.stderr.emit("data", chunk);
  for (const chunk of splitBytes(host.stdout, options.seed)) child.stdout.emit("data", chunk);
  child.stderr.emit("close");
  child.stdout.emit("close");

  const kept = breadcrumbs
    .map((breadcrumb) => beforeBreadcrumb({ ...breadcrumb }))
    .filter((breadcrumb): breadcrumb is Breadcrumb => breadcrumb !== null);
  const sent = beforeSend({
    event_id: "0123456789abcdef0123456789abcdef",
    level: "error",
    exception: { values: [{ type: "Error", value: "a later, unrelated failure" }] },
    breadcrumbs: kept,
  });
  if (!sent) throw new Error("beforeSend dropped the event");
  return { sent, preview };
}

function structuredExitContext(sent: SentEvent): Record<string, unknown> {
  const crumb = sent.breadcrumbs?.find((b) => b.message?.includes("exited abnormally"));
  if (!crumb) throw new Error("the structured exit record never became a breadcrumb");
  const args = crumb.data?.arguments as unknown[];
  return JSON.parse(String(args[1])) as Record<string, unknown>;
}

function readLocalLog(): string {
  const file = join(logDir, "logs", "daintree.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

beforeEach(() => {
  originalParentPort = Object.getOwnPropertyDescriptor(process, "parentPort");
  originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  logDir = mkdtempSync(join(tmpdir(), "daintree-forensics-telemetry-"));
  process.env.DAINTREE_USER_DATA = logDir;
  exitListeners = new Set(process.listeners("exit"));
  // The lifecycle arms handshake and health timers on start; none must fire.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(async () => {
  for (const step of teardown.splice(0).reverse()) await step();
  for (const logger of loaded.splice(0)) {
    await logger.flushLogFileWritesForTesting();
    logger.resetLoggerStateForTesting();
  }
  // Every fresh logger module registers its own exit flush; once drained they
  // would only pile up past Node's listener limit across the cases.
  for (const listener of process.listeners("exit")) {
    if (!exitListeners.has(listener)) process.off("exit", listener);
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  shared.appMock.removeAllListeners();
  shared.sentryInit.current = null;
  shared.forkMock.current = null;
  delete (process as { parentPort?: unknown }).parentPort;
  if (originalParentPort) Object.defineProperty(process, "parentPort", originalParentPort);
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  rmSync(logDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("agent crash forensics and Sentry (#15558)", () => {
  const tail = [
    "\x1b[32m● Reading src/payments/ledger.ts\x1b[0m",
    `> ${MARKER}`,
    "  const total = entries.reduce((sum, e) => sum + e.amount, 0);",
    "fatal: agent exited",
  ].join("\r\n");

  describe.each([
    { verbose: false, exitCode: 1, signal: undefined },
    { verbose: true, exitCode: 1, signal: undefined },
    { verbose: false, exitCode: 139, signal: 11 },
    // Crash-like text logs even a clean exit, and verbose prints its block.
    { verbose: true, exitCode: 0, signal: undefined },
  ])("verbose=$verbose exitCode=$exitCode signal=$signal", ({ verbose, exitCode, signal }) => {
    it.each([0, 7, 15558])("keeps the tail out of the sent event (split seed %i)", async (seed) => {
      const host = await runHostExit({ verbose, exitCode, signal, tail });
      expect(host.stderr.toString("utf8")).not.toContain(MARKER);
      expect(host.stdout.toString("utf8")).not.toContain(MARKER);
      expect(JSON.stringify(host.messages)).not.toContain(MARKER);

      const { sent, preview } = await replayIntoMain(host, { verbose, seed });
      const payload = JSON.stringify(sent);
      expect(payload).not.toContain(MARKER);
      expect(payload).not.toContain("ledger.ts");
      expect(preview).toHaveLength(1);
      expect(JSON.stringify(preview)).not.toContain(MARKER);

      // The replay is live: raw host stderr still reaches the breadcrumbs.
      expect(payload).toContain(`[PtyHost] ${NATIVE_CRASH_LINE}`);
      expect(payload).toContain(`[PtyHost] ${NATIVE_CRASH_TAIL}`);

      // Triage metadata still travels; the structured tail stays redacted.
      expect(payload).toContain(`Terminal term-15558 exited abnormally (code ${exitCode})`);
      expect(structuredExitContext(sent)).toMatchObject({
        terminalId: "term-15558",
        exitCode,
        agentId: "claude",
        lastOutput: "[redacted]",
        ...(signal === undefined ? {} : { signal }),
      });

      for (const logger of loaded) await logger.flushLogFileWritesForTesting();
      const localLog = readLocalLog();
      expect(localLog).toContain("TERMINAL CRASH FORENSICS");
      expect(localLog).toContain(MARKER);
    });
  });
});
