import nodeModule from "node:module";
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

/**
 * The REAL main-process log emit path for PERF-380..384, in a plain Node
 * process.
 *
 * `electron/utils/logger.ts` says it itself: a busy multi-agent session issues
 * hundreds of log lines per second, and a per-line `appendFileSync` on the main
 * thread was the dominant event-loop stall before #10769. Every one of those
 * lines walks `redactSensitiveData` → `clampLogString` → `scrubSecrets` →
 * `safe-stable-stringify` → the batched append, and `scrubSecrets` runs roughly
 * sixty regex passes over the line once its pre-scan probe hits. None of it was
 * measured.
 *
 * WHAT IS REAL
 *   - `electron/utils/logger.ts` unmodified, loaded through its own module
 *     graph. `createLogger`, `emit`, `emitError`, `redactSensitiveData`,
 *     `redactArrayWithCycleDetection`, `clampLogString`, `safeStringify` over
 *     the real `safe-stable-stringify`, `writeToLogFile`, the async batch
 *     (`scheduleAsyncFlush` → `drainPendingLogs` → `fsp.appendFile`), the
 *     synchronous ERROR append, `rotateIfNeededTracked` and the real
 *     `rotateLogsIfNeeded` ladder are all in the loop.
 *   - The real `shared/utils/secretScrubber.ts` with its shipped ~60 patterns
 *     and both pre-scan probes — the subject of PERF-382.
 *   - The real `electron/services/LogBuffer.ts` 500-entry ring, the real
 *     `electron/utils/errorTypes.ts` `getErrorDetails`, the real
 *     `shared/utils/logErrorNormalization.ts` Error flattening (#11777) and the
 *     real `electron/utils/fs.ts` `resilientRenameSync` behind rotation.
 *   - Real files on a real filesystem, at the product's own
 *     `ROTATION_MAX_SIZE` / `ROTATION_MAX_FILES`.
 *
 * WHAT IS NOT, AND CANNOT BE
 *   - **No Electron.** Nothing in the logger's module graph imports it, so
 *     nothing is stubbed for the healthy path — but there is also no main
 *     process, which matters twice. `registerLoggerTransport` is never called,
 *     so `hasAnyWindow()` is false and `sendLogToRenderer` returns immediately:
 *     the renderer broadcast, its 16 ms throttle and its 60-per-flush cap are
 *     OUTSIDE every number here. And `app.getPath` never sets `storagePath`;
 *     the log directory is chosen through `DAINTREE_USER_DATA`, which is
 *     `getLogDirectory`'s own first branch and what every utility process uses.
 *   - **The console transport is redirected to a counting sink.** `emit` mirrors
 *     every line to `console.log`/`warn`/`error` outside tests, and on a TTY
 *     that write would dominate the measurement and bury the runner's own
 *     output. The prefix construction and the argument marshalling stay in the
 *     numbers; `util.format` and the stream write do not. The sink is counted
 *     and the count is graded, so the branch is proven to have run.
 *   - **A temp filesystem, not the user's log directory.** Every scenario
 *     writes into one `mkdtemp` root that this module owns and removes; nothing
 *     reads the developer's real `daintree.log`. Every planted secret is a
 *     SYNTHETIC token built from the literal string `PERFFAKE0` — see
 *     {@link SECRET_PLANTS} — never a real credential.
 *   - **Disk behaviour is this machine's.** `appendFileSync` against APFS, ext4
 *     and NTFS are three different numbers, and the rotation seed file is
 *     sparse (`ftruncateSync`), so the rename in PERF-383 moves an inode rather
 *     than 5 MB of bytes — which is also what production's rename does.
 *   - **One event-loop turn per batched flush.** The INFO path defers its write
 *     to a `setImmediate`, so a scenario that wants the bytes on disk awaits
 *     `flushLogFileWritesForTesting()`. That await is timed separately and
 *     never folded into a per-entry emit cost.
 */

// --- Module-boundary stubs (opt-in, for predicate verification) --------------

/**
 * Break one real dependency of the emit path, so a predicate can be watched
 * failing rather than assumed to work.
 *
 * Every mode replaces a whole module at the loader boundary — never a file edit
 * — and every one is off unless `DAINTREE_PERF_LOGGER_STUB` names it. The set
 * exists because "a predicate you did not watch fail is untested", and each
 * mode is aimed at a specific accumulator:
 *
 *   `scrub-nothing`     → the scrubber becomes the identity function.
 *                         `secretSurvivalMisses` and `redactionCountDelta` fire;
 *                         `markerSurvivalMisses` must NOT.
 *   `scrub-everything`  → the scrubber redacts every non-empty string.
 *                         `markerSurvivalMisses`, `keyRedactionMisses`,
 *                         `clampMisses` and `clampEvidenceMisses` fire;
 *                         `secretSurvivalMisses` must NOT.
 *   `suppress-writes`   → the disk-pressure flag reads true, so the file
 *                         transport drops every line. `lineCountMisses` and
 *                         `syncDurabilityMisses` fire.
 *   `flatten-nothing`   → `serializeErrorForLog` returns `{}`, reinstating
 *                         #11777. `errorDetailMisses` fires.
 *   `buffer-nothing`    → `logBuffer.push` stores nothing. `bufferMisses` fires.
 *   `stringify-empty`   → `safe-stable-stringify` answers `{}` for everything.
 *                         `stringifyMisses`, `keyRedactionMisses`, `clampMisses`
 *                         and `clampEvidenceMisses` fire.
 *   `no-rename`         → `resilientRenameSync` is a no-op, so the rotation
 *                         ladder cannot move a file. `rotationMisses` fires.
 *   `gate-off`          → the ONE mode that is not a module stub. `shouldLog`
 *                         has no boundary to break, so this drives the product's
 *                         own `setLogLevelOverrides` to `{"*": "off"}` instead.
 *                         `levelGateMisses`, `consoleMirrorMisses` and
 *                         `lineCountMisses` fire together, which is exactly the
 *                         shape a scenario that measured nothing would have.
 */
