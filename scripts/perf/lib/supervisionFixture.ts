import { fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import nodeModule from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { serializedBytes } from "./ipcFixture";
import { createPerfTempRoot, releasePerfTempRoot } from "./tempRoots";
import {
  createWatchdog,
  HEARTBEAT_INTERVAL_MS,
  parseMainPid,
  writeWatchdogKillFlag,
  WATCHDOG_KILL_FLAG_NAME,
} from "../../../electron/watchdog-host-core";
import type { CrashType } from "../../../shared/types/pty-host";

/**
 * The MAIN-SIDE SUPERVISORS of Daintree's utility processes (PERF-260..264).
 *
 * `lib/ipcFixture.ts` and `lib/pluginHostFixture.ts` both name this half as the
 * thing they do not measure: "`WorkspaceHostProcess`, `PtyHostLifecycle`,
 * `WorkspaceClient`, `PtyClient`, crash classification, restart backoff and
 * state replay are NOT exercised". PERF-046 and PERF-224 answer how fast a
 * killed host comes back, never whether Daintree would have restarted it. This
 * fixture measures the decision instead of the respawn.
 *
 * What is REAL here — every supervisor is the shipped class, imported
 * unmodified and driven through its own public entry points:
 *   - `WorkspaceHostProcess`: the sliding crash window, the slow-OOM
 *     inter-crash detector, the full-jitter restart schedule, the give-up
 *     boundary, and the whole replay-on-`ready` block (log-level overrides,
 *     fetch throttle, forge provider matchers, merged monitor config).
 *   - `PtyHostLifecycle`: `classifyCrash`, `mapGoneReasonToCrashType`, the
 *     `exit`/`child-process-gone` ordering defer, the per-instance
 *     `serviceName` filter, the restart schedule and the give-up boundary.
 *   - `PtyClient` + `PtyShard`: placement, `pendingSpawns`, the lifecycle
 *     ledger's generation minting, and `respawnPendingForShard` — the replay
 *     that decides whether a terminal fleet survives a host crash.
 *   - `PluginDevWorkerHost`: crash accounting, the intentional-exit exemption,
 *     the crash-loop cap, and the bundle re-import on every (re)start.
 *   - `MainProcessWatchdogClient`: its own distinctly-parameterised jitter
 *     ladder, the stability timer, the cap, and the re-arming ping.
 *   - `watchdog-host-core`: measured with no stubs at all (see below).
 *
 * What is NOT real, stated as sharply as `ipcFixture` states its own:
 *   - THERE IS NO ELECTRON AND NO CHILD PROCESS. `utilityProcess.fork` returns
 *     an in-process stand-in, so the OS fork, Chromium's Mojo channel,
 *     `MessagePortMain` transfer and the real `child-process-gone` plumbing are
 *     all absent. Every crash here is a synthesised `exit` plus a synthesised
 *     `app.on("child-process-gone")` detail object. This is a measurement of
 *     what the supervisor DECIDES, never of what the OS does.
 *   - WALL CLOCK IS NOT RESPAWN TIME. `setTimeout` is replaced for the driven
 *     window by a recorder that captures each armed delay and fires it on
 *     demand, so a scheduled backoff is read as data instead of slept through.
 *     The durations these scenarios report are the supervisor's OWN work
 *     (exit handling, the classification defer, the replay burst), and exclude
 *     the scheduled backoff.
 *   - THE PROBE TIMES ITSELF, INSIDE THE CHILD. Every probe returns `probeMs`,
 *     bracketed after its supervisor imports have resolved, and each scenario
 *     reports that as its `durationMs` instead of wall-clocking
 *     `runSupervisionProbe`. Wrapping the fork would make the headline mostly a
 *     reading of `node --import tsx` booting and compiling the supervisor
 *     graph: measured on the machine this was written, PERF-261's supervisor
 *     work is single-digit milliseconds inside a ~150ms fork-to-result window.
 *     A fresh child per measured iteration stays (see the closing paragraph);
 *     what changed is that its startup is no longer inside the number.
 *   - `Math.random` is pinned for the driven window, because the product's
 *     backoff is full jitter. Pinning it to each extreme of its range recovers
 *     the exact [floor, ceiling) the product scheduled, without this fixture
 *     restating the product's formula.
 *   - The health-check intervals are configured far beyond any run's length, so
 *     the heartbeat watchdogs and their force-kills are out of frame.
 *   - `process.kill` is wrapped for the driven window so a stand-in pid can
 *     never reach a real process; stub pids are allocated above every platform's
 *     pid ceiling as a second guard.
 *
 * `electron/watchdog-host-core.ts` is the exception to all of it: it imports
 * nothing, takes its clock, its logger and its kill primitive as injected deps,
 * and is therefore measured directly in the harness process with no stub
 * anywhere in the path. PERF-263 is the only authoritative-everywhere scenario
 * in this family.
 *
 * Each probe runs in its own forked child, one per measured iteration. The
 * `electron` remap is a process-wide resolve hook and the timer/random/kill
 * wrappers are process-wide globals; installing either in the harness process
 * would leak into every other scenario, and reusing one child across iterations
 * would carry a drained timer table, a grown `forks` ledger and four
 * supervisors' module-level crash windows into the next reading. So the fork
 * stays per iteration and is kept out of the reported duration instead. This
 * module is its own child entry point, the same shape as `lib/ipcFixture.ts`.
 */

const PROBE_ENV = "DAINTREE_PERF_SUPERVISION_PROBE";

const SELF_PATH = fileURLToPath(import.meta.url);

/** Bounded stderr tail per child, so a failed probe is diagnosable. */
const STDERR_TAIL_LIMIT = 2000;

export type ProbeKind = "ladder" | "replay" | "classification" | "ptyReplay";

// --- Parent: child bookkeeping ---------------------------------------------

const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;
let sharedUserDataDir: string | null = null;

function userDataDir(): string {
  if (!sharedUserDataDir) {
    installExitHook();
    // Registered with the shared owner as a backstop; `installExitHook` ran
    // first, so on a signal the children die before the sweep reaches this.
    sharedUserDataDir = createPerfTempRoot("daintree-perf-supervision-");
  }
  return sharedUserDataDir;
}

/**
 * Last-resort reaper. Every probe kills its own child in a `finally`; this only
 * fires for one stranded by a throw between fork and try. A leaked probe child
 * holds a hydrated electron-store and a ping interval, and is invisible to every
 * in-process counter because it has its own runtime.
 */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;

  const killAll = (): void => {
    for (const child of liveChildren) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    liveChildren.clear();
    if (sharedUserDataDir) {
      releasePerfTempRoot(sharedUserDataDir);
      sharedUserDataDir = null;
    }
  };

  process.on("exit", killAll);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      killAll();
      process.exit(1);
    });
  }
}

/** Probe children still running. Read after teardown, never before. */
export function liveSupervisionChildCount(): number {
  return liveChildren.size;
}

// --- Result shapes ----------------------------------------------------------

export interface SupervisorLadder {
  /** Supervisor class under measurement. */
  name: string;
  /** Forks the supervisor asked for across the whole ladder. */
  forks: number;
  /** Respawns it performed after a crash, across both jitter passes. */
  restartsAttempted: number;
  /** Crashes it recovered from AND proved it could still serve after. */
  crashesSurvived: number;
  /** Crash ordinal at which it announced give-up (per pass). 0 = never did. */
  gaveUpAtCrash: number;
  /** Restart timers it armed. Zero means it respawns with no backoff at all. */
  backoffTimersArmed: number;
  /** Sum of the delays it scheduled with the jitter pinned to its low end. */
  backoffFloorMsSum: number;
  /** Sum of the delays it scheduled with the jitter pinned to its high end. */
  backoffCeilingMsSum: number;
  /** Crashes that produced neither a proven-live respawn nor an announced give-up. */
  recoveryMisses: number;
  /** The first crash after a healthy start was not survived. */
  firstCrashMisses: number;
  /** It kept respawning past the probe ceiling without ever announcing give-up. */
  giveUpMisses: number;
  /** After give-up, the operator-driven restart did not produce a serving host. */
  manualRecoveryMisses: number;
  /** Restart schedules that broke the policy in `BACKOFF_POLICY`. */
  backoffMisses: number;
}

export interface LadderResult {
  supervisors: SupervisorLadder[];
  /** Supervisor work inside the child: fork, tsx boot and imports excluded. */
  probeMs: number;
}

export interface ReplayResult {
  /** Replay messages the fresh stand-in host received before it was serving. */
  replayMessages: number;
  /** Structured-clone bytes of those messages. */
  replayBytes: number;
  /** Replay items whose payload did not match what was cached before the crash. */
  replayMisses: number;
  /** Supervisor-side work from the crash to a serving host, backoff excluded. */
  respawnToServingMs: number;
  /** Round trips the restarted workspace host answered through the broker. */
  servedRequests: number;
  /** Round trips the fresh host never received, or answered with a wrong nonce. */
  serveMisses: number;
  /**
   * The crash-to-graded-replay region inside the child. Fork, tsx boot, the
   * supervisor imports and the state seeding are all outside it.
   */
  probeMs: number;
}

