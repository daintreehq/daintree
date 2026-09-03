/**
 * Short-lived JSON-RPC client for `codex app-server --listen stdio://`.
 *
 * Daintree reads a Codex session's spawned subagent threads through the
 * documented app-server protocol instead of scraping the terminal or the
 * legacy rollout JSONL. One process is spawned per logical operation — the
 * handshake is ~40ms and a `useStateDbOnly` query is single-digit ms, so
 * holding a server open would buy nothing and cost an ownership problem
 * across panel unmount, view eviction, crash recovery and `app.quit()`.
 *
 * Two hard boundaries live here rather than in a caller:
 *
 *   1. `ALLOWED_METHODS` is enforced before anything reaches stdin. The
 *      protocol's `thread/start` marks a project trusted in the user's
 *      `~/.codex/config.toml`, and writing user-owned agent config is out of
 *      bounds for this app. An allowlist in the transport means no future
 *      caller — or bug — can reach it.
 *   2. Every settle path that bypasses a clean `close` reaps the process
 *      group, mirroring `AgentVersionService.runVersionProbe`. That reaping
 *      must include the ordinary exit-grace path, not just the deadline
 *      backstop: wiring it only to failure paths leaked a detached group per
 *      call last time (#10705).
 */

import { spawn, spawnSync, type ChildProcess } from "child_process";
import { buildProbeEnv } from "../../utils/spawnEnv.js";
import { scrubSecrets } from "../../../shared/utils/secretScrubber.js";
import type { AgentSubagentUnavailableReason } from "../../../shared/types/ipc/agentSubagents.js";

/**
 * Read-only surface. `thread/start` is absent by design — see the file header.
 * Held in a module-private frozen tuple rather than an exported `Set`, which
 * any importer could have added to.
 */
const ALLOWED_METHODS = Object.freeze([
  "initialize",
  "thread/list",
  "thread/read",
  "thread/turns/list",
] as const);

export function isAllowedCodexAppServerMethod(method: string): boolean {
  return (ALLOWED_METHODS as readonly string[]).includes(method);
}

/** Whole-session budget: the wait for a slot, spawn, handshake, every query, teardown. */
const SESSION_TIMEOUT_MS = 15_000;
/** Per-request budget, so one wedged call can't eat the whole session. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Grace for stdout to flush after `exit` before the group is reaped. */
const EXIT_DRAIN_MS = 200;
/** Cap on buffered stdout. A page of threads is kilobytes; this is generous. */
const MAX_BUFFER = 4 * 1024 * 1024;

export class CodexAppServerError extends Error {
  readonly reason: AgentSubagentUnavailableReason;

  constructor(reason: AgentSubagentUnavailableReason, message: string, options?: ErrorOptions) {
    super(scrubSecrets(message), options);
    this.name = "CodexAppServerError";
    this.reason = reason;
  }
}

export type CodexAppServerCall = <T>(method: string, params?: unknown) => Promise<T>;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A project restore mounts every Codex pane at once, and each asks for its own
 * subagents. Without a gate that is N concurrent `codex app-server` processes;
 * with one it is a short queue, and each query is single-digit milliseconds
 * once the server is up.
 */
const MAX_CONCURRENT_SESSIONS = 2;
let activeSessions = 0;
const sessionQueue: Array<() => void> = [];

/**
 * The wait for a slot counts against the caller's budget, not on top of it.
 * A restore-time lookup queued behind two wedged sessions would otherwise sit
 * here for as long as they take, which is precisely when the gate is busiest —
 * the cap above exists because a restore mounts every Codex pane at once.
 */
function acquireSessionSlot(deadlineAt: number): Promise<void> {
  if (activeSessions < MAX_CONCURRENT_SESSIONS) {
    activeSessions++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    // Whichever of these two runs first disarms the other: the waiter clears
    // the timer, and the timer drops the waiter from the queue. So a slot can
    // never be handed to a caller that already gave up and left it leaked.
    // `waiter` closes over `timer` before it is assigned, which is safe — it
    // only ever runs from the queue, long after this function has returned.
    const waiter = (): void => {
      clearTimeout(timer);
      activeSessions++;
      resolve();
    };
    const timer = setTimeout(
      () => {
        const index = sessionQueue.indexOf(waiter);
        if (index !== -1) sessionQueue.splice(index, 1);
        reject(new CodexAppServerError("timeout", "Codex app-server timed out awaiting a slot"));
      },
      Math.max(0, deadlineAt - Date.now())
    );
    timer.unref?.();
    sessionQueue.push(waiter);
  });
}

function releaseSessionSlot(): void {
  activeSessions--;
  sessionQueue.shift()?.();
}

export interface CodexAppServerSessionOptions {
  /** Overridable so tests don't depend on a `codex` binary being installed. */
  command?: string;
  timeoutMs?: number;
  requestTimeoutMs?: number;
  /**
   * Overrides main's own `CODEX_HOME` for this session. A caller asking on
   * behalf of a specific pane must pass the pane's own launch env here when it
   * carries one (#12182) — without it, this client silently queries the
   * default profile even though the pane itself ran against a redirected one.
   */
  codexHome?: string;
}