export type LoggerStubMode =
  | "scrub-nothing"
  | "scrub-everything"
  | "suppress-writes"
  | "flatten-nothing"
  | "buffer-nothing"
  | "stringify-empty"
  | "no-rename"
  | "gate-off";

const STUB_MODES: ReadonlySet<string> = new Set<LoggerStubMode>([
  "scrub-nothing",
  "scrub-everything",
  "suppress-writes",
  "flatten-nothing",
  "buffer-nothing",
  "stringify-empty",
  "no-rename",
  "gate-off",
]);

/** The stub named by `DAINTREE_PERF_LOGGER_STUB`, or null on the healthy path. */
export function activeStubMode(): LoggerStubMode | null {
  const raw = process.env.DAINTREE_PERF_LOGGER_STUB;
  if (raw === undefined || raw === "") return null;
  if (!STUB_MODES.has(raw)) {
    throw new Error(
      `perf logging fixture: unknown DAINTREE_PERF_LOGGER_STUB "${raw}"; ` +
        `expected one of ${[...STUB_MODES].join(", ")}`
    );
  }
  return raw as LoggerStubMode;
}

const SCRUB_NOTHING_SOURCE = `
export const REDACTED = "[REDACTED]";
export const PATTERNS = [];
export function scrubSecrets(value) { return value; }
export function findSecretInValue() { return undefined; }
`;

const SCRUB_EVERYTHING_SOURCE = `
export const REDACTED = "[REDACTED]";
export const PATTERNS = [];
export function scrubSecrets(value) { return value.length === 0 ? value : "[REDACTED]"; }
export function findSecretInValue() { return undefined; }
`;

const SUPPRESS_WRITES_SOURCE = `
export function getWritesSuppressed() { return true; }
export function setWritesSuppressed() {}
export function resetWritesSuppressedForTesting() {}
`;

const FLATTEN_NOTHING_SOURCE = `
export function serializeErrorForLog() { return {}; }
export function normalizeErrorsInLogContext(context) { return context; }
`;

const BUFFER_NOTHING_SOURCE = `
export class LogBuffer {
  push(entry) { return { ...entry, id: "perf-stub" }; }
  getAll() { return []; }
  getFiltered() { return []; }
  clear() {}
  static getInstance() { return new LogBuffer(); }
}
export const logBuffer = LogBuffer.getInstance();
`;

const STRINGIFY_EMPTY_SOURCE = `
export function configure() { return () => "{}"; }
export default configure;
`;

const NO_RENAME_SOURCE = `
export function resilientRenameSync() {}
export async function resilientRename() {}
export const OWNER_RW_FILE_MODE = 0o600;
export const OWNER_RWX_DIR_MODE = 0o700;
`;

/**
 * Stub mode → the module it replaces and the source that replaces it.
 *
 * Partial: `gate-off` breaks the subject through the product's own override API
 * rather than by replacing a module, so it has no entry here.
 */
const STUB_TABLE: Readonly<Partial<Record<LoggerStubMode, { target: string; source: string }>>> = {
  "scrub-nothing": { target: "/shared/utils/secretScrubber", source: SCRUB_NOTHING_SOURCE },
  "scrub-everything": { target: "/shared/utils/secretScrubber", source: SCRUB_EVERYTHING_SOURCE },
  "suppress-writes": {
    target: "/electron/services/diskPressureState",
    source: SUPPRESS_WRITES_SOURCE,
  },
  "flatten-nothing": {
    target: "/shared/utils/logErrorNormalization",
    source: FLATTEN_NOTHING_SOURCE,
  },
  "buffer-nothing": { target: "/electron/services/LogBuffer", source: BUFFER_NOTHING_SOURCE },
  "stringify-empty": { target: "safe-stable-stringify", source: STRINGIFY_EMPTY_SOURCE },
  "no-rename": { target: "/electron/utils/fs", source: NO_RENAME_SOURCE },
};

function dataUrl(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

let hooksInstalled = false;

/**
 * Install the loader hook for the selected stub, if any.
 *
 * `module.registerHooks` is synchronous and in-thread; `module.register` (hooks
 * in a worker) is the fallback for a runtime that predates it. Under Vitest
 * neither fires because Vite resolves imports itself, which is why the unit test
 * wires the same stubs through `vi.mock` and reads {@link activeStubMode} from
 * inside each factory.
 */
function installModuleStubs(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  if (process.env.VITEST) return;

  const mode = activeStubMode();
  if (mode === null) return;
  const entry = STUB_TABLE[mode];
  if (entry === undefined) return;

  const { target, source } = entry;
  const stubUrl = dataUrl(source);
  const isBareTarget = !target.startsWith("/");

  const matches = (resolvedUrl: string): boolean => {
    const withoutExt = resolvedUrl.split("?")[0]!.replace(/\.(ts|js|mts|mjs|cjs)$/, "");
    return withoutExt.endsWith(target);
  };

  const registerHooks = (
    nodeModule as unknown as {
      registerHooks?: (hooks: {
        resolve: (
          specifier: string,
          context: unknown,
          next: (s: string, c: unknown) => { url: string }
        ) => { url: string; shortCircuit?: boolean };
      }) => void;
    }
  ).registerHooks;

  if (typeof registerHooks === "function") {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (isBareTarget && specifier === target) return { url: stubUrl, shortCircuit: true };
        const resolved = nextResolve(specifier, context);
        if (!isBareTarget && matches(resolved.url)) return { url: stubUrl, shortCircuit: true };
        return resolved;
      },
    });
    return;
  }

  const hooksSource = `
const STUB_URL = ${JSON.stringify(stubUrl)};
const TARGET = ${JSON.stringify(target)};
const IS_BARE = ${JSON.stringify(isBareTarget)};
export async function resolve(specifier, context, nextResolve) {
  if (IS_BARE && specifier === TARGET) return { url: STUB_URL, shortCircuit: true };
  const resolved = await nextResolve(specifier, context);
  const withoutExt = String(resolved.url).split("?")[0].replace(/\\.(ts|js|mts|mjs|cjs)$/, "");
  if (!IS_BARE && withoutExt.endsWith(TARGET)) return { url: STUB_URL, shortCircuit: true };
  return resolved;
}
`;
  nodeModule.register(dataUrl(hooksSource));
}