export interface ClassificationResult {
  /** Crash verdicts the lifecycle produced. */
  classificationDecisions: number;
  /** Verdicts that disagreed with the expectation table. */
  classificationMisses: number;
  /** Times a sibling service's `child-process-gone` was wrongly consumed. */
  crossAttributionMisses: number;
  /** Decisions that resolved only because the deferred reason arrived in time. */
  goneReasonDecisions: number;
  /** The whole sweep inside the child: fork, tsx boot and imports excluded. */
  probeMs: number;
}

export interface PtyReplayResult {
  /** Terminals the client re-sent to the fresh shard. */
  replayedSpawns: number;
  /** Structured-clone bytes of the replayed spawn burst. */
  replaySpawnBytes: number;
  /** Terminals missing from the replay, or replayed with drifted options. */
  spawnReplayMisses: number;
  /** Terminals replayed without a fresh, strictly newer launch generation. */
  generationMisses: number;
  /** Config messages the shard replay re-sent alongside the spawns. */
  configReplayMessages: number;
  /** Cached global config the replay failed to re-send. */
  configReplayMisses: number;
  /** Time inside `respawnPendingForShard`, from `ready` to the last send. */
  replayMs: number;
  /** Supervisor work inside the child: fork, tsx boot and imports excluded. */
  probeMs: number;
}

export interface ProbeResultMap {
  ladder: LadderResult;
  replay: ReplayResult;
  classification: ClassificationResult;
  ptyReplay: PtyReplayResult;
}

// --- Parent: probe driver ---------------------------------------------------

interface ProbeEnvelope {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Run one probe in a fresh child and return its result.
 *
 * Rejects rather than returning a zeroed result: an apparatus failure must not
 * be indistinguishable from a supervisor that decided nothing. The scenario
 * turns the rejection into a fail-closed sample with its miss counts set.
 */
export function runSupervisionProbe<K extends ProbeKind>(
  kind: K,
  timeoutMs = 120_000
): Promise<ProbeResultMap[K]> {
  installExitHook();

  return new Promise((resolve, reject) => {
    const child = fork(SELF_PATH, [], {
      // Children do not inherit tsx's loader registration reliably, and the
      // supervisors are TypeScript source here, not built output. Mirrors
      // `lib/ipcFixture.ts`.
      execArgv: ["--import", "tsx"],
      serialization: "advanced",
      // Supervisor logging is verbose and goes to stdout; a perf run's report
      // must stay readable. stderr is kept so a failed boot can say why.
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {
        ...process.env,
        [PROBE_ENV]: kind,
        DAINTREE_USER_DATA: userDataDir(),
      },
    });

    liveChildren.add(child);
    child.unref();
    child.channel?.unref();

    let stderrTail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      liveChildren.delete(child);
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`supervision probe "${kind}" timed out\n${stderrTail}`)));
    }, timeoutMs);
    timer.unref?.();

    child.on("message", (raw: unknown) => {
      const envelope = raw as ProbeEnvelope;
      if (!envelope || typeof envelope !== "object") return;
      if (envelope.ok) {
        finish(() => resolve(envelope.result as ProbeResultMap[K]));
      } else {
        finish(() =>
          reject(new Error(`supervision probe "${kind}" failed: ${envelope.error}\n${stderrTail}`))
        );
      }
    });

    child.on("exit", () => {
      finish(() =>
        reject(new Error(`supervision probe "${kind}" exited without a result\n${stderrTail}`))
      );
    });
    child.on("error", (error) => {
      finish(() => reject(error));
    });
  });
}

// --- Watchdog core: measured with no stub in the path -----------------------

export interface WatchdogLadderResult {
  /** Ticks and messages the core processed across every round. */
  watchdogDecisions: number;
  /** Heartbeats a silent main survived before the kill fired. */
  beatsToKill: number;
  /** Injected-clock ms between the last ping and the kill. */
  detectionWindowMs: number;
  /** Wake-burst ticks the monotonic grace absorbed without a kill. */
  suppressedWakeTicks: number;
  /** Kills fired while main was answering, asleep, or already disarmed. */
  falseKills: number;
  /** A main that stopped answering was never killed inside the probe ceiling. */
  missedKills: number;
  /** Kill-attribution flag payloads that were absent or carried wrong facts. */
  flagMisses: number;
  /** `--main-pid=` parses that accepted a malformed pid or rejected a valid one. */
  pidParseMisses: number;
  /** Wall clock for the whole sweep. */
  ladderMs: number;
}

/** Argv forms `parseMainPid` is required to accept or reject. */
const PID_PARSE_CASES: ReadonlyArray<{ argv: readonly string[]; expected: number | null }> = [
  { argv: ["--main-pid=4242"], expected: 4242 },
  { argv: ["/path/to/host", "--main-pid=1"], expected: 1 },
  { argv: ["--main-pid=123abc"], expected: null },
  { argv: ["--main-pid="], expected: null },
  { argv: ["--main-pid=0"], expected: null },
  { argv: ["--main-pid=-9"], expected: null },
  { argv: ["--main-pid=1e3"], expected: null },
  { argv: ["--other=7"], expected: null },
];

/** Beats a silent main is driven for before the probe calls the kill missing. */
const KILL_PROBE_CEILING = 12;
/** Healthy ping/tick pairs driven per round; every one of them must not kill. */
const HEALTHY_BEATS = 25;
/** Ticks driven while suspended; every one of them must not kill. */
const SLEEP_BEATS = 30;
/** Ticks driven inside the post-wake grace; every one of them must not kill. */
const WAKE_BURST_TICKS = 6;

/**
 * Drive the real watchdog core through the four decisions it exists to make.
 *
 * Nothing is stubbed except the three seams the module already declares as
 * injected deps — `killMain`, `logError` and `now`. The clock is driven at the
 * module's own `HEARTBEAT_INTERVAL_MS` cadence, which is what the runtime entry
 * sets its interval to, so `detectionWindowMs` is measured off the core's own
 * behaviour rather than computed from its constants.
 *
 * Graded in BOTH directions on purpose. A watchdog that never fires and one
 * that fires on every tick are both cheap; only a pair of counters separates
 * either from one that works.
 */
export function runWatchdogLadder(rounds: number): WatchdogLadderResult {
  const started = performance.now();
  let decisions = 0;
  let falseKills = 0;
  let missedKills = 0;
  let beatsToKill = 0;
  let detectionWindowMs = 0;
  let suppressedWakeTicks = 0;
  let flagMisses = 0;

  for (let round = 0; round < rounds; round += 1) {
    let clock = 0;
    let kills = 0;
    let killedAtClock = -1;
    let missedBeatsAtKill = -1;
    const watchdog = createWatchdog({
      killMain: () => {
        kills += 1;
        killedAtClock = clock;
        missedBeatsAtKill = watchdog.state.missedBeats;
      },
      logError: () => {},
      now: () => clock,
    });

    // A healthy main pings before every beat. Any kill here is a false positive.
    for (let i = 0; i < HEALTHY_BEATS; i += 1) {
      watchdog.handleMessage({ type: "ping" });
      clock += HEARTBEAT_INTERVAL_MS;
      watchdog.tick();
      decisions += 2;
    }
    falseKills += kills;

    // Suspended: no pings arrive, and the core must not read that as a freeze.
    watchdog.handleMessage({ type: "sleep" });
    decisions += 1;
    const beforeSleep = kills;
    for (let i = 0; i < SLEEP_BEATS; i += 1) {
      clock += HEARTBEAT_INTERVAL_MS;
      watchdog.tick();
      decisions += 1;
    }
    falseKills += kills - beforeSleep;

    // Wake: the OS delivers the ticks queued during suspend as one burst, at
    // the same instant. Every one of them must be absorbed.
    watchdog.handleMessage({ type: "wake" });
    decisions += 1;
    const beforeWake = kills;
    for (let i = 0; i < WAKE_BURST_TICKS; i += 1) {
      watchdog.tick();
      decisions += 1;
    }
    const wakeKills = kills - beforeWake;
    falseKills += wakeKills;
    if (wakeKills === 0) suppressedWakeTicks += WAKE_BURST_TICKS;

    // A frozen main: armed, past the wake grace, answering nothing. This one
    // MUST be killed, and the probe measures how long that took.
    watchdog.handleMessage({ type: "ping" });
    decisions += 1;
    const pingClock = clock;
    let beats = 0;
    const beforeFreeze = kills;
    while (kills === beforeFreeze && beats < KILL_PROBE_CEILING) {
      clock += HEARTBEAT_INTERVAL_MS;
      watchdog.tick();
      decisions += 1;
      beats += 1;
    }
    if (kills === beforeFreeze) {
      missedKills += 1;
    } else {
      beatsToKill = beats;
      detectionWindowMs = killedAtClock - pingClock;

      // The kill-attribution sidecar is what turns "the app died" into "the
      // watchdog killed it" on the next launch, so a kill that writes nothing
      // has recovered the machine and lost the reason.
      let written: string | null = null;
      const wrote = writeWatchdogKillFlag("/perf-user-data", missedBeatsAtKill, 4242, {
        writeFileSync: (_path, data) => {
          written = data;
        },
        joinPath: (userData, name) => `${userData}/${name}`,
      });
      const payload = written === null ? null : (JSON.parse(written) as Record<string, unknown>);
      if (
        !wrote ||
        payload === null ||
        payload.mainPid !== 4242 ||
        payload.missedBeats !== missedBeatsAtKill ||
        typeof payload.killedAt !== "number" ||
        !WATCHDOG_KILL_FLAG_NAME.endsWith(".flag")
      ) {
        flagMisses += 1;
      }
    }

    // Disarmed by its own kill: nothing may fire again until main re-arms.
    const beforeDisarmed = kills;
    for (let i = 0; i < KILL_PROBE_CEILING; i += 1) {
      clock += HEARTBEAT_INTERVAL_MS;
      watchdog.tick();
      decisions += 1;
    }
    falseKills += kills - beforeDisarmed;
  }

  let pidParseMisses = 0;
  for (const probe of PID_PARSE_CASES) {
    if (parseMainPid(probe.argv) !== probe.expected) pidParseMisses += 1;
  }

  return {
    watchdogDecisions: decisions,
    beatsToKill,
    detectionWindowMs,
    suppressedWakeTicks,
    falseKills,
    missedKills,
    flagMisses,
    pidParseMisses,
    ladderMs: performance.now() - started,
  };
}