function classifySpawnError(error: NodeJS.ErrnoException): CodexAppServerError {
  if (error.code === "ENOENT") {
    return new CodexAppServerError("cli-missing", "Codex CLI not found on PATH", { cause: error });
  }
  return new CodexAppServerError("protocol-error", `Codex app-server failed: ${error.message}`, {
    cause: error,
  });
}

/**
 * `buildProbeEnv()` allowlists only what's needed to resolve and run a CLI, so
 * it deliberately omits `CODEX_HOME`. That variable is a directory path rather
 * than a credential, and omitting it would silently point the query at the
 * default profile while the terminal itself runs against a relocated one.
 *
 * Falls back to inheriting main's own `CODEX_HOME` when no override is given.
 * A caller that knows which pane it's asking on behalf of should pass
 * `options.codexHome` — main's own env has no relation to a pane's redirected
 * profile, so without it a query can silently run against the wrong index
 * (#12182). Callers with no specific pane in mind (e.g. resume-latest
 * resolution, which only ever asks against main's own profile today) are
 * unaffected either way.
 */
function buildAppServerEnv(codexHomeOverride?: string): NodeJS.ProcessEnv {
  const env = buildProbeEnv();
  const codexHome = codexHomeOverride ?? process.env.CODEX_HOME;
  if (codexHome) env.CODEX_HOME = codexHome;
  return env;
}

/**
 * Spawn an app-server, complete the handshake, hand `run` a typed `call`, and
 * tear the process down however `run` settles.
 *
 * `run` must not retain `call` past its own resolution — the process is gone.
 */
export async function runCodexAppServerSession<T>(
  run: (call: CodexAppServerCall) => Promise<T>,
  options: CodexAppServerSessionOptions = {}
): Promise<T> {
  const deadlineAt = Date.now() + (options.timeoutMs ?? SESSION_TIMEOUT_MS);
  await acquireSessionSlot(deadlineAt);
  try {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new CodexAppServerError("timeout", "Codex app-server timed out awaiting a slot");
    }
    return await spawnCodexAppServerSession(run, { ...options, timeoutMs: remainingMs });
  } finally {
    releaseSessionSlot();
  }
}