// --- The fixture's own copies of the logger's private bounds -----------------

/**
 * `logger.ts` does not export these, and copying them here is the point rather
 * than a workaround: an oracle that read the subject's own constant could not
 * tell a clamp that stopped running from a clamp whose bound moved. If the
 * product changes one of these, the predicates go non-zero and say so.
 */
export const MAX_REDACT_DEPTH = 5;
export const MAX_REDACT_STRING_CHARS = 2000;
export const MAX_REDACT_ARRAY_ITEMS = 20;

// --- Synthetic secrets -------------------------------------------------------

export interface SecretPlant {
  /** The shipped pattern this plant is built to satisfy. */
  name: string;
  /** The literal emitted into the log line. Synthetic — see the note below. */
  literal: string;
}

/**
 * Deterministic filler for every synthetic token.
 *
 * The string `PERFFAKE0` is repeated to length, so every plant below reads as
 * an obvious fixture artefact and none of them is, or resembles, a credential.
 * The charset is `[A-Za-z0-9]`, which every plant's pattern accepts.
 */
const FAKE_UNIT = "PERFFAKE0";

function fakeBody(length: number): string {
  return FAKE_UNIT.repeat(Math.ceil(length / FAKE_UNIT.length)).slice(0, length);
}

const FAKE_UPPER_UNIT = "PERFFAKE01234567";

function fakeUpperBody(length: number): string {
  return FAKE_UPPER_UNIT.repeat(Math.ceil(length / FAKE_UPPER_UNIT.length)).slice(0, length);
}

/**
 * Eight synthetic tokens, one per shipped pattern family, every one of which
 * `scrubSecrets` replaces with exactly `[REDACTED]`.
 *
 * SYNTHETIC BY CONSTRUCTION. Each is a sigil this repository's patterns
 * recognise followed by a run of `PERFFAKE0`; none was ever a credential, none
 * came from a real log, and nothing here reads the developer's own log files.
 * That matters beyond hygiene: the point of the two-sided predicate is that
 * these MUST NOT survive to disk, so a fixture that planted a real token would
 * be writing one into a temp file to prove it got deleted.
 *
 * The replacement is uniformly `[REDACTED]` — `bearer-token` and
 * `url-basic-auth` are deliberately left out — so PERF-382 can count
 * redactions per line against the number it planted and report a SIGNED delta.
 */
export const SECRET_PLANTS: readonly SecretPlant[] = [
  { name: "github-pat", literal: `ghp_${fakeBody(36)}` },
  { name: "anthropic-api-key", literal: `sk-ant-${fakeBody(90)}` },
  { name: "openai-api-key", literal: `sk-${fakeBody(48)}` },
  { name: "aws-access-key-id", literal: `AKIA${fakeUpperBody(16)}` },
  { name: "google-api-key", literal: `AIza${fakeBody(35)}` },
  { name: "slack-token", literal: `xoxb-${fakeBody(20)}` },
  { name: "npm-token", literal: `npm_${fakeBody(36)}` },
  { name: "jwt", literal: `eyJ${fakeBody(20)}.${fakeBody(20)}.${fakeBody(20)}` },
];

/** What every plant above must become. Declared, not read back from the subject. */
export const REDACTION_MARKER = "[REDACTED]";

/**
 * A non-secret string that MUST reach disk intact.
 *
 * This is the half of the predicate a scrubber stubbed to redact everything
 * fails. Chosen to contain none of the ~56 case-stable sigils in the pattern
 * table, so a line built only from markers is a pre-scan probe MISS — the fast
 * path PERF-382 prices against the full sixty-pass scan.
 */
export const SURVIVOR_MARKER = "zz-perfmarker-alpha-zz";
/** A second survivor, planted as a context value under a benign key. */
export const SURVIVOR_MARKER_CONTEXT = "zz-perfmarker-beta-zz";

/**
 * Sigils that hit the pre-scan probe and complete NO pattern.
 *
 * `sk-`, `ghp_`, `AIza` and `xoxb-` are probe fragments, so a line carrying
 * them pays all sixty passes and produces zero replacements. This is the arm
 * that separates "the probe fired" from "a secret was found" — without it, the
 * clean/dense delta would conflate the pre-scan with the scan.
 */
export const PROBE_HIT_SIGILS = "sk-x ghp_x AIza xoxb-";

/**
 * The per-entry marker every message carries exactly once.
 *
 * Process-stable rather than per-corpus, so message corpora can be built once
 * and reused across iterations — a 32 KiB sweep rebuilt sixteen times would be
 * pure noise in the duration. Counting it is still per-iteration, because every
 * `resetCorpus` mints a fresh, empty log directory.
 */
export const ENTRY_TOKEN = "zz-perfentry-zz";