// --- Crash-classification expectation table ---------------------------------

/** serviceName a sibling PTY shard would carry. Never this lifecycle's own. */
export const FOREIGN_SERVICE_NAME = "daintree-pty-host:some-other-project";

export interface CrashCase {
  label: string;
  /** Exit code the `exit` event reports. */
  exitCode: number;
  /**
   * The `child-process-gone` detail, and when it lands relative to `exit`.
   * `after-exit` is the ordering the Electron race actually produces
   * (electron/electron#42283) and is the case an exit-code-only classifier
   * gets wrong.
   */
  gone: {
    reason: string;
    exitCode: number;
    when: "before-exit" | "after-exit";
    /** Absent means this lifecycle's own service. */
    foreign?: true;
  } | null;
  expectedCrashType: CrashType;
  expectedReportedCode: number;
  expectPayload: boolean;
  /** Graded into `crossAttributionMisses` rather than `classificationMisses`. */
  crossAttribution?: true;
}

/**
 * What each crash MUST be classified as.
 *
 * This is a specification written from Electron's reason vocabulary and the
 * POSIX exit-code convention, not a transcript of what the code does — which is
 * what makes it an oracle. Two families of case matter most:
 *
 *   - The ordering-race cases (`gone` arriving `after-exit` and disagreeing
 *     with the exit code). A supervisor that classifies on the exit code alone
 *     scores a miss on every one of them, and does so while looking fast: it
 *     answers on the `exit` event and never waits for the reason.
 *   - The cross-attribution case, where a SIBLING shard's crash reason is on
 *     the bus. Consuming it would rewrite this host's verdict with another
 *     host's facts, which no latency number would ever show.
 *
 * Exit code 143 is the one platform-branched expectation: `code > 128` is a
 * POSIX signal encoding, and on Windows the same range is uint32 NTSTATUS.
 */
export const CRASH_CASES: readonly CrashCase[] = [
  {
    label: "clean exit, no reason reported",
    exitCode: 0,
    gone: null,
    expectedCrashType: "CLEAN_EXIT",
    expectedReportedCode: 0,
    expectPayload: false,
  },
  {
    label: "generic failure, no reason reported",
    exitCode: 1,
    gone: null,
    expectedCrashType: "UNKNOWN_CRASH",
    expectedReportedCode: 1,
    expectPayload: true,
  },
  {
    label: "SIGKILL exit code, no reason reported",
    exitCode: 137,
    gone: null,
    expectedCrashType: "OUT_OF_MEMORY",
    expectedReportedCode: 137,
    expectPayload: true,
  },
  {
    label: "SIGABRT exit code, no reason reported",
    exitCode: 134,
    gone: null,
    expectedCrashType: "ASSERTION_FAILURE",
    expectedReportedCode: 134,
    expectPayload: true,
  },
  {
    label: "POSIX signal-encoded exit code, no reason reported",
    exitCode: 143,
    gone: null,
    expectedCrashType: process.platform === "win32" ? "UNKNOWN_CRASH" : "SIGNAL_TERMINATED",
    expectedReportedCode: 143,
    expectPayload: true,
  },
  {
    label: "oom reason lands after a zero exit code",
    exitCode: 0,
    gone: { reason: "oom", exitCode: 9, when: "after-exit" },
    expectedCrashType: "OUT_OF_MEMORY",
    expectedReportedCode: 9,
    expectPayload: true,
  },
  {
    label: "killed reason lands after a generic exit code",
    exitCode: 1,
    gone: { reason: "killed", exitCode: 137, when: "after-exit" },
    expectedCrashType: "SIGNAL_TERMINATED",
    expectedReportedCode: 137,
    expectPayload: true,
  },
  {
    label: "clean-exit reason overrides a non-zero exit code",
    exitCode: 1,
    gone: { reason: "clean-exit", exitCode: 0, when: "after-exit" },
    expectedCrashType: "CLEAN_EXIT",
    expectedReportedCode: 0,
    expectPayload: false,
  },
  {
    label: "memory-eviction reason lands after a zero exit code",
    exitCode: 0,
    gone: { reason: "memory-eviction", exitCode: 5, when: "after-exit" },
    expectedCrashType: "OUT_OF_MEMORY",
    expectedReportedCode: 5,
    expectPayload: true,
  },
  {
    label: "launch-failed reason",
    exitCode: 1,
    gone: { reason: "launch-failed", exitCode: 1, when: "after-exit" },
    expectedCrashType: "UNKNOWN_CRASH",
    expectedReportedCode: 1,
    expectPayload: true,
  },
  {
    label: "reason lands before exit",
    exitCode: 0,
    gone: { reason: "crashed", exitCode: 3, when: "before-exit" },
    expectedCrashType: "UNKNOWN_CRASH",
    expectedReportedCode: 3,
    expectPayload: true,
  },
  {
    label: "a sibling shard's reason must not be consumed",
    exitCode: 137,
    gone: { reason: "clean-exit", exitCode: 0, when: "after-exit", foreign: true },
    expectedCrashType: "OUT_OF_MEMORY",
    expectedReportedCode: 137,
    expectPayload: true,
    crossAttribution: true,
  },
];

// --- Child: the Electron stand-in -------------------------------------------

/**
 * A stand-in for one `utilityProcess.fork` result.
 *
 * The supervisors touch exactly this surface: `postMessage`, `on`/`once` for
 * `message`/`exit`, `kill`, `pid`, and an optional `stdout`/`stderr` pair they
 * reach for with `?.`. Nothing here crosses a process boundary — `inbox` is the
 * record of what the supervisor sent, and it is the only evidence any probe
 * uses that a restarted host was actually handed its state.
 */
class StubUtilityProcess extends EventEmitter {
  readonly pid: number;
  readonly inbox: unknown[] = [];
  exited = false;

  constructor(pid: number) {
    super();
    this.setMaxListeners(0);
    this.pid = pid;
  }

  postMessage(message: unknown, _transfer?: unknown[]): void {
    if (this.exited) return;
    this.inbox.push(message);
    // A real host exits on `dispose`; reproducing that is what lets the
    // cooperative teardown paths (reload, dispose) run to completion instead of
    // stalling on a force-kill backstop this fixture never fires.
    if ((message as { type?: string } | null)?.type === "dispose") {
      queueMicrotask(() => this.exit(0));
    }
  }

  kill(): boolean {
    this.exit(0);
    return true;
  }

  exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code);
  }

  /** Deliver an event as the host would post it back up the port. */
  post(event: unknown): void {
    this.emit("message", event);
  }
}

interface ForkRecord {
  child: StubUtilityProcess;
  serviceName: string;
  execArgv: readonly string[];
}

/**
 * Stub pids start above every supported platform's pid ceiling (macOS 99998,
 * Linux's 2^22 default) so a stray signal cannot land on a real process even if
 * the `process.kill` wrapper below were bypassed.
 */
let nextStubPid = 10_000_000;

const forks: ForkRecord[] = [];

const appEvents = new EventEmitter();
appEvents.setMaxListeners(0);

const electronBridge: Record<string, unknown> = {
  app: {
    getPath: () => process.env.DAINTREE_USER_DATA ?? tmpdir(),
    getAppPath: () => process.cwd(),
    getVersion: () => "99.0.0",
    isPackaged: false,
    on: (event: string, listener: (...args: unknown[]) => void) => appEvents.on(event, listener),
    off: (event: string, listener: (...args: unknown[]) => void) => appEvents.off(event, listener),
    once: (event: string, listener: (...args: unknown[]) => void) =>
      appEvents.once(event, listener),
    whenReady: () => Promise.resolve(),
    quit: () => {},
  },
  utilityProcess: {
    fork: (
      _modulePath: string,
      _args?: readonly string[],
      options?: { serviceName?: string; execArgv?: readonly string[] }
    ): StubUtilityProcess => {
      nextStubPid += 1;
      const child = new StubUtilityProcess(nextStubPid);
      forks.push({
        child,
        serviceName: options?.serviceName ?? "",
        execArgv: options?.execArgv ?? [],
      });
      return child;
    },
  },
};

