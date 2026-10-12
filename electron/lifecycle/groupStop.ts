// eager-import-allow: reads /proc synchronously at startup and on a termination signal, where the answer is needed before Chromium's next task
//
// A termination signal sent to the whole process group — systemd stopping a
// session scope at logout or shutdown, `pkill daintree` (every helper process
// is named `daintree`), Ctrl+C in a dev terminal — reaches Chromium's own
// children in the same instant as Main. On Linux Chromium then relaunches the
// GPU process from a zygote that died in the same signal, and after a handful
// of failed launches aborts the browser ("GPU process isn't usable. Goodbye.")
// within milliseconds — far sooner than the graceful chain lets the message
// loop exit, and Chromium launches nothing once it has. Everything that chain
// would wait on is being terminated by the same signal anyway, so a group stop
// is finished at once instead (L12). The signal handler also switches off the
// GPU fallback count (appLifecycle.ts), so a group stop recognised a little
// late costs failed relaunches rather than that abort.
//
// Main cannot tell who a signal was sent to, so on Linux it looks at Chromium's
// zygotes: they live as long as the browser, so one that is dying is both the
// evidence of a group stop and the reason no GPU process can be launched
// again. The kernel marks a process killed by a default-action signal the
// moment the signal is sent, well before Main's JavaScript handler runs.
// `child-process-gone` cannot stand in for this there: a zygote-launched
// child's exit status is fetched from its zygote, and a dead zygote reports it
// as a clean exit, which Electron never emits. Elsewhere a Chromium child
// killed by a signal next to Main's own is the evidence — Daintree never
// signals the GPU process or Chromium's own services.
//
// appLifecycle.ts calls in from the signal handler and shutdown.ts registers
// the finisher, so neither imports the other.

import fs from "node:fs";
import type { Details } from "electron";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("main:GroupStop");

// A group signal is delivered to every process within microseconds. The window
// covers Main handling its signal and a child's death in either order, and
// bounds how long Main keeps looking after its own signal.
export const GROUP_STOP_WINDOW_MS = 1_000;
const WATCH_INTERVAL_MS = 20;

// /proc/<pid>/stat flags bit set once a task has begun exiting.
const PF_EXITING = 0x4;
// SIGHUP, SIGINT, SIGKILL, SIGTERM. A fatal signal sent to a process with the
// default action is queued as SIGKILL on each of its threads.
const TERMINATING_SIGNALS = [1, 2, 9, 15];

type ChildProcessGone = Pick<Details, "type" | "reason" | "serviceName">;
type ReadProcFile = (procPath: string) => string;

/** A process as /proc names it: the pid alone could be reused once it is reaped. */
export interface ProcIdentity {
  pid: number;
  startTime: string;
}

/**
 * What /proc shows of a process. `gone`: reaped. `replaced`: its pid now names
 * another process. `exited`: a zombie. `exiting`: tearing down. `signalled`: a
 * terminating signal is pending. `unreadable` counts as alive.
 */
export type ProcState =
  "running" | "unreadable" | "gone" | "replaced" | "exited" | "exiting" | "signalled";

const TERMINATING_STATES: ReadonlySet<ProcState> = new Set<ProcState>([
  "gone",
  "replaced",
  "exited",
  "exiting",
  "signalled",
]);

export interface ChildProbe {
  terminating: boolean;
  /** `pid=state` per zygote, for the log. */
  summary: string;
}

const readProcFile: ReadProcFile = (procPath) => fs.readFileSync(procPath, "utf8");
const listMainThreads = (): string[] => fs.readdirSync("/proc/self/task");

let zygotes: ProcIdentity[] = [];
let signalAt: number | null = null;
let lastChildSignalKillAt: number | null = null;
let finisher: (() => boolean) | null = null;
let finished = false;
let recognised = false;
let lastProbe: ChildProbe = { terminating: false, summary: "none" };
let watchTimer: ReturnType<typeof setTimeout> | null = null;