// --- Temp root ---------------------------------------------------------------

/**
 * Read before anything here can touch it. An inherited value is normally
 * another perf fixture's temp dir (or Vitest's own), but it could equally be a
 * developer's real Daintree profile — and this fixture WRITES LOG FILES and
 * ROTATES THEM. It is always replaced, and always restored on cleanup.
 */
let inheritedUserData: string | undefined;
let inheritedUserDataRead = false;
let perfRoot: string | null = null;
let exitHookRegistered = false;
let corpusSerial = 0;
let activeCorpusDir: string | null = null;

function ensureRoot(): string {
  if (perfRoot !== null) return perfRoot;
  if (!inheritedUserDataRead) {
    inheritedUserData = process.env.DAINTREE_USER_DATA;
    inheritedUserDataRead = true;
  }
  perfRoot = realpathSync(mkdtempSync(join(tmpdir(), "daintree-perf-logging-")));
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.on("exit", cleanupLoggingTempDir);
  }
  return perfRoot;
}

/**
 * Remove the one temp root this module owns and put `DAINTREE_USER_DATA` back.
 *
 * Registered on `exit` and exported for callers that never reach one. ONE root
 * per process, reused by every scenario and every iteration, with the previous
 * corpus directory removed as each new one is minted — a fixture that minted a
 * directory per iteration is how 488 of them ended up in `$TMPDIR`.
 */
export function cleanupLoggingTempDir(): void {
  const root = perfRoot;
  perfRoot = null;
  activeCorpusDir = null;
  if (root !== null) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort: a temp dir left behind is noise, not a failed measurement.
    }
  }
  if (!inheritedUserDataRead) return;
  if (inheritedUserData === undefined) delete process.env.DAINTREE_USER_DATA;
  else process.env.DAINTREE_USER_DATA = inheritedUserData;
}

/** The directory count under `$TMPDIR` this fixture is responsible for. */
export function ownedTempDirCount(): number {
  return perfRoot === null ? 0 : 1;
}

// --- Product module view -----------------------------------------------------

interface LoggerModule {
  createLogger: (name: string) => LoggerHandle;
  setLogLevelOverrides: (overrides: Record<string, string>) => void;
  resetLoggerStateForTesting: () => void;
  flushLogFileWritesForTesting: () => Promise<void>;
  getLogDirectory: () => string;
  getLogFilePath: () => string;
  ROTATION_MAX_SIZE: number;
  ROTATION_MAX_FILES: number;
}

export interface LoggerHandle {
  readonly name: string;
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, error?: unknown, context?: Record<string, unknown>): void;
}

interface LogBufferModule {
  logBuffer: { getAll: () => Array<{ message: string; source?: string }> };
}

export type EmitLevel = "debug" | "info" | "warn";

export interface LogFile {
  name: string;
  text: string;
  bytes: number;
}

export interface LoggingHarness {
  modules: LoggerModule;
  logger: LoggerHandle;
  /** A second logger, used only by the level-gate probe. */
  quietLogger: LoggerHandle;
  /** The active log directory — a fresh one after every `resetCorpus`. */
  logDir(): string;
  /** Unique per corpus; every emitted message carries it exactly once. */
  token(): string;
  /** Emit through the real logger and tally the call AT THE CALL SITE. */
  emit(level: EmitLevel, message: string, context?: Record<string, unknown>): void;
  emitError(message: string, error?: unknown, context?: Record<string, unknown>): void;
  /** Entries handed to the logger since the last `resetCorpus`. */
  emittedEntryCount(): number;
  /** Flush the batched INFO buffer to disk. Never inside a timed bracket. */
  flush(): Promise<void>;
  /** Flush, drop the previous corpus directory, mint a fresh one, reset state. */
  resetCorpus(): Promise<void>;
  /** Every file in the active log directory, read back. */
  readLogFiles(): LogFile[];
  /** Bytes currently in `daintree.log`. */
  liveLogBytes(): number;
  /** Seed `daintree.log` to an exact size and the rotation ladder beside it. */
  seedRotationLadder(mainBytes: number, markers: readonly string[]): void;
  /** Redirect console.log/warn/error to a counter; returns the restore fn. */
  captureConsole(): () => number;
  /** The real 500-entry ring, for the buffer predicate. */
  logBuffer: LogBufferModule["logBuffer"];
}

/**
 * The override map every corpus starts from — empty, unless the `gate-off`
 * experiment is asking for the level gate to swallow everything.
 */
function baselineOverrides(): Record<string, string> {
  return activeStubMode() === "gate-off" ? { "*": "off" } : {};
}

let harnessPromise: Promise<LoggingHarness> | null = null;

