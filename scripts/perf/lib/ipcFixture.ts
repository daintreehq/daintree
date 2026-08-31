import { fork, type ChildProcess, type Serializable } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import v8 from "node:v8";

/**
 * A REAL cross-process boundary for the IPC scenarios (PERF-043..046).
 *
 * Daintree's utility hosts — `electron/workspace-host.ts` and
 * `electron/pty-host.ts` — are ordinary Node programs. Neither host entry
 * imports `electron`, and the only Electron-supplied thing either one requires
 * is `process.parentPort`, the `MessagePort` that `utilityProcess.fork()`
 * injects. (One transitive module, `utils/hardenedGit.ts`, does a lazy
 * `require("electron")`, but an absolute `DAINTREE_USER_DATA` short-circuits
 * that path, so nothing on the exercised routes needs an Electron runtime.)
 * The hosts therefore run unmodified under plain Node once something supplies
 * that port, and this fixture supplies it over a forked child's own IPC channel.
 *
 * What that buys, and what it does not:
 *   - The host is the real product host, in its own OS process, with its own
 *     event loop, its own native modules and its own real request handlers.
 *     The code under measurement is product code, not a stand-in.
 *   - The channel is Node's fork IPC in `serialization: "advanced"` mode, so
 *     payloads are encoded by the V8 structured-clone serializer — the same
 *     family Electron's `MessagePortMain` uses, not the same pipe. Wall-clock
 *     transit is therefore indicative, not authoritative.
 *   - Absent entirely: the main-process half. `WorkspaceHostProcess`,
 *     `PtyHostLifecycle`, `WorkspaceClient`, `PtyClient`, crash classification,
 *     restart backoff and state replay are NOT exercised, and neither is the
 *     renderer `MessagePort` that carries a terminal's visual output in
 *     production. Nothing here is evidence about those.
 *
 * This module is its own child entry point: forked with
 * `DAINTREE_PERF_UTILITY_HOST` set to a host path, it installs the parentPort
 * adapter and imports that host. Keeping both halves in one file avoids a
 * second entry file whose only job would be five lines of glue.
 */

const CHILD_HOST_ENV = "DAINTREE_PERF_UTILITY_HOST";

const SELF_PATH = fileURLToPath(import.meta.url);

export type UtilityHostKind = "workspace" | "pty";

const HOST_ENTRY: Record<UtilityHostKind, string> = {
  workspace: fileURLToPath(new URL("../../../electron/workspace-host.ts", import.meta.url)),
  pty: fileURLToPath(new URL("../../../electron/pty-host.ts", import.meta.url)),
};

/** Bounded stderr tail kept per host, so a boot failure is diagnosable. */
const STDERR_TAIL_LIMIT = 1500;

// --- Child half -------------------------------------------------------------

/**
 * Stand in for Electron's `process.parentPort`.
 *
 * The hosts use exactly four things from it: `on("message")`, `postMessage`,
 * and (defensively) `off`/`once`. Electron delivers a MessageEvent-shaped
 * `{ data, ports }`, which is what both hosts are written to unwrap
 * (`workspace-host.ts` and `pty-host.ts` each check for a `data` field), so the
 * wrapper is reproduced rather than passing the message through bare — a
 * request that happened to carry its own top-level `data` field would otherwise
 * be silently mis-unwrapped.
 *
 * `ports` is always empty: a forked child's IPC channel cannot transfer a
 * MessagePort, which is why the worktree-port and renderer-port fan-out paths
 * are out of reach here (see the module doc).
 */
function installParentPortAdapter(): void {
  const inbox = new EventEmitter();
  // The hosts attach one listener each; the default cap of 10 is ample, but a
  // warning printed onto a perf run's stderr would be pure noise.
  inbox.setMaxListeners(0);
  process.on("message", (message) => inbox.emit("message", { data: message, ports: [] }));

  const adapter = {
    on: (event: string, listener: (...args: unknown[]) => void) => inbox.on(event, listener),
    once: (event: string, listener: (...args: unknown[]) => void) => inbox.once(event, listener),
    off: (event: string, listener: (...args: unknown[]) => void) => inbox.off(event, listener),
    addListener: (event: string, listener: (...args: unknown[]) => void) =>
      inbox.on(event, listener),
    removeListener: (event: string, listener: (...args: unknown[]) => void) =>
      inbox.off(event, listener),
    postMessage: (message: unknown) => {
      process.send?.(message);
    },
    start: () => {},
    close: () => {},
  };

  (process as unknown as { parentPort: unknown }).parentPort = adapter;
}