async function spawnCodexAppServerSession<T>(
  run: (call: CodexAppServerCall) => Promise<T>,
  options: CodexAppServerSessionOptions
): Promise<T> {
  const command = options.command ?? "codex";
  const timeoutMs = options.timeoutMs ?? SESSION_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  // POSIX process groups let the deadline reap a grandchild that inherited the
  // stdout pipe. Windows has none here, so it falls back to `taskkill /T`.
  const useGroup = process.platform !== "win32";

  let child: ChildProcess;
  try {
    child = spawn(command, ["app-server", "--listen", "stdio://"], {
      shell: false,
      windowsHide: true,
      env: buildAppServerEnv(options.codexHome),
      detached: useGroup,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw classifySpawnError(error as NodeJS.ErrnoException);
  }

  // Detached + unref'd so an in-flight query can't pin main-process teardown
  // during `app.quit()`. unref only drops the event-loop ref-count; the
  // ChildProcess object stays referenced here and its events still deliver.
  child.unref();

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let stdoutBuffer = "";
  let stderr = "";
  let disposed = false;
  let failure: Error | null = null;

  const killTree = (): void => {
    const pid = child.pid;
    if (typeof pid !== "number") return;
    if (!useGroup) {
      try {
        const result = spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
          windowsHide: true,
          stdio: "ignore",
          timeout: 3000,
        });
        // spawnSync reports failure in the result, not by throwing. status 0 =
        // killed, 128 = already gone (benign). Anything else left the tree alive.
        if (result?.error) {
          console.warn(`[CodexAppServer] taskkill pid=${pid}: ${result.error.message}`);
        } else if (result && result.status !== 0 && result.status !== 128) {
          console.warn(`[CodexAppServer] taskkill pid=${pid} exited ${result.status}`);
        }
      } catch (error) {
        console.warn(`[CodexAppServer] taskkill pid=${pid}: ${String(error)}`);
      }
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ESRCH means the group is already gone. EPERM/EINVAL mean it may still
      // be alive and the operator needs to know.
      if (code !== "ESRCH") {
        console.warn(`[CodexAppServer] SIGKILL group pid=${pid}: ${String(error)}`);
      }
    }
  };

  /** Fail every in-flight request once, and refuse any that arrive after. */
  const failAll = (error: Error): void => {
    if (!failure) failure = error;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  // Declared before `dispose` so the clearTimeout below never reads a binding
  // in its temporal dead zone, whatever order the child's events arrive in.
  let sessionTimer: ReturnType<typeof setTimeout> | null = null;

  const dispose = (reap: boolean): void => {
    if (disposed) return;
    disposed = true;
    if (sessionTimer) clearTimeout(sessionTimer);
    // Anything `run` left in flight settles now rather than idling until its
    // own 10s timer. Harmless on the happy path, where nothing is pending.
    failAll(new CodexAppServerError("protocol-error", "Codex app-server session ended"));
    if (reap) killTree();
    // Drop only `data`, keeping the no-op `error` sinks below alive: destroy()
    // can surface a pending EIO/EBADF on the next tick, and an unhandled
    // stream error is fatal in the main process.
    child.stdout?.removeAllListeners("data");
    child.stderr?.removeAllListeners("data");
    try {
      child.stdin?.end();
    } catch {
      // stdin may already be closed; nothing to recover.
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
  };

  let onDeadline: (() => void) | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    onDeadline = () => reject(new CodexAppServerError("timeout", "Codex app-server timed out"));
  });
  // Nothing awaits `deadline` unless the race below does, and an unawaited
  // rejection is fatal in the main process.
  deadline.catch(() => {});

  sessionTimer = setTimeout(() => {
    failAll(new CodexAppServerError("timeout", "Codex app-server timed out"));
    dispose(true);
    onDeadline?.();
  }, timeoutMs);
  sessionTimer.unref?.();

  // A pipe error (EBADF/EIO on a dead fd) on a piped stream becomes an
  // uncaughtException if unhandled. These sinks must outlive dispose().
  child.stdout?.on("error", () => {});
  child.stderr?.on("error", () => {});
  child.stdin?.on("error", () => {});

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) handleLine(line);
      newline = stdoutBuffer.indexOf("\n");
    }
    // The cap guards the *unterminated* remainder, not total throughput: a
    // long series of ordinary responses is fine, a single frame that never
    // ends is a server we can't parse and shouldn't buffer forever.
    if (stdoutBuffer.length > MAX_BUFFER) {
      failAll(new CodexAppServerError("protocol-error", "Codex app-server output exceeded limit"));
      dispose(true);
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length >= MAX_BUFFER) return;
    stderr += chunk.toString();
  });

  function handleLine(line: string): void {
    let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
    try {
      message = JSON.parse(line);
    } catch {
      // Notifications and responses share the stream; a malformed line is the
      // server's problem, not a reason to fail queries that may still succeed.
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      const detail =
        typeof message.error.message === "string"
          ? message.error.message
          : JSON.stringify(message.error);
      entry.reject(new CodexAppServerError("protocol-error", `Codex app-server: ${detail}`));
      return;
    }
    entry.resolve(message.result);
  }

  child.on("error", (error: NodeJS.ErrnoException) => {
    failAll(classifySpawnError(error));
    dispose(false);
  });

  // `exit` does not guarantee stdout is flushed, so we never settle on it
  // directly — a short grace lets a queued response land, then the group is
  // reaped so a grandchild holding the pipe can't outlive the query.
  const earlyExitError = (): CodexAppServerError =>
    new CodexAppServerError(
      "protocol-error",
      `Codex app-server exited early${stderr.trim() ? `: ${stderr.trim().slice(-400)}` : ""}`
    );

  child.on("exit", () => {
    if (disposed) return;
    const graceTimer = setTimeout(() => {
      if (disposed) return;
      failAll(earlyExitError());
      dispose(true);
    }, EXIT_DRAIN_MS);
    graceTimer.unref?.();
  });

  child.on("close", () => {
    if (disposed) return;
    // Every fd-holder has exited, so there is nothing left to reap.
    failAll(earlyExitError());
    dispose(false);
  });

  const call: CodexAppServerCall = <T>(method: string, params?: unknown): Promise<T> => {
    if (!isAllowedCodexAppServerMethod(method)) {
      return Promise.reject(
        new CodexAppServerError("protocol-error", `Method not permitted: ${method}`)
      );
    }
    if (disposed || failure) {
      return Promise.reject(
        failure ?? new CodexAppServerError("protocol-error", "Codex app-server session ended")
      );
    }
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(new CodexAppServerError("timeout", `Codex app-server timed out on ${method}`));
      }, requestTimeoutMs);
      timer.unref?.();
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        child.stdin?.write(`${JSON.stringify({ id, method, params: params ?? {} })}\n`);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(
          new CodexAppServerError(
            "protocol-error",
            `Codex app-server write failed: ${String(error)}`
          )
        );
      }
    });
  };

  try {
    await call("initialize", {
      // `version` is this integration's protocol-client revision, not the app
      // version — it only lands in the server's user-agent string, and pulling
      // in `electron.app` here would cost the transport its plain-Node tests.
      clientInfo: { name: "daintree", title: "Daintree", version: "1" },
      // Unlocks the `parentThreadId` filter, `canAcceptDirectInput`, and
      // `thread/turns/list`. Purely a client-capability declaration.
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    // Notification, not a request — no id, no response.
    try {
      child.stdin?.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    } catch (error) {
      throw new CodexAppServerError(
        "protocol-error",
        `Codex app-server handshake failed: ${String(error)}`
      );
    }
    // Raced rather than awaited: `run` may be waiting on something this
    // transport cannot see, and a callback that never settles would hold its
    // concurrency slot for the life of the process.
    return await Promise.race([run(call), deadline]);
  } finally {
    // Reap unconditionally: a session that returned normally still leaves the
    // server running, since it only exits when its stdin closes.
    dispose(true);
  }
}