async function buildHarness(): Promise<LoggingHarness> {
  installModuleStubs();
  ensureRoot();

  // `logger.ts` freezes three module-level booleans at evaluation:
  // `IS_TEST` (NODE_ENV === "test") disables BOTH the file transport and the
  // console mirror, `IS_DEBUG_BOOT` sets the default level, and
  // `DAINTREE_DISABLE_FILE_LOGGING` kills the file transport outright. Pinned
  // here so the subject behaves identically under `tsx` and under Vitest —
  // which sets NODE_ENV to "development" — and restored immediately after,
  // because the constants are captured at evaluation and nothing else in this
  // process should inherit the pin.
  const priorNodeEnv = process.env.NODE_ENV;
  const priorDisable = process.env.DAINTREE_DISABLE_FILE_LOGGING;
  process.env.NODE_ENV = "development";
  delete process.env.DAINTREE_DISABLE_FILE_LOGGING;

  let loggerModule: LoggerModule;
  let bufferModule: LogBufferModule;
  try {
    loggerModule = (await import("../../../electron/utils/logger")) as unknown as LoggerModule;
    bufferModule =
      (await import("../../../electron/services/LogBuffer")) as unknown as LogBufferModule;
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
    if (priorDisable !== undefined) process.env.DAINTREE_DISABLE_FILE_LOGGING = priorDisable;
  }

  const logger = loggerModule.createLogger("perf:LoggingBench");
  const quietLogger = loggerModule.createLogger("perf:LoggingBenchQuiet");

  let entryCount = 0;
  let corpusDir = "";

  const mintCorpus = (): void => {
    const root = ensureRoot();
    corpusSerial += 1;
    const previous = activeCorpusDir;
    const next = join(root, `corpus-${corpusSerial}`);
    mkdirSync(join(next, "logs"), { recursive: true });
    process.env.DAINTREE_USER_DATA = next;
    activeCorpusDir = next;
    corpusDir = join(next, "logs");
    entryCount = 0;
    if (previous !== null) {
      try {
        rmSync(previous, { recursive: true, force: true });
      } catch {
        // A directory that will not delete is noise, not a failed measurement.
      }
    }
  };

  mintCorpus();
  // A clean slate for `trackedLogFile` / `trackedLogSize` / the pending buffer,
  // through the product's own test hook rather than by poking module state.
  loggerModule.resetLoggerStateForTesting();
  loggerModule.setLogLevelOverrides(baselineOverrides());

  const harness: LoggingHarness = {
    modules: loggerModule,
    logger,
    quietLogger,
    logDir: () => corpusDir,
    token: () => ENTRY_TOKEN,
    emit(level, message, context) {
      entryCount += 1;
      logger[level](message, context);
    },
    emitError(message, error, context) {
      entryCount += 1;
      logger.error(message, error, context);
    },
    emittedEntryCount: () => entryCount,
    flush: () => loggerModule.flushLogFileWritesForTesting(),
    async resetCorpus() {
      await loggerModule.flushLogFileWritesForTesting();
      mintCorpus();
      loggerModule.resetLoggerStateForTesting();
      loggerModule.setLogLevelOverrides(baselineOverrides());
    },
    readLogFiles() {
      if (!existsSync(corpusDir)) return [];
      return readdirSync(corpusDir)
        .sort()
        .map((name) => {
          const path = join(corpusDir, name);
          return { name, text: readFileSync(path, "utf8"), bytes: statSync(path).size };
        });
    },
    liveLogBytes() {
      const path = join(corpusDir, "daintree.log");
      return existsSync(path) ? statSync(path).size : 0;
    },
    seedRotationLadder(mainBytes, markers) {
      mkdirSync(corpusDir, { recursive: true });
      // Sparse: `ftruncateSync` sets the size the rotation gate stats without
      // writing 5 MB of bytes. The rename production performs moves an inode
      // either way, so the measured cost is unaffected.
      const fd = openSync(join(corpusDir, "daintree.log"), "w");
      try {
        ftruncateSync(fd, mainBytes);
      } finally {
        closeSync(fd);
      }
      markers.forEach((marker, index) => {
        writeFileSync(join(corpusDir, `daintree.log.${index + 1}`), `${marker}\n`, "utf8");
      });
    },
    captureConsole() {
      const originals = { log: console.log, warn: console.warn, error: console.error };
      let count = 0;
      const sink = (): void => {
        count += 1;
      };
      console.log = sink;
      console.warn = sink;
      console.error = sink;
      return () => {
        console.log = originals.log;
        console.warn = originals.warn;
        console.error = originals.error;
        return count;
      };
    },
    logBuffer: bufferModule.logBuffer,
  };

  return harness;
}

/** Load the logger graph and mint the first corpus. Once per process. */
export function loadLoggingHarness(): Promise<LoggingHarness> {
  harnessPromise ??= buildHarness();
  return harnessPromise;
}

// --- Guards on the temp root -------------------------------------------------

/**
 * Refuse to run against anything outside the temp root.
 *
 * Cheap, and the failure it prevents is not: a scenario that rotated logs
 * inside a developer's real profile would delete `daintree.log.4` and shift
 * every other file down a slot.
 */
export function assertInsideTempRoot(dir: string): void {
  // realpath both sides: on macOS `tmpdir()` answers `/var/folders/…` while the
  // directory this fixture minted resolves to `/private/var/folders/…`, and a
  // string prefix test between the two fails on a path that IS inside the root.
  let root: string;
  try {
    root = realpathSync(tmpdir());
  } catch {
    root = resolvePath(tmpdir());
  }
  if (!resolvePath(dir).startsWith(root)) {
    throw new Error(
      `perf logging fixture: log directory ${dir} is outside the temp root; refusing to write ` +
        "and rotate log files against what may be a real Daintree profile."
    );
  }
}

// --- Corpora -----------------------------------------------------------------

/**
 * Sigil-free filler.
 *
 * Every message this fixture builds is padded with this, so a "clean" line is a
 * pre-scan probe MISS rather than merely a line with no complete secret in it.
 * The unit test asserts that against the product's own probe fragments — the
 * arm would otherwise silently become a second copy of the probe-hit arm, and
 * PERF-382's headline ratio would read 1.0 with nothing wrong.
 */
const FILLER = "worktree sync advanced refs and settled cleanly with no conflicts pending ";

/** Pad `head` to EXACTLY `bytes` with sigil-free filler. ASCII, so 1 byte/char. */
function padMessage(head: string, bytes: number): string {
  if (head.length >= bytes) {
    throw new Error(
      `perf logging fixture: ${bytes} bytes is below this message's own floor (${head.length})`
    );
  }
  const filler = FILLER.repeat(Math.ceil((bytes - head.length) / FILLER.length));
  return (head + filler).slice(0, bytes);
}