// --- Parent half ------------------------------------------------------------

/**
 * Structured-clone size of one message's payload.
 *
 * This is the V8 serializer's encoding of the message, which is the encoding
 * `serialization: "advanced"` puts on the channel — but it is the PAYLOAD size,
 * not the wire size: it excludes Node's per-message length prefix and all of
 * Electron's Mojo framing, and it is measured by re-serializing the decoded
 * object rather than by tapping the pipe. It is a deterministic function of the
 * message, which is what makes it comparable between machines; read it as
 * "how big is this message", never as "how many bytes went down the socket".
 *
 * Never throws and never returns a non-finite number: `run.ts` rejects a
 * non-finite metric outright, and a byte counter that can poison a whole
 * scenario is worse than one that under-reports a pathological payload.
 */
export function serializedBytes(message: unknown): number {
  try {
    return v8.serialize(message).byteLength;
  } catch {
    try {
      return Buffer.byteLength(JSON.stringify(message) ?? "", "utf8");
    } catch {
      return 0;
    }
  }
}

const liveHosts = new Set<ChildProcess>();
let exitHookInstalled = false;

/**
 * Last-resort reaper. Every scenario kills its own host in a `finally`, so this
 * only ever fires for a host stranded by a throw between fork and try.
 *
 * A leaked utility host is not a slow number, it is a poisoned run: the pty-host
 * holds PTYs open and the workspace-host keeps polling and spawning git, and
 * every later scenario pays for it in CPU, memory, file descriptors and
 * scheduler contention. (It does NOT show up in the git-spawn counters —
 * `gitPipelineFixture` patches `ChildProcess.prototype` in THIS process, and a
 * leaked host has its own runtime — which is precisely what makes the leak
 * invisible unless something counts the processes.)
 */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;

  const killAll = (): void => {
    for (const child of liveHosts) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone; nothing to reap.
      }
    }
    liveHosts.clear();
    // After the hosts, not before: the workspace-host holds a SQLite file in
    // here, and removing it out from under a live host would be a different
    // kind of leak.
    if (sharedUserDataDir) {
      try {
        rmSync(sharedUserDataDir, { recursive: true, force: true });
      } catch {
        // A tmpdir left behind is untidy, never incorrect.
      }
      sharedUserDataDir = null;
    }
  };

  process.on("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    // Re-raising the default disposition after reaping: installing a handler
    // suppresses Node's own terminate-on-signal, and a perf harness that
    // ignores Ctrl-C is its own bug.
    process.on(signal, () => {
      killAll();
      process.exit(1);
    });
  }
}

let sharedUserDataDir: string | null = null;

function userDataDir(): string {
  if (!sharedUserDataDir) {
    sharedUserDataDir = mkdtempSync(join(tmpdir(), "daintree-perf-ipc-"));
  }
  return sharedUserDataDir;
}

export interface HostMessage {
  type?: string;
  [key: string]: unknown;
}

export interface SpawnUtilityHostOptions {
  kind: UtilityHostKind;
  extraEnv?: Record<string, string>;
}

/**
 * One live utility host plus the message and byte accounting for its channel.
 *
 * Counters are cumulative over the host's whole life. Scenarios that want a
 * phase reading take a {@link mark} before the phase and diff against it, the
 * same pattern the git-pipeline fixture uses for subprocess counts.
 */
export class UtilityHost {
  readonly kind: UtilityHostKind;
  private readonly child: ChildProcess;
  private readonly listeners = new Set<(message: HostMessage) => void>();
  private stderrTail = "";
  private exited = false;
  private exitedAt = 0;
  /** The channel is unusable. Weaker than `exited`: says nothing about the OS process. */
  private channelDead = false;
  private readonly channelDeadWaiters = new Set<() => void>();

  requestMessages = 0;
  responseMessages = 0;
  requestBytes = 0;
  responseBytes = 0;
  /** Messages the channel delivered that were not object-shaped. */
  malformedMessages = 0;