const ELECTRON_STUB_SOURCE = `
const bridge = globalThis.__daintreePerfSupervisionElectron;
export const app = bridge.app;
export const utilityProcess = bridge.utilityProcess;
export const UtilityProcess = bridge.UtilityProcess;
export const MessagePortMain = bridge.MessagePortMain;
export const MessageChannelMain = bridge.MessageChannelMain;
export const WebContents = bridge.WebContents;
export const webContents = bridge.webContents;
export const BrowserWindow = bridge.BrowserWindow;
export const ipcMain = bridge.ipcMain;
export const shell = bridge.shell;
export const clipboard = bridge.clipboard;
export const dialog = bridge.dialog;
export const session = bridge.session;
export const net = bridge.net;
export const nativeTheme = bridge.nativeTheme;
export const nativeImage = bridge.nativeImage;
export const powerMonitor = bridge.powerMonitor;
export const safeStorage = bridge.safeStorage;
export const systemPreferences = bridge.systemPreferences;
export const screen = bridge.screen;
export const Menu = bridge.Menu;
export const MenuItem = bridge.MenuItem;
export const Notification = bridge.Notification;
export const protocol = bridge.protocol;
export const crashReporter = bridge.crashReporter;
export const globalShortcut = bridge.globalShortcut;
export default bridge;
`;

const ELECTRON_STUB_URL = `data:text/javascript,${encodeURIComponent(ELECTRON_STUB_SOURCE)}`;

/**
 * Remap the bare `electron` specifier, and only that specifier, so the
 * main-process supervisor graph loads under plain Node. The same seam
 * `lib/projectViewFixture.ts` and `lib/pluginHostFixture.ts` use; it runs only
 * inside the forked probe child, which is why it can be process-wide here.
 */
function installElectronStub(): void {
  const noop = (): void => {};
  const chain = (): unknown =>
    new Proxy(noop, { get: () => chain(), apply: () => chain(), construct: () => ({}) });

  (globalThis as Record<string, unknown>).__daintreePerfSupervisionElectron = new Proxy(
    electronBridge,
    { get: (target, prop) => (prop in target ? target[prop as string] : chain()) }
  );

  const registerHooks = (
    nodeModule as unknown as {
      registerHooks?: (hooks: {
        resolve: (
          specifier: string,
          context: unknown,
          next: (s: string, c: unknown) => unknown
        ) => unknown;
      }) => void;
    }
  ).registerHooks;

  if (typeof registerHooks === "function") {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "electron") return { url: ELECTRON_STUB_URL, shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
    return;
  }

  nodeModule.register(
    `data:text/javascript,${encodeURIComponent(
      `const U=${JSON.stringify(ELECTRON_STUB_URL)};` +
        `export async function resolve(s,c,n){if(s==="electron")return{url:U,shortCircuit:true};return n(s,c);}`
    )}`
  );
}

// --- Child: the timer recorder ----------------------------------------------

interface ArmedTimer {
  seq: number;
  delayMs: number;
  run: () => void;
  cleared: boolean;
  fired: boolean;
}

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

const armedTimers: ArmedTimer[] = [];
let nextTimerSeq = 0;

/**
 * Capture every `setTimeout` the supervisors arm instead of sleeping through it.
 *
 * The product's restart backoff is the interesting number in this whole family
 * and it is a SCHEDULE, not a latency: what matters is the delay the supervisor
 * chose, not how accurately Node slept for it. Recording the delay makes it a
 * deterministic reading, and firing on demand keeps a five-crash ladder inside a
 * few milliseconds instead of thirty seconds of real waiting.
 *
 * Nothing auto-fires. A timer this fixture never drains — a dispose backstop,
 * a reload debounce — simply never runs, which is the same outcome as the
 * unref'd timer it stands in for on a process that exits first.
 */
function installTimerRecorder(): void {
  const fake = (handler: unknown, delay?: number, ...args: unknown[]): unknown => {
    const seq = (nextTimerSeq += 1);
    const timer: ArmedTimer = {
      seq,
      delayMs: typeof delay === "number" ? delay : 0,
      cleared: false,
      fired: false,
      run: () => {
        if (typeof handler === "function") (handler as (...a: unknown[]) => void)(...args);
      },
    };
    armedTimers.push(timer);
    return { __perfTimerSeq: seq, unref: () => timer, ref: () => timer, hasRef: () => false };
  };
  (fake as unknown as { __promisify__?: unknown }).__promisify__ = (
    realSetTimeout as unknown as { __promisify__?: unknown }
  ).__promisify__;
  globalThis.setTimeout = fake as unknown as typeof globalThis.setTimeout;

  globalThis.clearTimeout = ((handle: unknown) => {
    const seq = (handle as { __perfTimerSeq?: number } | null)?.__perfTimerSeq;
    if (typeof seq === "number") {
      const timer = armedTimers.find((entry) => entry.seq === seq);
      if (timer) timer.cleared = true;
      return;
    }
    realClearTimeout(handle as Parameters<typeof realClearTimeout>[0]);
  }) as unknown as typeof globalThis.clearTimeout;
}

/** Timers armed since `from`, oldest first, excluding cleared and fired ones. */
function timersArmedSince(from: number): ArmedTimer[] {
  return armedTimers.slice(from).filter((timer) => !timer.cleared && !timer.fired);
}

function fireTimer(timer: ArmedTimer): void {
  if (timer.cleared || timer.fired) return;
  timer.fired = true;
  timer.run();
}

// --- Child: signal guard ----------------------------------------------------

/**
 * Never let a stand-in pid reach the OS.
 *
 * The supervisors force-kill by raw pid rather than `child.kill()` (see the
 * #11069 comment in `WorkspaceHostProcess.dispose`), and a fixture that hands
 * them a fabricated pid has handed them a signal target. Stub pids are routed
 * to the stand-in; every other pid passes through untouched, so the child's own
 * process management still works.
 */
function installKillGuard(): void {
  const realKill = process.kill.bind(process);
  process.kill = ((pid: number, signal?: string | number): true => {
    const record = forks.find((entry) => entry.child.pid === pid);
    if (record) {
      record.child.exit(137);
      return true;
    }
    return realKill(pid, signal as NodeJS.Signals) as unknown as true;
  }) as typeof process.kill;
}

/** Drain the microtask queue and one macrotask turn, repeatedly. */
function settle(rounds = 4): Promise<void> {
  return new Promise((resolve) => {
    let remaining = rounds;
    const step = (): void => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
        return;
      }
      setImmediate(step);
    };
    setImmediate(step);
  });
}

function latestFork(): ForkRecord | null {
  return forks.length > 0 ? forks[forks.length - 1] : null;
}

/**
 * A 48-character nonce, so an echo proves the payload survived the round trip.
 *
 * Deliberately not `Math.random`: the probes pin that global to recover the
 * backoff bounds, and a pinned generator yields the same token every time —
 * which would make a stale echo indistinguishable from a fresh one.
 */