/** The head every message carries: the corpus token exactly once, plus a marker. */
function messageHead(token: string, seq: number): string {
  return `${token} ${SURVIVOR_MARKER} entry ${seq} `;
}

/** A line with no secret sigil at all — the pre-scan fast path. */
export function buildCleanMessage(token: string, seq: number, bytes: number): string {
  return padMessage(messageHead(token, seq), bytes);
}

/** A line that hits the probe and completes no pattern — the full sixty passes. */
export function buildProbeHitMessage(token: string, seq: number, bytes: number): string {
  return padMessage(`${messageHead(token, seq)}${PROBE_HIT_SIGILS} `, bytes);
}

/** A line carrying `plantCount` synthetic secrets, each of which must be redacted. */
export function buildSecretMessage(
  token: string,
  seq: number,
  bytes: number,
  plantCount: number
): string {
  if (plantCount > SECRET_PLANTS.length) {
    throw new Error(
      `perf logging fixture: asked for ${plantCount} plants, only ${SECRET_PLANTS.length} exist`
    );
  }
  const plants = SECRET_PLANTS.slice(0, plantCount)
    .map((plant) => plant.literal)
    .join(" gap ");
  return padMessage(`${messageHead(token, seq)}${plants} `, bytes);
}

export type ContextShape = "flat" | "wide" | "deep" | "array";

/** Keys per context shape, chosen so each arm's redaction walk differs in kind. */
export const FLAT_KEY_COUNT = 12;
export const WIDE_KEY_COUNT = 200;
/** One level past `MAX_REDACT_DEPTH`, so the depth clamp is actually reached. */
export const DEEP_CHAIN_DEPTH = 6;
export const ARRAY_ROW_COUNT = 200;

/** What the array cap writes in place of the rows it dropped. */
export function arrayCapMarker(rowCount: number): string {
  return `[...${rowCount - MAX_REDACT_ARRAY_ITEMS} more]`;
}

/** What the depth clamp writes in place of the subtree it refused to walk. */
export const DEPTH_CAP_MARKER = "[MaxDepth]";

export function buildContext(shape: ContextShape): Record<string, unknown> {
  switch (shape) {
    case "flat": {
      const record: Record<string, unknown> = { marker: SURVIVOR_MARKER_CONTEXT };
      for (let index = 0; index < FLAT_KEY_COUNT; index += 1) {
        record[`field${index}`] = `${FILLER.slice(0, 40)}${index}`;
      }
      return record;
    }
    case "wide": {
      const record: Record<string, unknown> = { marker: SURVIVOR_MARKER_CONTEXT };
      for (let index = 0; index < WIDE_KEY_COUNT; index += 1) {
        record[`field${index}`] = `value-${index}`;
      }
      return record;
    }
    case "deep": {
      // The leaf carries NO marker: it sits past `MAX_REDACT_DEPTH` and is
      // replaced wholesale, so a marker planted here would be dropped by a
      // healthy subject and make the survival expectation a lie.
      let node: Record<string, unknown> = { leaf: "deep-leaf" };
      for (let depth = 0; depth < DEEP_CHAIN_DEPTH; depth += 1) {
        node = { child: node };
      }
      return { marker: SURVIVOR_MARKER_CONTEXT, nested: node };
    }
    case "array": {
      const rows: unknown[] = [];
      for (let index = 0; index < ARRAY_ROW_COUNT; index += 1) {
        rows.push({ id: index, name: `row-${index}` });
      }
      return { marker: SURVIVOR_MARKER_CONTEXT, rows };
    }
  }
}

/** A small, fixed context for arms whose variable is the MESSAGE, not the context. */
export function buildSmallContext(): Record<string, unknown> {
  return { marker: SURVIVOR_MARKER_CONTEXT, attempt: 1, ok: true };
}

// --- The structural probe ----------------------------------------------------

/**
 * The one entry whose serialized context is compared, field by field, against a
 * shape written out by hand below.
 *
 * Hand-written rather than computed by walking the input: an oracle that
 * reimplemented `redactSensitiveData` would agree with a broken subject as
 * happily as with a working one.
 */
const STRUCT_NOTE = `${SURVIVOR_MARKER} plain context value`;
const STRUCT_LONG_CHARS = 5_000;
const STRUCT_LONG = `${SURVIVOR_MARKER} ${"y".repeat(STRUCT_LONG_CHARS - SURVIVOR_MARKER.length - 1)}`;

function structContext(): Record<string, unknown> {
  return {
    note: STRUCT_NOTE,
    sessionId: SURVIVOR_MARKER_CONTEXT,
    token: SECRET_PLANTS[0]!.literal,
    apiKey: SECRET_PLANTS[1]!.literal,
    stdout: SECRET_PLANTS[2]!.literal,
    longNote: STRUCT_LONG,
    nested: { a: { b: { c: { d: { e: "deep" } } } } },
    items: Array.from({ length: ARRAY_ROW_COUNT }, (_, index) => index),
    attempt: 42,
    ok: true,
    nothing: null,
  };
}

/**
 * What the file must contain for {@link structContext}, derived from this
 * fixture's own copies of the three bounds and from the documented behaviour of
 * each gate:
 *   - `token` and `apiKey` are key-redacted (`SENSITIVE_KEYS`), value unread.
 *   - `stdout` is a benign key, so its value reaches the CONTENT scrubber.
 *   - `longNote` is scrubbed and then cut at `MAX_REDACT_STRING_CHARS` with a
 *     tail marker naming the number of characters dropped.
 *   - `nested` is walked to `MAX_REDACT_DEPTH` and then refused.
 *   - `items` keeps `MAX_REDACT_ARRAY_ITEMS` rows and a count of the rest.
 *   - `note`, `sessionId`, `attempt`, `ok` and `nothing` must survive verbatim.
 */