  constructor(options: SpawnUtilityHostOptions) {
    installExitHook();
    this.kind = options.kind;

    this.child = fork(SELF_PATH, [], {
      // Child processes do not inherit tsx's loader registration in a way that
      // survives every Node version, and the hosts are TypeScript source here,
      // not the built `dist-electron` output. Mirrors nodeParseWorkerTransport.
      execArgv: ["--import", "tsx"],
      // V8 structured clone, the closest available analogue of the Electron
      // MessagePort encoding. JSON mode would measure a different serializer.
      serialization: "advanced",
      // Host logging is verbose and goes to stdout; a perf run's report must
      // stay readable. stderr is piped rather than dropped so a failed boot
      // can say why.
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {
        ...process.env,
        [CHILD_HOST_ENV]: HOST_ENTRY[options.kind],
        DAINTREE_USER_DATA: userDataDir(),
        // Suppresses the PR-polling loop the coordinator role starts.
        DAINTREE_INSTANCE_ROLE: "worker",
        ...options.extraEnv,
      },
    });

    liveHosts.add(this.child);

    // Unref'd so a host that outlives its scenario despite the `finally` can
    // never hold the harness open. The scenarios' own timeouts keep the loop
    // alive while a measurement is in flight, so nothing is missed.
    this.child.unref();
    this.child.channel?.unref();

    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });

    this.child.on("message", (raw: unknown) => {
      this.responseMessages += 1;
      this.responseBytes += serializedBytes(raw);
      if (typeof raw !== "object" || raw === null) {
        this.malformedMessages += 1;
        return;
      }
      const message = raw as HostMessage;
      for (const listener of [...this.listeners]) listener(message);
    });

    // `exit` is the ONLY thing that marks this host gone. Anything looser and
    // `liveUtilityHostCount()` reports intentions rather than processes.
    this.child.on("exit", () => {
      this.exited = true;
      this.channelDead = true;
      this.exitedAt = performance.now();
      liveHosts.delete(this.child);
      for (const settle of [...this.channelDeadWaiters]) settle();
    });
    // A channel error settles pending waits so nothing runs to its timeout, but
    // it is NOT proof the process died: a failed kill or a disconnected IPC
    // channel both emit `error` over a process that is still running. Treating
    // it as an exit is exactly how a leak reads as a clean teardown.
    this.child.on("error", () => {
      this.channelDead = true;
      for (const settle of [...this.channelDeadWaiters]) settle();
    });
  }

  get alive(): boolean {
    return !this.exited;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  send(message: Serializable): void {
    this.requestMessages += 1;
    this.requestBytes += serializedBytes(message);
    try {
      this.child.send(message);
    } catch {
      // The channel is gone. Left silent on purpose: the caller's paired
      // `*Misses` reading is what reports it, and a throw here would abort a
      // scenario mid-measurement and lose every other number in it.
    }
  }

  onMessage(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Cumulative counters, for diffing a phase out of a host's whole life. */
  mark(): ChannelMark {
    return {
      requestMessages: this.requestMessages,
      responseMessages: this.responseMessages,
      requestBytes: this.requestBytes,
      responseBytes: this.responseBytes,
    };
  }

  since(mark: ChannelMark): ChannelMark {
    return {
      requestMessages: this.requestMessages - mark.requestMessages,
      responseMessages: this.responseMessages - mark.responseMessages,
      requestBytes: this.requestBytes - mark.requestBytes,
      responseBytes: this.responseBytes - mark.responseBytes,
    };
  }

  /**
   * Resolve on the first message matching `predicate`, or `null` on timeout or
   * on the host dying first. Never rejects: a null return is the caller's
   * `*Misses` reading, and a rejection would take the rest of the metrics with
   * it.
   */
  waitFor(
    predicate: (message: HostMessage) => boolean,
    timeoutMs: number
  ): Promise<HostMessage | null> {
    if (this.channelDead) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: HostMessage | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        this.channelDeadWaiters.delete(onDead);
        resolve(value);
      };
      const onDead = (): void => finish(null);
      const unsubscribe = this.onMessage((message) => {
        if (predicate(message)) finish(message);
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.channelDeadWaiters.add(onDead);
    });
  }

  /** Wait for `ready`. Returns the elapsed ms, or `null` if it never arrived. */
  async waitForReady(timeoutMs: number): Promise<number | null> {
    const started = performance.now();
    const ready = await this.waitFor((message) => message.type === "ready", timeoutMs);
    return ready ? performance.now() - started : null;
  }

  /**
   * Ask the host to shut itself down and wait for the process to actually go.
   * Returns the elapsed ms, or `null` if it did not exit cleanly.
   *
   * "Cleanly" means it exited on its own AND exited zero. Both halves matter: a
   * SIGKILLed host always "shuts down" instantly, and a host that crashes out of
   * `dispose` also exits promptly — neither is a graceful teardown, and the
   * duration alone cannot tell them apart from one.
   */
  async disposeGracefully(timeoutMs: number): Promise<number | null> {
    if (this.exited) return null;
    const started = performance.now();
    const gone = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    this.send({ type: "dispose" });
    const exitedOnItsOwn = await gone;
    if (!exitedOnItsOwn) {
      this.kill();
      return null;
    }
    if (this.child.exitCode !== 0) return null;
    return this.exitedAt > 0 ? this.exitedAt - started : performance.now() - started;
  }

  /**
   * Signal the host. Deliberately does NOT drop it from the live set: only the
   * `exit` event does that, so `liveUtilityHostCount()` reports processes that
   * are actually gone rather than processes we have asked to go.
   */
  kill(): void {
    try {
      this.child.kill("SIGKILL");
    } catch {
      // Already reaped.
    }
  }

  /** Resolve once the OS has actually reaped the process, bounded. */
  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

export interface ChannelMark {
  requestMessages: number;
  responseMessages: number;
  requestBytes: number;
  responseBytes: number;
}

export function spawnUtilityHost(options: SpawnUtilityHostOptions): UtilityHost {
  return new UtilityHost(options);
}

/**
 * Hosts this process still has alive. The structural-cardinality pairing for
 * every scenario here: a fast teardown number means nothing if the process is
 * still running.
 */
export function liveUtilityHostCount(): number {
  let alive = 0;
  for (const child of liveHosts) {
    if (child.exitCode === null && child.signalCode === null) alive += 1;
  }
  return alive;
}

// --- PTY output payload -----------------------------------------------------

export const PTY_LINE_MARKER = "PERFLINE";

let payloadScriptPath: string | null = null;

/**
 * A generator for a known, countable terminal payload.
 *
 * Written as a file rather than passed to `node -e` because the argument
 * crosses a PTY spawn, and Windows argv quoting through ConPTY is not a thing
 * to make a measurement depend on. Each line carries its own index, so the
 * receiver can prove which lines arrived rather than only how many bytes did.
 */
export function ptyPayloadScript(): string {
  if (!payloadScriptPath) {
    payloadScriptPath = join(userDataDir(), "perf-pty-payload.mjs");
    writeFileSync(
      payloadScriptPath,
      [
        "const total = Number(process.argv[2]);",
        "const pad = 'x'.repeat(24);",
        // Line at a time, the way a real command emits, so the host's own
        // chunking decides the message count rather than one giant write.
        "for (let i = 1; i <= total; i += 1) {",
        `  process.stdout.write(\`${PTY_LINE_MARKER}-\${i}-\${pad}\\n\`);`,
        "}",
        "",
      ].join("\n"),
      "utf8"
    );
  }
  return payloadScriptPath;
}

/**
 * Which of the expected lines actually arrived.
 *
 * The count of `data` messages is the headline number and it is a trap on its
 * own: a host that coalesces harder, or drops chunks outright, both report
 * fewer messages. Concatenating every chunk before matching heals a marker
 * split across a chunk boundary, so a miss here is a real loss.
 */
export function countDeliveredLines(text: string, expected: number): number {
  const seen = new Set<number>();
  const pattern = new RegExp(`${PTY_LINE_MARKER}-(\\d+)-`, "g");
  for (const match of text.matchAll(pattern)) {
    const index = Number(match[1]);
    if (Number.isInteger(index) && index >= 1 && index <= expected) seen.add(index);
  }
  return seen.size;
}

/** A requestId whose body is a nonce, so an echo proves the payload survived. */
export function nonceRequestId(prefix: string): string {
  let nonce = "";
  while (nonce.length < 64) nonce += Math.random().toString(36).slice(2);
  return `${prefix}-${nonce.slice(0, 64)}`;
}

// --- Child entry ------------------------------------------------------------

const childHostPath = process.env[CHILD_HOST_ENV];
if (childHostPath) {
  installParentPortAdapter();
  // `pathToFileURL` rather than the bare path: an absolute Windows path is not
  // a valid ESM specifier.
  void import(pathToFileURL(childHostPath).href);
}