function probeZygotes(): ChildProbe {
  const states = zygotes.map((zygote) => [zygote.pid, readProcessState(zygote)] as const);
  return {
    terminating: states.some(([, state]) => TERMINATING_STATES.has(state)),
    summary: states.map(([pid, state]) => `${pid}=${state}`).join(" ") || "none",
  };
}

let probeChildren: () => ChildProbe = probeZygotes;

export function isChromiumChildSignalKill(details: ChildProcessGone): boolean {
  if (details.reason !== "killed") return false;
  if (details.type === "GPU") return true;
  // Chromium's own services carry their mojo interface as the service name
  // (`network.mojom.NetworkService`); Daintree's utility processes never do.
  return details.type === "Utility" && (details.serviceName ?? "").includes(".mojom.");
}

function isGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

// Fields after `comm`, which can itself contain spaces and parentheses:
// [0] is field 3 (state), [6] field 9 (flags), [19] field 22 (starttime).
function statFields(stat: string): string[] {
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

function pendingSignals(status: string, field: "SigPnd" | "ShdPnd"): bigint {
  const match = new RegExp(`^${field}:\\s*([0-9a-fA-F]+)\\s*$`, "m").exec(status);
  return match ? BigInt(`0x${match[1]}`) : 0n;
}

export function readProcessState(
  identity: ProcIdentity,
  read: ReadProcFile = readProcFile
): ProcState {
  let stat: string;
  try {
    stat = read(`/proc/${identity.pid}/stat`);
  } catch (err) {
    return isGone(err) ? "gone" : "unreadable";
  }
  const fields = statFields(stat);
  if (fields[19] !== identity.startTime) return "replaced";
  if (fields[0] === "Z" || fields[0] === "X") return "exited";
  const flags = Number(fields[6]);
  if (Number.isFinite(flags) && (flags & PF_EXITING) !== 0) return "exiting";

  let status: string;
  try {
    status = read(`/proc/${identity.pid}/status`);
  } catch (err) {
    return isGone(err) ? "gone" : "unreadable";
  }
  const pending = pendingSignals(status, "SigPnd") | pendingSignals(status, "ShdPnd");
  const signalled = TERMINATING_SIGNALS.some((sig) => ((pending >> BigInt(sig - 1)) & 1n) === 1n);
  return signalled ? "signalled" : "running";
}

export function isProcessTerminating(
  identity: ProcIdentity,
  read: ReadProcFile = readProcFile
): boolean {
  return TERMINATING_STATES.has(readProcessState(identity, read));
}

// Chromium rewrites each child's command line into one space-separated title
// (setproctitle), so the arguments are not NUL-separated by the time Main reads
// them.
function isZygoteCommandLine(cmdline: string): boolean {
  return cmdline.split(/[\s\0]+/).includes("--type=zygote");
}

/**
 * Chromium's zygotes, which are Main's own children and fork every GPU process
 * and renderer. Only a live zygote can be recognised — a zombie's command line
 * is empty — so they are found while the app is running.
 */
export function findZygotes(
  read: ReadProcFile = readProcFile,
  listThreads: () => string[] = listMainThreads
): ProcIdentity[] {
  let threads: string[];
  try {
    threads = listThreads();
  } catch {
    return [];
  }
  const found = new Map<number, ProcIdentity>();
  for (const tid of threads) {
    let children: string;
    try {
      children = read(`/proc/self/task/${tid}/children`);
    } catch {
      continue;
    }
    for (const token of children.trim().split(/\s+/)) {
      const pid = Number(token);
      if (!Number.isInteger(pid) || pid <= 0 || found.has(pid)) continue;
      try {
        if (!isZygoteCommandLine(read(`/proc/${pid}/cmdline`))) continue;
        const startTime = statFields(read(`/proc/${pid}/stat`))[19];
        if (startTime) found.set(pid, { pid, startTime });
      } catch {
        // Exited while being looked at.
      }
    }
  }
  return [...found.values()];
}

/**
 * Called once at startup. Chromium forks its zygotes before any JavaScript
 * runs and never replaces them, so this is the set a group stop will kill.
 */
export function rememberChromiumZygotes(): void {
  if (process.platform !== "linux") return;
  zygotes = findZygotes();
  logger.info(`Watching ${zygotes.length} Chromium zygote(s) for a group stop`, {
    pids: zygotes.map((zygote) => zygote.pid),
  });
}

/**
 * Registered by shutdown.ts: ends the shutdown now, returning false when it
 * declines (an update install or relaunch owns it, smoke tests).
 */
export function setGroupStopFinisher(fn: (() => boolean) | null): void {
  finisher = fn;
}

/** `child-process-gone` hook, installed for the whole life of the process. */
export function noteChildProcessGone(details: ChildProcessGone, now = Date.now()): void {
  if (isChromiumChildSignalKill(details)) lastChildSignalKillAt = now;
  recheckAfterDeath();
}

/** `render-process-gone` hook: renderers die in the same signal. */
export function noteRendererGone(): void {
  recheckAfterDeath();
}

// Only once Main has had its own termination signal. Deferred one turn
// because these hooks run inside Chromium's teardown of the dead child, and
// finishing destroys every window.
function recheckAfterDeath(): void {
  if (signalAt === null || finished) return;
  setImmediate(() => {
    evaluate("after a child process died");
  });
}

function evaluate(when: string): boolean {
  if (finished) return true;
  const killNearSignal =
    lastChildSignalKillAt !== null &&
    signalAt !== null &&
    Math.abs(lastChildSignalKillAt - signalAt) <= GROUP_STOP_WINDOW_MS;
  lastProbe = probeChildren();
  if (!killNearSignal && !lastProbe.terminating) return false;
  if (!recognised) {
    recognised = true;
    const elapsed = signalAt === null ? 0 : Date.now() - signalAt;
    logger.info(`Group stop recognised ${when}, ${elapsed}ms after the termination signal`, {
      zygotes: lastProbe.summary,
      chromiumChildKilled: killNearSignal,
    });
  }
  if (finisher?.()) {
    finished = true;
    stopWatch();
  }
  return true;
}

// The sender may reach the zygotes a moment after Main, and their deaths raise
// no event of their own, so Main keeps looking for the rest of the window.
function watch(until: number): void {
  watchTimer = setTimeout(() => {
    watchTimer = null;
    if (evaluate("while watching")) return;
    if (Date.now() >= until) {
      logger.info(
        `No group stop within ${GROUP_STOP_WINDOW_MS}ms of the termination signal; the graceful shutdown continues`,
        { zygotes: lastProbe.summary }
      );
      return;
    }
    watch(until);
  }, WATCH_INTERVAL_MS);
  watchTimer.unref?.();
}

function stopWatch(): void {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = null;
}

/**
 * Called by the signal handler once its quit has claimed the shutdown: ends
 * it now if the signal reached Chromium's own processes too, and otherwise
 * keeps checking for the rest of the window.
 */
export function finishIfGroupStop(now = Date.now()): boolean {
  if (signalAt === null) {
    signalAt = now;
    // The zygotes are normally remembered at startup; a missed scan is retried
    // in case they are still alive.
    if (zygotes.length === 0) rememberChromiumZygotes();
  }
  if (evaluate("on the signal")) return true;
  if (watchTimer) return false;
  if (probeChildren === probeZygotes && zygotes.length === 0) {
    logger.info(
      "Termination signal: no Chromium zygotes to watch; only a Chromium child killed next to it shows a group stop"
    );
    return false;
  }
  logger.info(
    "Termination signal: Chromium's zygotes are still running; watching for a group stop",
    {
      zygotes: lastProbe.summary,
    }
  );
  watch(now + GROUP_STOP_WINDOW_MS);
  return false;
}

export function setChromiumChildProbeForTests(probe: (() => ChildProbe) | null): void {
  probeChildren = probe ?? probeZygotes;
}

export function resetGroupStopForTests(): void {
  stopWatch();
  zygotes = [];
  signalAt = null;
  lastChildSignalKillAt = null;
  finisher = null;
  finished = false;
  recognised = false;
  lastProbe = { terminating: false, summary: "none" };
  probeChildren = probeZygotes;
}