function structExpectation(): Record<string, unknown> {
  return {
    note: STRUCT_NOTE,
    sessionId: SURVIVOR_MARKER_CONTEXT,
    token: "[redacted]",
    apiKey: "[redacted]",
    stdout: REDACTION_MARKER,
    longNote: `${STRUCT_LONG.slice(0, MAX_REDACT_STRING_CHARS)}[…+${STRUCT_LONG_CHARS - MAX_REDACT_STRING_CHARS}]`,
    nested: { a: { b: { c: { d: DEPTH_CAP_MARKER } } } },
    items: [
      ...Array.from({ length: MAX_REDACT_ARRAY_ITEMS }, (_, index) => index),
      arrayCapMarker(ARRAY_ROW_COUNT),
    ],
    attempt: 42,
    ok: true,
    nothing: null,
  };
}

/** `safe-stable-stringify` sorts keys; a plain `JSON.stringify` would not. */
const STRUCT_SORTED_KEYS: readonly string[] = Object.keys(structExpectation()).sort();

// --- Read-back helpers -------------------------------------------------------

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Total occurrences of `needle` across every file in the log directory. */
export function countAcrossFiles(files: readonly LogFile[], needle: string): number {
  return files.reduce((total, file) => total + countOccurrences(file.text, needle), 0);
}

/** Deep structural equality over JSON-shaped values. Bounded by construction. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}

/**
 * Pull the serialized context of the LAST entry in `text` back out of the file.
 *
 * `safeStringify` pretty-prints at indent 2, so a single log entry spans many
 * physical lines and the context cannot be recovered by splitting on newlines.
 * The structural probe is therefore always emitted last, which makes its
 * context everything from the first `{` after its message to end of file.
 */
export function readTrailingContextRaw(text: string, message: string): string | null {
  const messageIndex = text.lastIndexOf(message);
  if (messageIndex === -1) return null;
  const braceIndex = text.indexOf("{", messageIndex + message.length);
  if (braceIndex === -1) return null;
  return text.slice(braceIndex).trimEnd();
}