function nonce(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Kill one stand-in host the way Electron reports a crash: the `exit` event
 * first, then `child-process-gone` on the next tick. That ordering is the
 * documented race (electron/electron#42283) and it is the one the supervisors
 * defer a whole event-loop turn to survive.
 */
async function crashFork(record: ForkRecord, exitCode: number, reason = "crashed"): Promise<void> {
  record.child.exit(exitCode);
  process.nextTick(() => {
    appEvents.emit(
      "child-process-gone",
      {},
      {
        type: "Utility",
        name: record.serviceName,
        serviceName: record.serviceName,
        reason,
        exitCode,
      }
    );
  });
  await settle(4);
}

// --- Child: the restart-ladder probe ----------------------------------------

interface LadderAdapter {
  name: string;
  /** Bring a freshly forked stand-in to the state the supervisor calls live. */
  bringUp(record: ForkRecord): Promise<void>;
  /** Prove the supervisor can still be USED through this child. */
  serving(record: ForkRecord): Promise<boolean>;
  /** Whether the supervisor has announced it is done retrying. */
  gaveUp(): boolean;
  /** The operator-driven restart this supervisor exposes after a give-up. */
  manualRecover(): void;
  dispose(): void;
}

/** Crashes fed to a supervisor before the probe calls its give-up missing. */
const MAX_CRASH_PROBES = 6;

interface LadderPass {
  forks: number;
  restartsAttempted: number;
  crashesSurvived: number;
  gaveUpAtCrash: number;
  backoffTimersArmed: number;
  recoveryMisses: number;
  firstCrashMisses: number;
  giveUpMisses: number;
  manualRecoveryMisses: number;
  /** Delays scheduled under whichever jitter extreme was pinned, in order. */
  scheduledDelays: number[];
}

/**
 * Whether a supervisor delays its restarts at all.
 *
 * One bit per supervisor, declared rather than read, because it is a POLICY and
 * the family's whole argument is that a supervisor's policy is invisible in its
 * latency. A `scheduled` supervisor waits before every respawn; an `immediate`
 * one respawns inside its own crash handler and is bounded by the give-up
 * budget alone. Both are defensible, and the two are indistinguishable in every
 * other number this scenario reports — recovery, serving and give-up all land
 * identically either way, which is exactly the hole this table closes. A
 * supervisor that quietly loses its timer scores a miss here instead of a
 * better duration.
 */
export type BackoffPolicy = "scheduled" | "immediate";

export const BACKOFF_POLICY: Readonly<Record<string, BackoffPolicy>> = {
  WorkspaceHostProcess: "scheduled",
  PtyHostLifecycle: "scheduled",
  // Respawns straight out of the deferred exit handler. Its bound is the
  // crash-loop cap, not a delay.
  PluginDevWorkerHost: "immediate",
  MainProcessWatchdogClient: "scheduled",
};

/** One jitter pass of a supervisor's restart schedule, as the ladder saw it. */
export interface BackoffPass {
  restartsAttempted: number;
  scheduledDelays: readonly number[];
}

/**
 * Below this a "backoff" is a spin. The floor exists so an instant-fail crash
 * loop cannot saturate a core between respawns; a delay of a millisecond or two
 * satisfies "nonzero" and none of the intent.
 */
const MIN_BACKOFF_FLOOR_MS = 50;

/**
 * Above this the supervisor has stopped supervising. A restart the user waits a
 * minute for is a hang with a timer attached, and no other counter here would
 * notice — the ladder fires every armed timer on demand.
 */
const MAX_BACKOFF_CEILING_MS = 60_000;

function total(values: readonly number[]): number {
  return values.reduce((carried, value) => carried + value, 0);
}

/**
 * Grade a supervisor's restart schedule against `BACKOFF_POLICY`.
 *
 * The reported floor/ceiling sums were the family's one ungraded reading: a
 * supervisor that respawns instantly with no timer at all recovers, serves and
 * gives up at exactly the same thresholds, so every other predicate stays zero
 * while the schedule metrics quietly read 0ms. Four properties separate a real
 * full-jitter backoff from that, and from the fixed-delay retry loop that also
 * passes a nonzero check:
 *
 *   1. Exactly one armed delay per restart — zero is the no-backoff supervisor,
 *      two is a double-arm that forks twice off one crash.
 *   2. Every delay inside a plausible band.
 *   3. Delays widen across successive crashes in the window, graded on the
 *      high-jitter pass only: pinned low, an exponential cap and a constant are
 *      the same sequence, and only the high end separates them.
 *   4. The two pinned passes disagree. `Math.random` was pinned to each end of
 *      its range, so equal totals mean the delay never consulted it — a
 *      constant wearing a jitter formula's name, which resynchronises every
 *      supervisor after a shared crash trigger.
 */
export function gradeBackoffSchedule(
  policy: BackoffPolicy,
  low: BackoffPass,
  high: BackoffPass
): number {
  let misses = 0;

  if (policy === "immediate") {
    for (const pass of [low, high]) {
      if (pass.scheduledDelays.length > 0) misses += 1;
    }
    return misses;
  }

  for (const pass of [low, high]) {
    if (pass.scheduledDelays.length !== pass.restartsAttempted) misses += 1;
    for (const delay of pass.scheduledDelays) {
      if (delay < MIN_BACKOFF_FLOOR_MS || delay > MAX_BACKOFF_CEILING_MS) misses += 1;
    }
  }

  for (let i = 1; i < high.scheduledDelays.length; i += 1) {
    if (high.scheduledDelays[i]! <= high.scheduledDelays[i - 1]!) misses += 1;
  }

  if (high.restartsAttempted > 0 && total(high.scheduledDelays) <= total(low.scheduledDelays)) {
    misses += 1;
  }

  return misses;
}

/**
 * Feed one supervisor a crash ladder and grade what it decided.
 *
 * The grading is deliberately asymmetric to the two ways a supervisor can post
 * a good number by doing nothing. A supervisor that never retries fails
 * `firstCrashMisses`: one crash after a healthy start must always be survived,
 * which is a policy floor this probe asserts rather than reads out of the
 * implementation. A supervisor that gives up immediately fails the same
 * counter. A supervisor that retries forever fails `giveUpMisses`. And a
 * supervisor that respawns a child it never hands anything to fails
 * `recoveryMisses`, because "survived" here means the fresh child was proven
 * usable, not merely constructed.
 */
async function runLadderPass(adapter: LadderAdapter, base: number): Promise<LadderPass> {
  let restartsAttempted = 0;
  let crashesSurvived = 0;
  let gaveUpAtCrash = 0;
  let backoffTimersArmed = 0;
  let recoveryMisses = 0;
  let firstCrashMisses = 0;
  let manualRecoveryMisses = 0;
  const scheduledDelays: number[] = [];

  for (let crashNo = 1; crashNo <= MAX_CRASH_PROBES; crashNo += 1) {
    const live = latestFork();
    if (!live || live.child.exited) {
      recoveryMisses += 1;
      break;
    }

    const forksBefore = forks.length;
    const timerMark = armedTimers.length;
    await crashFork(live, 137);

    for (const timer of timersArmedSince(timerMark)) {
      backoffTimersArmed += 1;
      scheduledDelays.push(timer.delayMs);
      fireTimer(timer);
    }
    await settle(3);

    let survived = false;
    if (forks.length > forksBefore) {
      restartsAttempted += 1;
      const fresh = latestFork();
      if (fresh) {
        await adapter.bringUp(fresh);
        survived = await adapter.serving(fresh);
      }
      if (survived) crashesSurvived += 1;
      else recoveryMisses += 1;
    } else if (adapter.gaveUp()) {
      gaveUpAtCrash = crashNo;
    } else {
      // Neither a respawn nor an announcement: the supervisor went quiet, which
      // is the failure mode no latency reading can see.
      recoveryMisses += 1;
    }

    if (crashNo === 1 && !survived) firstCrashMisses += 1;
    if (gaveUpAtCrash !== 0 || (!survived && forks.length === forksBefore)) break;
  }

  const giveUpMisses = gaveUpAtCrash === 0 ? 1 : 0;

  if (gaveUpAtCrash !== 0) {
    const beforeManual = forks.length;
    adapter.manualRecover();
    await settle(3);
    const fresh = latestFork();
    if (!fresh || forks.length === beforeManual) {
      manualRecoveryMisses += 1;
    } else {
      await adapter.bringUp(fresh);
      if (!(await adapter.serving(fresh))) manualRecoveryMisses += 1;
    }
  }

  return {
    forks: forks.length - base,
    restartsAttempted,
    crashesSurvived,
    gaveUpAtCrash,
    backoffTimersArmed,
    recoveryMisses,
    firstCrashMisses,
    giveUpMisses,
    manualRecoveryMisses,
    scheduledDelays,
  };
}

/** Far beyond any probe's length, so the heartbeat watchdogs stay out of frame. */
const HEALTH_CHECK_INTERVAL_MS = 3_600_000;

const PERF_PROJECT_PATH = "/perf/supervised-project";
const PERF_PLUGIN_ID = "perfco.supervised";
/** App-global, like every installed plugin — the probe never activates a project instance. */
const PERF_PLUGIN_IDENTITY = {
  instanceId: PERF_PLUGIN_ID,
  manifestId: PERF_PLUGIN_ID,
  origin: "global" as const,
  projectId: null,
  projectRoot: null,
};
const PERF_PLUGIN_DIR = "/perf/plugins/supervised";
const PERF_PLUGIN_BUNDLE = "/perf/plugins/supervised/dist/index.js";
const PTY_SERVICE_NAME = "daintree-pty-host:perf";
const PTY_MEMORY_LIMIT_MB = 512;

async function makeWorkspaceAdapter(): Promise<LadderAdapter> {
  const { WorkspaceHostProcess } = await import("../../../electron/services/WorkspaceHostProcess");
  let gaveUp = false;
  const host = new WorkspaceHostProcess(PERF_PROJECT_PATH, {
    maxRestartAttempts: 3,
    healthCheckIntervalMs: HEALTH_CHECK_INTERVAL_MS,
    showCrashDialog: false,
    maxWarmEntries: 1,
  });
  host.on("host-crash", () => {
    gaveUp = true;
  });
  host.waitForReady().catch(() => undefined);

  return {
    name: "WorkspaceHostProcess",
    async bringUp(record) {
      record.child.post({ type: "ready" });
      await settle(2);
    },
    async serving(record) {
      if (!host.isReady()) return false;
      const requestId = host.generateRequestId();
      const token = nonce();
      const pending = host
        .sendWithResponse<{ nonce?: string }>({ type: "refresh", requestId }, 5_000)
        .catch(() => null);
      const delivered = record.child.inbox.some(
        (message) => (message as { requestId?: string } | null)?.requestId === requestId
      );
      if (!delivered) return false;
      record.child.post({ type: "refresh-result", requestId, success: true, nonce: token });
      const answer = await pending;
      return answer?.nonce === token;
    },
    gaveUp: () => gaveUp,
    manualRecover: () => {
      gaveUp = false;
      host.manualRestart();
    },
    dispose: () => host.dispose(),
  };
}

async function makePtyAdapter(): Promise<LadderAdapter> {
  const { PtyHostLifecycle } = await import("../../../electron/services/pty/PtyHostLifecycle");
  let gaveUp = false;
  let lifecycle: InstanceType<typeof PtyHostLifecycle> | null = null;
  lifecycle = new PtyHostLifecycle(
    {
      memoryLimitMb: PTY_MEMORY_LIMIT_MB,
      electronDir: "/perf/electron",
      serviceName: PTY_SERVICE_NAME,
    },
    {
      onMessage: (event) => {
        if (event.type === "ready") lifecycle?.markReady();
      },
      onExitSync: () => {},
      onCrashClassified: () => {},
      onMaxRestartsReached: () => {
        gaveUp = true;
      },
      onForkFailed: () => {},
      onBeforeRestart: () => {},
      isDisposed: () => false,
      logInfo: () => {},
      logWarn: () => {},
    }
  );
  lifecycle.start();

  return {
    name: "PtyHostLifecycle",
    async bringUp(record) {
      record.child.post({ type: "ready" });
      await settle(2);
    },
    async serving(record) {
      if (!lifecycle?.isRunning()) return false;
      // A respawn that forgot the shard's heap budget has produced a host that
      // runs, and a fabric shard that will OOM under the load it was sized for.
      const configured = record.execArgv.some((arg) =>
        arg.includes(`--max-old-space-size=${PTY_MEMORY_LIMIT_MB}`)
      );
      const before = record.child.inbox.length;
      lifecycle.postMessage({ type: "health-check" });
      await settle(1);
      return configured && record.child.inbox.length > before;
    },
    gaveUp: () => gaveUp,
    manualRecover: () => {
      gaveUp = false;
      lifecycle?.manualRestart();
    },
    dispose: () => lifecycle?.dispose(),
  };
}

async function makePluginAdapter(): Promise<LadderAdapter> {
  const { PluginDevWorkerHost } =
    await import("../../../electron/services/plugin/PluginDevWorkerHost");
  let gaveUp = false;
  const makeHost = (): InstanceType<typeof PluginDevWorkerHost> => {
    const created = new PluginDevWorkerHost({
      pluginId: PERF_PLUGIN_ID,
      identity: PERF_PLUGIN_IDENTITY,
      pluginDir: PERF_PLUGIN_DIR,
      bundlePath: PERF_PLUGIN_BUNDLE,
      // Production mode: the prod worker kind, identical crash supervision.
      mode: "prod",
    });
    created.on("crash-loop", () => {
      gaveUp = true;
    });
    created.start().catch(() => undefined);
    return created;
  };
  let host = makeHost();

  return {
    name: "PluginDevWorkerHost",
    async bringUp(record) {
      record.child.post({ type: "ready" });
      await settle(2);
    },
    async serving(record) {
      // The worker re-imports its bundle on every (re)start; a respawn that
      // never sends `start` is a live process running no plugin.
      return record.child.inbox.some((message) => {
        const start = message as { type?: string; pluginId?: string; bundleUrl?: string } | null;
        return (
          start?.type === "start" &&
          start.pluginId === PERF_PLUGIN_ID &&
          typeof start.bundleUrl === "string" &&
          start.bundleUrl.endsWith("index.js")
        );
      });
    },
    gaveUp: () => gaveUp,
    manualRecover: () => {
      gaveUp = false;
      // Manual recovery for a plugin worker is a full replacement: a rebuild
      // reconciles the whole plugin, which disposes this host and forks a fresh
      // one with an empty crash window (#12277).
      host.dispose();
      host = makeHost();
    },
    dispose: () => host.dispose(),
  };
}

async function makeWatchdogClientAdapter(): Promise<LadderAdapter> {
  const { MainProcessWatchdogClient } =
    await import("../../../electron/services/MainProcessWatchdogClient");
  let gaveUp = false;
  const client = new MainProcessWatchdogClient({
    mainPid: 4242,
    hostPathOverride: "/perf/electron/watchdog-host-bootstrap.js",
    startImmediately: true,
  });
  client.onDisabled(() => {
    gaveUp = true;
  });

  return {
    name: "MainProcessWatchdogClient",
    async bringUp() {
      await settle(1);
    },
    async serving(record) {
      // The subprocess stays inert until it is armed, so a respawn without the
      // immediate ping leaves deadlock detection off while looking healthy.
      return (
        client.isRunning() &&
        record.child.inbox.some((message) => (message as { type?: string } | null)?.type === "ping")
      );
    },
    gaveUp: () => gaveUp,
    manualRecover: () => {
      gaveUp = false;
      client.restart();
    },
    dispose: () => client.dispose(),
  };
}

const LADDER_ADAPTERS: ReadonlyArray<() => Promise<LadderAdapter>> = [
  makeWorkspaceAdapter,
  makePtyAdapter,
  makePluginAdapter,
  makeWatchdogClientAdapter,
];

/**
 * Full-jitter extremes.
 *
 * The product's delay is `floor + random() * (cap - floor)`. Pinning
 * `Math.random` to each end of its range makes the two scheduled delays the
 * exact bounds the supervisor chose, so the ladder is recovered from the
 * product's own scheduling instead of being restated here.
 */
const JITTER_LOW = 0;
const JITTER_HIGH = 1 - Number.EPSILON;

/**
 * Resolve the supervisor graph before the measured region opens.
 *
 * The adapters import their supervisor lazily, so without this the first pass
 * would carry tsx compiling four main-process modules into the reading. The
 * second import of each is a module-cache hit.
 */
async function preloadLadderModules(): Promise<void> {
  await Promise.all([
    import("../../../electron/services/WorkspaceHostProcess"),
    import("../../../electron/services/pty/PtyHostLifecycle"),
    import("../../../electron/services/plugin/PluginDevWorkerHost"),
    import("../../../electron/services/MainProcessWatchdogClient"),
  ]);
}

async function probeLadder(): Promise<LadderResult> {
  const supervisors: SupervisorLadder[] = [];
  const realRandom = Math.random;

  await preloadLadderModules();
  const started = performance.now();

  for (const make of LADDER_ADAPTERS) {
    const passes: LadderPass[] = [];
    let name = "unknown";
    for (const pinned of [JITTER_LOW, JITTER_HIGH]) {
      Math.random = () => pinned;
      const base = forks.length;
      const adapter = await make();
      name = adapter.name;
      try {
        await adapter.bringUp(latestFork()!);
        passes.push(await runLadderPass(adapter, base));
      } finally {
        adapter.dispose();
        Math.random = realRandom;
        await settle(2);
      }
    }

    const low = passes[0]!;
    const high = passes[1]!;
    // An unlisted supervisor is a new one nobody wrote a policy for, and the
    // safe reading of "no declared policy" is a miss, not a free pass.
    const policy = BACKOFF_POLICY[name];
    supervisors.push({
      name,
      forks: low.forks + high.forks,
      restartsAttempted: low.restartsAttempted + high.restartsAttempted,
      crashesSurvived: low.crashesSurvived + high.crashesSurvived,
      gaveUpAtCrash: high.gaveUpAtCrash,
      backoffTimersArmed: low.backoffTimersArmed + high.backoffTimersArmed,
      backoffFloorMsSum: total(low.scheduledDelays),
      backoffCeilingMsSum: total(high.scheduledDelays),
      recoveryMisses: low.recoveryMisses + high.recoveryMisses,
      firstCrashMisses: low.firstCrashMisses + high.firstCrashMisses,
      giveUpMisses: low.giveUpMisses + high.giveUpMisses,
      manualRecoveryMisses: low.manualRecoveryMisses + high.manualRecoveryMisses,
      backoffMisses: policy === undefined ? 1 : gradeBackoffSchedule(policy, low, high),
    });
  }

  return { supervisors, probeMs: performance.now() - started };
}

// --- Child: the state-replay probe ------------------------------------------

/** Log-level overrides a long session accumulates. Sized to be worth measuring. */
function overridesCorpus(): Record<string, string> {
  const overrides: Record<string, string> = {};
  const levels = ["debug", "info", "warn", "error"];
  for (let i = 0; i < 24; i += 1) {
    overrides[`main:PerfScope${i}`] = levels[i % levels.length];
  }
  return overrides;
}

const MATCHER_CORPUS: ReadonlyArray<{ providerId: string; hostnames: string[] }> = Array.from(
  { length: 8 },
  (_unused, index) => ({
    providerId: `perfco.provider-${index}`,
    hostnames: [`forge-${index}.example.com`, `www.forge-${index}.example.com`],
  })
);

const FETCH_THROTTLE_MULTIPLIER = 2.5;

/** Two partial pushes, because the product merges monitor config per field. */
const MONITOR_CONFIG_A = { pollIntervalActive: 1500, pollIntervalBackground: 9000 };
const MONITOR_CONFIG_B = { fetchIntervalActiveMs: 45_000, backgroundGitWatcherCap: 6 };

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Grade what a restarted host was handed against what main had cached for it.
 *
 * "Recovered" and "recovered correctly" diverge here. A supervisor that
 * respawns a workspace host and replays nothing produces a host running the
 * in-host balanced defaults: unthrottled forge fetches, no provider matchers,
 * the wrong poll cadence — for hours, until the next unrelated state change
 * pushes them again. Nothing about that is visible in a respawn latency.
 */
async function probeReplay(): Promise<ReplayResult> {
  const { WorkspaceHostProcess } = await import("../../../electron/services/WorkspaceHostProcess");
  const { PluginDevWorkerHost } =
    await import("../../../electron/services/plugin/PluginDevWorkerHost");
  const { MainProcessWatchdogClient } =
    await import("../../../electron/services/MainProcessWatchdogClient");

  const overrides = overridesCorpus();
  const mergedMonitorConfig = { ...MONITOR_CONFIG_A, ...MONITOR_CONFIG_B };

  let replayMisses = 0;
  let replayMessages = 0;
  let replayBytes = 0;
  let servedRequests = 0;
  let serveMisses = 0;

  const realRandom = Math.random;
  Math.random = () => JITTER_LOW;

  const host = new WorkspaceHostProcess(PERF_PROJECT_PATH, {
    maxRestartAttempts: 3,
    healthCheckIntervalMs: HEALTH_CHECK_INTERVAL_MS,
    showCrashDialog: false,
    maxWarmEntries: 1,
  });
  host.waitForReady().catch(() => undefined);

  const plugin = new PluginDevWorkerHost({
    pluginId: PERF_PLUGIN_ID,
    identity: PERF_PLUGIN_IDENTITY,
    pluginDir: PERF_PLUGIN_DIR,
    bundlePath: PERF_PLUGIN_BUNDLE,
    mode: "prod",
  });
  plugin.start().catch(() => undefined);

  const watchdog = new MainProcessWatchdogClient({
    mainPid: 4242,
    hostPathOverride: "/perf/electron/watchdog-host-bootstrap.js",
    startImmediately: true,
  });

  let respawnToServingMs = 0;
  let probeMs = 0;

  try {
    const firstWorkspace = forks.find((entry) => entry.serviceName.includes("workspace-host"))!;
    const firstPlugin = forks.find((entry) => entry.serviceName.includes("plugin-prod"))!;
    const firstWatchdog = forks.find((entry) => entry.serviceName === "daintree-watchdog")!;

    firstWorkspace.child.post({ type: "ready" });
    firstPlugin.child.post({ type: "ready" });
    await settle(2);

    // Seed the state a live session accumulates and a fresh host has none of.
    host.setLogLevelOverrides(overrides);
    host.relayFetchThrottle(FETCH_THROTTLE_MULTIPLIER);
    host.relayForgeProviderMatchers([...MATCHER_CORPUS]);
    host.updateMonitorConfig(MONITOR_CONFIG_A);
    host.updateMonitorConfig(MONITOR_CONFIG_B);
    await settle(2);

    const started = performance.now();

    const workspaceTimerMark = armedTimers.length;
    await crashFork(firstWorkspace, 137, "crashed");
    for (const timer of timersArmedSince(workspaceTimerMark)) fireTimer(timer);
    await settle(3);
    await crashFork(firstPlugin, 1, "crashed");
    await settle(3);
    const watchdogTimerMark = armedTimers.length;
    await crashFork(firstWatchdog, 1, "crashed");
    for (const timer of timersArmedSince(watchdogTimerMark)) fireTimer(timer);
    await settle(3);

    const freshWorkspace = forks
      .filter((entry) => entry.serviceName.includes("workspace-host"))
      .at(-1);
    const freshPlugin = forks.filter((entry) => entry.serviceName.includes("plugin-prod")).at(-1);
    const freshWatchdog = forks.filter((entry) => entry.serviceName === "daintree-watchdog").at(-1);

    if (!freshWorkspace || freshWorkspace === firstWorkspace) {
      replayMisses += 4;
    } else {
      freshWorkspace.child.post({ type: "ready" });
      await settle(2);
      const inbox = freshWorkspace.child.inbox as Array<Record<string, unknown>>;
      const expectations: ReadonlyArray<{
        type: string;
        check: (m: Record<string, unknown>) => boolean;
      }> = [
        { type: "set-log-level-overrides", check: (m) => deepEqual(m.overrides, overrides) },
        { type: "apply-fetch-throttle", check: (m) => m.multiplier === FETCH_THROTTLE_MULTIPLIER },
        {
          type: "forge-provider-matchers",
          check: (m) => deepEqual(m.matchers, MATCHER_CORPUS),
        },
        {
          type: "update-monitor-config",
          check: (m) => deepEqual(m.config, mergedMonitorConfig),
        },
      ];
      for (const expectation of expectations) {
        const message = inbox.find(
          (entry) => entry.type === expectation.type && expectation.check(entry)
        );
        if (message) {
          replayMessages += 1;
          replayBytes += serializedBytes(message);
        } else {
          replayMisses += 1;
        }
      }

      // Serving again, through the supervisor's own broker.
      //
      // The reply is injected ONLY once the request is observed in the fresh
      // child's inbox. Injecting it unconditionally graded the harness's ability
      // to answer rather than the supervisor's ability to route: a broker still
      // holding the dead child's port, or one that dropped the send outright,
      // would have had its answer written for it and kept `serveMisses` at zero.
      const requestId = host.generateRequestId();
      const token = nonce();
      const pending = host
        .sendWithResponse<{ nonce?: string }>({ type: "refresh", requestId }, 5_000)
        .catch(() => null);
      const delivered = (freshWorkspace.child.inbox as Array<Record<string, unknown>>).some(
        (entry) => entry.requestId === requestId
      );
      if (!delivered) {
        serveMisses += 1;
      } else {
        freshWorkspace.child.post({
          type: "refresh-result",
          requestId,
          success: true,
          nonce: token,
        });
        const answer = await pending;
        if (answer?.nonce === token) servedRequests += 1;
        else serveMisses += 1;
      }
      respawnToServingMs = performance.now() - started;
    }

    if (!freshPlugin || freshPlugin === firstPlugin) {
      replayMisses += 1;
    } else {
      freshPlugin.child.post({ type: "ready" });
      await settle(2);
      const start = (freshPlugin.child.inbox as Array<Record<string, unknown>>).find(
        (entry) =>
          entry.type === "start" &&
          entry.pluginId === PERF_PLUGIN_ID &&
          typeof entry.bundleUrl === "string" &&
          (entry.bundleUrl as string).endsWith("index.js")
      );
      if (start) {
        replayMessages += 1;
        replayBytes += serializedBytes(start);
      } else {
        replayMisses += 1;
      }
    }

    if (!freshWatchdog || freshWatchdog === firstWatchdog) {
      replayMisses += 1;
    } else {
      const ping = (freshWatchdog.child.inbox as Array<Record<string, unknown>>).find(
        (entry) => entry.type === "ping"
      );
      if (ping) {
        replayMessages += 1;
        replayBytes += serializedBytes(ping);
      } else {
        replayMisses += 1;
      }
    }

    probeMs = performance.now() - started;
  } finally {
    host.dispose();
    plugin.dispose();
    watchdog.dispose();
    Math.random = realRandom;
  }

  return {
    replayMessages,
    replayBytes,
    replayMisses,
    respawnToServingMs,
    servedRequests,
    serveMisses,
    probeMs,
  };
}

// --- Child: the crash-classification probe ----------------------------------

/** Sweeps of the whole case table, so the decision cost is not one sample. */
const CLASSIFICATION_ROUNDS = 16;

async function probeClassification(): Promise<ClassificationResult> {
  const { PtyHostLifecycle } = await import("../../../electron/services/pty/PtyHostLifecycle");

  let decisions = 0;
  let classificationMisses = 0;
  let crossAttributionMisses = 0;
  let goneReasonDecisions = 0;

  let verdict: {
    reportedCode: number | null;
    crashType: CrashType;
    payload: unknown;
  } | null = null;

  let lifecycle: InstanceType<typeof PtyHostLifecycle> | null = null;
  lifecycle = new PtyHostLifecycle(
    {
      memoryLimitMb: PTY_MEMORY_LIMIT_MB,
      electronDir: "/perf/electron",
      serviceName: PTY_SERVICE_NAME,
    },
    {
      onMessage: (event) => {
        if (event.type === "ready") lifecycle?.markReady();
      },
      onExitSync: () => {},
      onCrashClassified: (info) => {
        verdict = {
          reportedCode: info.reportedCode,
          crashType: info.crashType,
          payload: info.payload,
        };
      },
      onMaxRestartsReached: () => {},
      onForkFailed: () => {},
      onBeforeRestart: () => {},
      isDisposed: () => false,
      logInfo: () => {},
      logWarn: () => {},
    }
  );

  const started = performance.now();
  try {
    for (let round = 0; round < CLASSIFICATION_ROUNDS; round += 1) {
      for (const probeCase of CRASH_CASES) {
        // A fresh host run per case, with the crash window emptied through the
        // lifecycle's own public field. The restart budget is a separate
        // question, measured by PERF-260; letting it trip here would stop the
        // sweep three cases in.
        lifecycle.crashTimestamps = [];
        lifecycle.start();
        const record = latestFork();
        if (!record) {
          classificationMisses += 1;
          continue;
        }
        record.child.post({ type: "ready" });
        await settle(1);

        verdict = null;
        const goneDetails =
          probeCase.gone === null
            ? null
            : {
                type: "Utility",
                name: probeCase.gone.foreign ? FOREIGN_SERVICE_NAME : record.serviceName,
                serviceName: probeCase.gone.foreign ? FOREIGN_SERVICE_NAME : record.serviceName,
                reason: probeCase.gone.reason,
                exitCode: probeCase.gone.exitCode,
              };

        if (goneDetails && probeCase.gone?.when === "before-exit") {
          appEvents.emit("child-process-gone", {}, goneDetails);
        }
        record.child.exit(probeCase.exitCode);
        if (goneDetails && probeCase.gone?.when === "after-exit") {
          process.nextTick(() => appEvents.emit("child-process-gone", {}, goneDetails));
        }
        await settle(3);

        // Clear the restart timer the crash armed; the next case starts its own
        // host explicitly, and a fired timer would fork a second one.
        for (const timer of armedTimers) timer.cleared = true;

        decisions += 1;
        const answer = verdict as {
          reportedCode: number | null;
          crashType: CrashType;
          payload: unknown;
        } | null;
        const correct =
          answer !== null &&
          answer.crashType === probeCase.expectedCrashType &&
          answer.reportedCode === probeCase.expectedReportedCode &&
          (answer.payload !== null) === probeCase.expectPayload;

        if (probeCase.crossAttribution) {
          if (!correct) crossAttributionMisses += 1;
        } else {
          if (!correct) classificationMisses += 1;
          if (probeCase.gone !== null) goneReasonDecisions += 1;
        }
      }
    }
  } finally {
    lifecycle.dispose();
  }

  return {
    classificationDecisions: decisions,
    classificationMisses,
    crossAttributionMisses,
    goneReasonDecisions,
    probeMs: performance.now() - started,
  };
}

// --- Child: the terminal-fleet replay probe ---------------------------------

/** A fleet size a fleet-broadcasting IDE actually reaches. */
const REPLAY_TERMINAL_COUNT = 24;

/**
 * Identity-bearing fields the replayed spawn must carry through verbatim.
 *
 * `env` is deliberately not compared: on Windows the client re-stamps PATH from
 * the registry at send time, so the replayed env legitimately differs from the
 * captured one. Comparing it would report a platform behaviour as a replay
 * defect. `launchGeneration` is excluded here and graded separately, because it
 * MUST be freshly minted — a replay carrying the pre-crash generation would let
 * the journal's exactly-once gate drop the new incarnation's records.
 */
const SPAWN_IDENTITY_FIELDS = [
  "cwd",
  "shell",
  "args",
  "cols",
  "rows",
  "title",
  "projectId",
  "worktreeId",
  "launchAgentId",
  "postSpawnInput",
] as const;

function spawnIdentity(options: Record<string, unknown>): string {
  const projected: Record<string, unknown> = {};
  for (const field of SPAWN_IDENTITY_FIELDS) projected[field] = options[field];
  return JSON.stringify(projected);
}

/** The seeded process-tree cadence, which the shard replay must re-send. */
const REPLAY_PROCESS_TREE_POLL_MS = 1500;

/**
 * Host-wide config a respawned shard must be handed back.
 *
 * The explicit poll interval is here because the oracle used to stop at the
 * resource profile, and the two are not the same setting: the profile carries a
 * default cadence, the focus throttle overrides it, and `PtyClient` replays the
 * override AFTER the profile precisely because it was the later writer. A
 * replay that re-sent the profile and dropped the override would leave every
 * terminal in the fleet sampling its process tree at the profile's rate — the
 * cadence bug that is invisible in a respawn latency and was invisible here too.
 *
 * Values, not just types: a replay that re-sends the message with the boot
 * default is a replay that lost the state.
 */
const CONFIG_REPLAY_EXPECTATIONS: ReadonlyArray<(m: Record<string, unknown>) => boolean> = [
  (m) => m.type === "set-resource-monitoring" && m.enabled === true,
  (m) => m.type === "set-resource-profile" && m.profile === "performance",
  (m) => m.type === "set-process-tree-poll-interval" && m.ms === REPLAY_PROCESS_TREE_POLL_MS,
  (m) => m.type === "set-log-level-overrides",
];

const CONFIG_REPLAY_EXPECTATION_COUNT = CONFIG_REPLAY_EXPECTATIONS.length;

/**
 * Whether the replayed spawn carries a NEW incarnation stamp.
 *
 * `replayed !== previous` was the whole check, and `undefined !== 4` is true —
 * so a replay that dropped `launchGeneration` altogether passed a predicate
 * written to prove one had been minted. The ledger mints positive integers and
 * increments on every relaunch, so the stamp is required to be present,
 * well-formed and strictly newer than the one the terminal carried into the
 * crash. `previous` must itself be a number: if the pre-crash spawn never
 * stamped a generation there is nothing for the journal to supersede, and
 * "newer than nothing" is not a pass.
 */
export function isFreshGeneration(replayed: unknown, previous: unknown): boolean {
  if (typeof previous !== "number" || !Number.isInteger(previous)) return false;
  if (typeof replayed !== "number" || !Number.isInteger(replayed)) return false;
  return replayed > previous && replayed > 0;
}

async function probePtyReplay(): Promise<PtyReplayResult> {
  const { PtyClient } = await import("../../../electron/services/PtyClient");

  const realRandom = Math.random;
  Math.random = () => JITTER_LOW;

  const client = new PtyClient({
    deferStart: true,
    healthCheckIntervalMs: HEALTH_CHECK_INTERVAL_MS,
    showCrashDialog: false,
    // The legacy single-host path: one shard owns the whole fleet, which is the
    // configuration where a host crash takes every terminal with it.
    fabric: false,
  });

  let replayedSpawns = 0;
  let replaySpawnBytes = 0;
  let spawnReplayMisses = 0;
  let generationMisses = 0;
  let configReplayMessages = 0;
  let configReplayMisses = 0;
  let replayMs = 0;
  let probeMs = 0;

  try {
    const started = performance.now();
    client.start();
    const first = latestFork();
    if (!first) throw new Error("pty shard never forked");
    first.child.post({ type: "ready" });
    await settle(2);

    client.setResourceMonitoring(true);
    client.setResourceProfile("performance");
    client.setProcessTreePollInterval(REPLAY_PROCESS_TREE_POLL_MS);

    for (let i = 0; i < REPLAY_TERMINAL_COUNT; i += 1) {
      client.spawn(`perf-terminal-${i}`, {
        cwd: `/perf/worktrees/wt-${i % 4}`,
        shell: "/bin/zsh",
        args: ["-l"],
        cols: 120,
        rows: 40,
        title: `Terminal ${i}`,
        projectId: "perf-project",
        worktreeId: `wt-${i % 4}`,
        // Every fourth terminal is a command launch on a shell that cannot host
        // a startup wrapper, so its command rides `pendingSpawns` and must be
        // re-injected on replay (#11339).
        ...(i % 4 === 0 ? { postSpawnInput: `claude --resume session-${i}\r` } : {}),
      });
    }
    await settle(2);

    const before = new Map<string, { identity: string; generation: unknown }>();
    for (const message of first.child.inbox as Array<Record<string, unknown>>) {
      if (message.type !== "spawn") continue;
      const options = message.options as Record<string, unknown>;
      before.set(String(message.id), {
        identity: spawnIdentity(options),
        generation: options.launchGeneration,
      });
    }
    if (before.size !== REPLAY_TERMINAL_COUNT) {
      spawnReplayMisses += REPLAY_TERMINAL_COUNT - before.size;
    }

    const timerMark = armedTimers.length;
    await crashFork(first, 137, "crashed");
    for (const timer of timersArmedSince(timerMark)) fireTimer(timer);
    await settle(3);

    const fresh = latestFork();
    if (!fresh || fresh === first) {
      spawnReplayMisses += REPLAY_TERMINAL_COUNT;
      generationMisses += REPLAY_TERMINAL_COUNT;
      configReplayMisses += CONFIG_REPLAY_EXPECTATION_COUNT;
    } else {
      // `handleShardReady` runs the whole replay burst synchronously inside this
      // message delivery, so the bracket is the supervisor's real replay cost.
      const replayStarted = performance.now();
      fresh.child.post({ type: "ready" });
      replayMs = performance.now() - replayStarted;
      await settle(2);

      const replayed = new Map<string, Record<string, unknown>>();
      for (const message of fresh.child.inbox as Array<Record<string, unknown>>) {
        if (message.type !== "spawn") continue;
        replayed.set(String(message.id), message);
      }

      for (const [id, expected] of before) {
        const message = replayed.get(id);
        if (!message) {
          spawnReplayMisses += 1;
          generationMisses += 1;
          continue;
        }
        const options = message.options as Record<string, unknown>;
        if (spawnIdentity(options) !== expected.identity) spawnReplayMisses += 1;
        else {
          replayedSpawns += 1;
          replaySpawnBytes += serializedBytes(message);
        }
        if (!isFreshGeneration(options.launchGeneration, expected.generation)) {
          generationMisses += 1;
        }
      }

      for (const matches of CONFIG_REPLAY_EXPECTATIONS) {
        if ((fresh.child.inbox as Array<Record<string, unknown>>).some(matches)) {
          configReplayMessages += 1;
        } else {
          configReplayMisses += 1;
        }
      }
    }

    probeMs = performance.now() - started;
  } finally {
    client.dispose();
    Math.random = realRandom;
  }

  return {
    replayedSpawns,
    replaySpawnBytes,
    spawnReplayMisses,
    generationMisses,
    configReplayMessages,
    configReplayMisses,
    replayMs,
    probeMs,
  };
}

// --- Child entry ------------------------------------------------------------

const probeKind = process.env[PROBE_ENV] as ProbeKind | undefined;

if (probeKind) {
  installElectronStub();
  installTimerRecorder();
  installKillGuard();

  const run = async (): Promise<unknown> => {
    switch (probeKind) {
      case "ladder":
        return probeLadder();
      case "replay":
        return probeReplay();
      case "classification":
        return probeClassification();
      case "ptyReplay":
        return probePtyReplay();
      default:
        throw new Error(`unknown supervision probe: ${String(probeKind)}`);
    }
  };

  void run().then(
    (result) => {
      process.send?.({ ok: true, result });
      // The recorder swallowed every dispose backstop, and a supervisor's ping
      // interval is a real timer, so nothing here unwinds on its own.
      realSetTimeout(() => process.exit(0), 10);
    },
    (error: unknown) => {
      process.send?.({ ok: false, error: error instanceof Error ? error.stack : String(error) });
      realSetTimeout(() => process.exit(1), 10);
    }
  );
}