export function readTrailingContext(text: string, message: string): unknown {
  const raw = readTrailingContextRaw(text, message);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

// --- Shared graders ----------------------------------------------------------

/**
 * The core terms every scenario in this family declares.
 *
 * One accumulator per operation the emit path performs on every line, so an
 * operation that is deleted cannot hide behind an aggregate another operation
 * still satisfies:
 *
 *   `levelGateMisses`       — `shouldLog`, both directions: a logger overridden
 *                             to `"off"` must write nothing, and an un-overridden
 *                             one must write.
 *   `keyRedactionMisses`    — `redactSensitiveData`'s key gate, both directions:
 *                             `token` / `apiKey` become `[redacted]`, and a
 *                             benign key's value survives byte-for-byte.
 *   `clampMisses`           — `clampLogString`, both directions: a 5,000-char
 *                             value is cut at this fixture's own bound with a
 *                             tail naming the exact number of characters
 *                             dropped, and a short value is left alone.
 *   `bufferMisses`          — the real 500-entry `LogBuffer` ring holds the
 *                             entry, and does NOT hold a suppressed one.
 *   `stringifyMisses`       — `safe-stable-stringify` ran: the context parses,
 *                             its keys come out SORTED (a plain `JSON.stringify`
 *                             would preserve insertion order), and the depth and
 *                             array clamps appear where predicted.
 *   `secretSurvivalMisses`  — ZERO planted synthetic secrets reached any file.
 *   `markerSurvivalMisses`  — every planted NON-secret marker did reach a file,
 *                             as many times as it was planted.
 *   `lineCountMisses`       — entries in the files equal entries handed to the
 *                             logger, counted at the call site.
 *   `consoleMirrorMisses`   — the console transport fired once per entry, which
 *                             is what separates "nothing was emitted" from
 *                             "nothing was written".
 *
 * The last two of the survival pair are the point of the family: a scrubber
 * stubbed to redact everything satisfies `secretSurvivalMisses` alone, and one
 * stubbed to redact nothing satisfies `markerSurvivalMisses` alone. Only both
 * together pin the subject.
 */
export interface CoreGrade {
  levelGateMisses: number;
  keyRedactionMisses: number;
  clampMisses: number;
  bufferMisses: number;
  stringifyMisses: number;
  secretSurvivalMisses: number;
  markerSurvivalMisses: number;
  lineCountMisses: number;
  consoleMirrorMisses: number;
}

export function emptyCoreGrade(): CoreGrade {
  return {
    levelGateMisses: 0,
    keyRedactionMisses: 0,
    clampMisses: 0,
    bufferMisses: 0,
    stringifyMisses: 0,
    secretSurvivalMisses: 0,
    markerSurvivalMisses: 0,
    lineCountMisses: 0,
    consoleMirrorMisses: 0,
  };
}

export function coreMisses(grade: CoreGrade): Record<string, number> {
  return {
    levelGateMisses: grade.levelGateMisses,
    keyRedactionMisses: grade.keyRedactionMisses,
    clampMisses: grade.clampMisses,
    bufferMisses: grade.bufferMisses,
    stringifyMisses: grade.stringifyMisses,
    secretSurvivalMisses: grade.secretSurvivalMisses,
    markerSurvivalMisses: grade.markerSurvivalMisses,
    lineCountMisses: grade.lineCountMisses,
    consoleMirrorMisses: grade.consoleMirrorMisses,
  };
}

/** Marker on the entries the level gate must suppress. Never a real secret. */
export const QUIET_MARKER = "zz-perfquiet-gamma-zz";
const GRADE_QUIET_ENTRIES = 3;
const GRADE_PLANTED_ENTRIES = 12;
/** Comfortably above the planted head's own floor (~470 chars). */
const GRADE_MESSAGE_BYTES = 768;

export function structMessageFor(token: string): string {
  return `${token} ${SURVIVOR_MARKER} structural probe`;
}

/**
 * Run the shared two-directional probes against the real emit path.
 *
 * Off the clock, in a corpus directory of its own, so nothing here perturbs a
 * scenario's per-entry numbers. Every expectation is either arithmetic this
 * fixture did itself or a tally incremented at the call site — never a second
 * call into the subject asking it what it thinks it produced.
 */
export async function gradeCore(harness: LoggingHarness): Promise<CoreGrade> {
  const grade = emptyCoreGrade();

  await harness.resetCorpus();
  assertInsideTempRoot(harness.logDir());

  const token = harness.token();
  const structMessage = structMessageFor(token);

  let expectedMarkers = 0;
  let expectedContextMarkers = 0;
  const plant = (message: string, context: Record<string, unknown>): void => {
    // Counted at the call site from this fixture's own inputs. Every marker
    // planted here sits inside the first `MAX_REDACT_STRING_CHARS` of its
    // field, so no clamp can drop one and make the expectation a lie.
    const contextJson = JSON.stringify(context);
    expectedMarkers += countOccurrences(message, SURVIVOR_MARKER);
    expectedMarkers += countOccurrences(contextJson, SURVIVOR_MARKER);
    expectedContextMarkers += countOccurrences(message, SURVIVOR_MARKER_CONTEXT);
    expectedContextMarkers += countOccurrences(contextJson, SURVIVOR_MARKER_CONTEXT);
    harness.emit("info", message, context);
  };

  const restoreConsole = harness.captureConsole();
  let consoleCount: number;
  try {
    // Level gate, suppressing direction. Driven through the product's own
    // public override API rather than a stub, because `shouldLog` has no module
    // boundary to break.
    harness.modules.setLogLevelOverrides({ [harness.quietLogger.name]: "off" });
    for (let index = 0; index < GRADE_QUIET_ENTRIES; index += 1) {
      harness.quietLogger.info(`${QUIET_MARKER} suppressed ${index}`, buildSmallContext());
    }
    harness.modules.setLogLevelOverrides(baselineOverrides());

    for (let index = 0; index < GRADE_PLANTED_ENTRIES; index += 1) {
      plant(buildSecretMessage(token, index, GRADE_MESSAGE_BYTES, SECRET_PLANTS.length), {
        marker: SURVIVOR_MARKER_CONTEXT,
        stdout: SECRET_PLANTS[index % SECRET_PLANTS.length]!.literal,
      });
    }

    // LAST, so its pretty-printed context runs to end of file and can be parsed
    // back out without splitting on newlines.
    plant(structMessage, structContext());
  } finally {
    consoleCount = restoreConsole();
  }

  await harness.flush();
  const files = harness.readLogFiles();
  const emitted = harness.emittedEntryCount();

  // Level gate, both directions.
  grade.levelGateMisses += countAcrossFiles(files, QUIET_MARKER);
  if (countAcrossFiles(files, token) === 0) grade.levelGateMisses += 1;

  grade.lineCountMisses = Math.abs(countAcrossFiles(files, token) - emitted);
  grade.consoleMirrorMisses = Math.abs(consoleCount - emitted);

  for (const secret of SECRET_PLANTS) {
    grade.secretSurvivalMisses += countAcrossFiles(files, secret.literal);
  }
  grade.markerSurvivalMisses =
    Math.abs(countAcrossFiles(files, SURVIVOR_MARKER) - expectedMarkers) +
    Math.abs(countAcrossFiles(files, SURVIVOR_MARKER_CONTEXT) - expectedContextMarkers);

  const text = files.map((file) => file.text).join("");
  const parsed = readTrailingContext(text, structMessage);
  const expectation = structExpectation();

  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    grade.stringifyMisses += 1;
    grade.keyRedactionMisses += 1;
    grade.clampMisses += 1;
  } else {
    const record = parsed as Record<string, unknown>;

    if (Object.keys(record).join(",") !== STRUCT_SORTED_KEYS.join(",")) grade.stringifyMisses += 1;
    if (!jsonEqual(record.nested, expectation.nested)) grade.stringifyMisses += 1;
    if (!jsonEqual(record.items, expectation.items)) grade.stringifyMisses += 1;

    if (record.token !== "[redacted]") grade.keyRedactionMisses += 1;
    if (record.apiKey !== "[redacted]") grade.keyRedactionMisses += 1;
    if (record.stdout !== REDACTION_MARKER) grade.keyRedactionMisses += 1;
    if (record.sessionId !== SURVIVOR_MARKER_CONTEXT) grade.keyRedactionMisses += 1;
    if (record.attempt !== 42) grade.keyRedactionMisses += 1;

    if (record.longNote !== expectation.longNote) grade.clampMisses += 1;
    if (record.note !== STRUCT_NOTE) grade.clampMisses += 1;
  }

  // The in-memory ring, read back rather than re-derived. It holds the RAW
  // message by design — `secretScrubber.ts` names the logBuffer as explicitly
  // NOT an outbound boundary — so this checks presence only, never content.
  const buffered = harness.logBuffer.getAll();
  if (!buffered.some((entry) => entry.message === structMessage)) grade.bufferMisses += 1;
  if (buffered.some((entry) => entry.message.includes(QUIET_MARKER))) grade.bufferMisses += 1;

  return grade;
}
