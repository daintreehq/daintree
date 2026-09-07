import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { PerfScenario, ScenarioSample } from "../types";
import { spinEventLoop } from "../lib/workloads";
import {
  countDeliveredLines,
  liveUtilityHostCount,
  nonceRequestId,
  ptyPayloadScript,
  serializedBytes,
  spawnUtilityHost,
  type HostMessage,
  type UtilityHost,
} from "../lib/ipcFixture";

/**
 * Cross-process IPC.
 *
 * PERF-043..046 drive the REAL `electron/workspace-host.ts` and
 * `electron/pty-host.ts` in their own OS processes and account for what
 * crosses the channel. See `lib/ipcFixture.ts` for what that boundary is and,
 * just as importantly, what it is not.
 *
 * The headline numbers here are message counts and structured-clone byte
 * counts, not latencies. For the request/response channel both are functions of
 * the protocol and the payload, so they survive a hardware change — which the
 * transit times deliberately do not claim to.
 *
 * One honest caveat on PERF-045: the PTY chunk counts (`ptyDataMessages`,
 * `ptyDataBytes` and the two ratios derived from them) are shaped by node-pty,
 * libuv and OS read scheduling, so they carry a real few-percent spread and are
 * only loosely machine-independent despite classifying as count/ratio. The
 * deterministic companion in that scenario is `payloadBytes`: 2000 fixed-width
 * lines is an exact byte total, and it reproduces to the byte.
 *
 * PERF-040 and PERF-041 used to live here. They drove a `RequestResponseBroker`
 * inside this same process: a correlation Map with no boundary, no serializer
 * and no second process, reported as "IPC Round Trip" and "IPC Throughput".
 * PERF-044 measures what they claimed to, so they are gone rather than kept as
 * a second, misleading answer to the same question.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// Generous: the child transpiles the host's whole import graph through tsx and
// dlopens better-sqlite3, @parcel/watcher or node-pty. A boot that misses this
// is not slow, it is broken, and the scenario says so with a `*Misses`.
const HOST_BOOT_TIMEOUT_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const DISPOSE_TIMEOUT_MS = 5_000;
const ROUND_TRIP_TIMEOUT_MS = 20_000;
const PTY_RUN_TIMEOUT_MS = 60_000;

/**
 * Chunks can still be in flight when `exit` lands — the PTY's read side and the
 * process's exit are different events. Draining before reading the counters
 * keeps a trailing chunk from being reported as a dropped line.
 *
 * It is NOT what makes the line count complete: the payload does not exit until
 * the reader has released it (see `ptyPayloadScript`), because no drain on this
 * side can recover output node-pty destroyed with the socket.
 */
const PTY_DRAIN_MS = 400;

/**
 * How long PERF-045 waits for all 2000 lines before releasing the payload
 * anyway. Reaching it means output really is missing, which is what
 * `lineMisses` then reports — the wait is bounded so a genuine loss stays a
 * measurement rather than becoming a hang.
 */
const PTY_STREAM_TIMEOUT_MS = 8_000;

/** Poll interval for that wait. Short enough not to pad the reading. */
const PTY_STREAM_POLL_MS = 20;

/** Batches of the five-request cycle below. 20 x 5 = 100 round trips. */
const ROUND_TRIP_BATCHES = 20;

const PTY_LINES = 2_000;

/** Lag samples PERF-042 takes; its predicate holds the sampler to all of them. */
const LAG_SAMPLE_COUNT = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A measurement that did not happen. Reported as a sample with the misses set
 * rather than thrown, so one bad boot annotates the run instead of aborting it
 * — and so the number never silently reads as a good one.
 */
function failClosed(notes: string, metrics: Record<string, number>): ScenarioSample {
  return { durationMs: 0, metrics, notes };
}

/**
 * Real, repo-independent request/response pairs on the main<->workspace-host
 * channel, each correlated by `requestId`. Chosen because none of them needs a
 * loaded project or a git repository: this scenario measures the channel, and
 * the git pipeline is already measured by PERF-100..106.
 */
const ROUND_TRIP_CYCLE: ReadonlyArray<{
  readonly responseType: string;
  build(requestId: string): Record<string, unknown>;
}> = [
  {
    responseType: "all-states",
    build: (requestId) => ({ type: "get-all-states", requestId }),
  },
  {
    responseType: "project-switch-result",
    build: (requestId) => ({ type: "project-switch", requestId }),
  },
  {
    responseType: "get-pr-status-result",
    build: (requestId) => ({ type: "get-pr-status", requestId }),
  },
  {
    responseType: "monitor",
    build: (requestId) => ({ type: "get-monitor", requestId, worktreeId: "perf-absent-worktree" }),
  },
  {
    responseType: "governance:snapshot-result",
    build: (requestId) => ({ type: "governance:snapshot", requestId }),
  },
];

/**
 * Tear a host down, then count the host processes still running.
 *
 * The count is taken AFTER teardown on purpose. Read while the host is still
 * up it is a tautology, and `residualHostCount` is the one reading that says
 * whether a scenario left a process behind — a leaked pty-host holds PTYs open
 * and a leaked workspace-host keeps polling, and both would land in the
 * subprocess counters of whatever scenario ran next.
 */
async function teardown(host: UtilityHost): Promise<number> {
  host.kill();
  if (!(await host.waitForExit(DISPOSE_TIMEOUT_MS))) {
    // SIGKILL did not land within the window. Signalling again is the only
    // lever left from here; the count returned below is what reports it, and
    // the process-exit reaper is the final backstop.
    host.kill();
    await host.waitForExit(DISPOSE_TIMEOUT_MS);
  }
  return liveUtilityHostCount();
}

/**
 * The correctness pairing for a boot number: `ready` is a message the host
 * sends, not proof that it is serving. A host that printed `ready` and then
 * wedged answers no health check. Returns the answer latency, or `null` if
 * nothing came back.
 */
async function healthCheck(host: UtilityHost): Promise<number | null> {
  const started = performance.now();
  host.send({ type: "health-check" });
  const pong = await host.waitFor(
    (message: HostMessage) => message.type === "pong",
    HEALTH_CHECK_TIMEOUT_MS
  );
  return pong === null ? null : performance.now() - started;
}

export const ipcScenarios: PerfScenario[] = [
  {
    id: "PERF-042",
    name: "Main Loop Lag Under Orchestration",
    description: "Estimate event-loop lag while orchestration-like async load is active.",
    tier: "heavy",
    modes: ["ci", "nightly", "soak"],
    iterations: { ci: 5, nightly: 8, soak: 12 },
    warmups: 1,
    // Kept deliberately, and knowingly misfiled: this measures in-process
    // event-loop lag under synthetic load, which is not IPC, and the loop it
    // measures is this harness's Node loop rather than Electron's main loop.
    // It is still a real reading of the class §3.5 of the benchmarking taxonomy
    // asks for, and the id carries a live baseline, so it keeps its id and its
    // number. Read it as "Node event-loop lag under orchestration-like load",
    // never as evidence about the real main process.
    correctness: ["lagSampleMisses"],
    async run() {
      const lag = await measureEventLoopLag(LAG_SAMPLE_COUNT, () => spinEventLoop(0.6));

      return {
        durationMs: 0,
        metrics: {
          eventLoopLagMs: lag.maxLagMs,
          lagSampleMisses: Math.abs(LAG_SAMPLE_COUNT - lag.samples) + (lag.loadTurns > 0 ? 0 : 1),
        },
      };
    },
  },
  {
    id: "PERF-043",
    name: "Workspace Host Boot and Clean Dispose",
    description:
      "Fork the real workspace-host into its own process, time the ready handshake, prove it is serving with a health check, then ask it to shut itself down and confirm the process actually exits.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 8 },
    warmups: 1,
    correctness: ["bootReadyMisses", "healthCheckMisses", "disposeExitMisses"],
    async run() {
      const host = spawnUtilityHost({ kind: "workspace" });
      try {
        const bootMs = await host.waitForReady(HOST_BOOT_TIMEOUT_MS);
        if (bootMs === null) {
          return failClosed(`workspace-host never became ready: ${host.stderr.slice(-400)}`, {
            bootReadyMisses: 1,
            healthCheckMisses: 1,
            healthCheckMs: HEALTH_CHECK_TIMEOUT_MS,
            disposeExitMisses: 1,
            bootMessages: host.responseMessages,
            bootBytes: host.responseBytes,
            residualHostCount: await teardown(host),
          });
        }

        const bootMessages = host.responseMessages;
        const bootBytes = host.responseBytes;
        const healthCheckMs = await healthCheck(host);
        const disposeMs = await host.disposeGracefully(DISPOSE_TIMEOUT_MS);
        const residualHostCount = await teardown(host);

        return {
          durationMs: bootMs,
          metrics: {
            bootReadyMisses: 0,
            healthCheckMisses: healthCheckMs === null ? 1 : 0,
            // Reported alongside the miss: a `ready` followed by a pong that
            // took four seconds is a pass on the miss and still a bad boot,
            // and the headline durationMs (boot only) cannot show it.
            healthCheckMs: healthCheckMs ?? HEALTH_CHECK_TIMEOUT_MS,
            // Everything the host volunteers before it is usable. A boot that
            // gets faster by deferring work shows up here rather than nowhere.
            bootMessages,
            bootBytes,
            disposeMs: disposeMs ?? DISPOSE_TIMEOUT_MS,
            // Zero only when the host exited on its own AND exited zero. A
            // force-killed host shuts down instantly and a host that crashes
            // out of dispose exits promptly; the duration cannot tell either
            // apart from a clean teardown on its own.
            disposeExitMisses: disposeMs === null ? 1 : 0,
            residualHostCount,
          },
          notes:
            healthCheckMs === null ? "host reported ready but answered no health check" : undefined,
        };
      } finally {
        host.kill();
      }
    },
  },
  {
    id: "PERF-044",
    name: "Workspace Host Request Round Trip (messages and bytes)",
    description:
      "100 real correlated requests across the main<->workspace-host process boundary. Reports messages and serialized bytes each way, and whether every 64-character request nonce came back intact.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 8 },
    warmups: 1,
    correctness: ["responseMisses", "responseTypeMisses"],
    async run() {
      const host = spawnUtilityHost({ kind: "workspace" });
      try {
        const bootMs = await host.waitForReady(HOST_BOOT_TIMEOUT_MS);
        if (bootMs === null) {
          return failClosed(`workspace-host never became ready: ${host.stderr.slice(-400)}`, {
            responseMisses: ROUND_TRIP_BATCHES * ROUND_TRIP_CYCLE.length,
            responseTypeMisses: 0,
            unexpectedResponseMessages: 0,
            duplicateResponseMessages: 0,
            requestMessages: 0,
            responseMessages: 0,
            requestBytes: 0,
            responseBytes: 0,
            residualHostCount: await teardown(host),
          });
        }

        // Boot traffic is excluded: this measures the cost of asking, not the
        // cost of starting. PERF-043 owns the boot number.
        const mark = host.mark();
        const expected = new Map<string, string>();
        const answered = new Set<string>();
        let responseTypeMisses = 0;
        let unexpectedResponseMessages = 0;
        let duplicateResponseMessages = 0;
        let settle: (() => void) | null = null;

        const stop = host.onMessage((message) => {
          const requestId = message.requestId;
          if (typeof requestId !== "string") return;
          const wanted = expected.get(requestId);
          if (wanted === undefined) {
            // The nonce we sent did not come back byte-identical, or the host
            // volunteered a correlated event of its own. Either way it is not
            // one of our answers.
            unexpectedResponseMessages += 1;
            return;
          }
          if (message.type !== wanted) responseTypeMisses += 1;
          // `answered` is a Set, so a double-delivered response would otherwise
          // be invisible — and double delivery is a real IPC defect, not a
          // rounding error.
          if (answered.has(requestId)) duplicateResponseMessages += 1;
          answered.add(requestId);
          if (answered.size === expected.size) settle?.();
        });

        const started = performance.now();
        let timeoutHandle: NodeJS.Timeout | undefined;
        const complete = new Promise<void>((resolve) => {
          settle = resolve;
          // Held in a ref and cleared below: a 20s timer left armed per
          // iteration keeps the harness's event loop busy long after the
          // scenario that created it has finished reporting.
          timeoutHandle = setTimeout(resolve, ROUND_TRIP_TIMEOUT_MS);
        });

        for (let batch = 0; batch < ROUND_TRIP_BATCHES; batch += 1) {
          for (const spec of ROUND_TRIP_CYCLE) {
            const requestId = nonceRequestId(`perf-044-${batch}`);
            expected.set(requestId, spec.responseType);
            host.send(spec.build(requestId));
          }
        }

        await complete;
        const durationMs = performance.now() - started;
        clearTimeout(timeoutHandle);
        stop();

        const channel = host.since(mark);
        const responseMisses = expected.size - answered.size;
        const residualHostCount = await teardown(host);

        return {
          durationMs,
          metrics: {
            requestMessages: channel.requestMessages,
            responseMessages: channel.responseMessages,
            requestBytes: channel.requestBytes,
            responseBytes: channel.responseBytes,
            // The pairing. A channel that answers nothing is arbitrarily fast,
            // and a channel that answers the wrong thing is faster still.
            responseMisses,
            responseTypeMisses,
            unexpectedResponseMessages,
            duplicateResponseMessages,
            residualHostCount,
          },
          notes:
            responseMisses > 0
              ? `${responseMisses} of ${expected.size} requests were never answered`
              : undefined,
        };
      } finally {
        host.kill();
      }
    },
  },
  {
    id: "PERF-045",
    name: "PTY Host Output Volume (messages and bytes per terminal)",
    description:
      "One real PTY in the real pty-host, emitting 2000 indexed lines, then holding the terminal open until the reader has them all. Reports how many messages and structured-clone bytes that output costs on the main<->pty-host channel, and proves every line arrived. This is the parent-IPC fallback path: with no renderer MessagePort transferred, the host has nowhere else to send a chunk. Production's visual path is the direct renderer port, which a forked child's channel cannot carry.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 3, ci: 5, nightly: 8 },
    warmups: 1,
    correctness: ["lineMisses", "spawnMisses", "exitMisses", "exitCodeMisses"],
    async run() {
      const host = spawnUtilityHost({
        kind: "pty",
        // The analysis pool resolves its worker as a BUILT `analysisWorker.js`
        // next to the host. Running the host from TypeScript source, that path
        // does not exist and the pool respawn-loops, which would land in these
        // counters as noise. This is the product's own switch, and the
        // in-thread analysis backend it falls back to is a supported mode.
        extraEnv: {
          DAINTREE_DISABLE_ANALYSIS_WORKERS: "1",
          // Without this the host warms a two-shell PTY pool right after
          // `ready`. Those shells are grandchildren this fixture cannot track,
          // and SIGKILL skips the host's own cleanup — so they would be a leak
          // `residualHostCount` is structurally unable to see.
          DAINTREE_PTY_DEFER_POOL_WARM: "1",
        },
      });
      const terminalId = `perf-045-${Date.now().toString(36)}`;
      try {
        const bootMs = await host.waitForReady(HOST_BOOT_TIMEOUT_MS);
        if (bootMs === null) {
          return failClosed(`pty-host never became ready: ${host.stderr.slice(-400)}`, {
            spawnMisses: 1,
            exitMisses: 1,
            exitCodeMisses: 1,
            lineMisses: PTY_LINES,
            ptyDataMessages: 0,
            ptyMirrorMessages: 0,
            ptyDataBytes: 0,
            payloadBytes: 0,
            residualHostCount: await teardown(host),
          });
        }

        let ptyDataMessages = 0;
        let ptyMirrorMessages = 0;
        let ptyDataBytes = 0;
        let spawnSucceeded = false;
        let spawnAnswered = false;
        const chunks: string[] = [];

        const stop = host.onMessage((message) => {
          if (message.id !== terminalId) return;
          if (message.type === "data") {
            ptyDataMessages += 1;
            ptyDataBytes += serializedBytes(message);
            if (typeof message.data === "string") chunks.push(message.data);
          } else if (message.type === "data-mirror") {
            // The main-process copy of a chunk the renderer already has. It is
            // a second real message on this channel, so it is counted — a
            // dual-delivery path is exactly the kind of volume this scenario
            // exists to make visible.
            ptyMirrorMessages += 1;
            ptyDataBytes += serializedBytes(message);
          } else if (message.type === "spawn-result") {
            const result = message.result as { success?: boolean } | undefined;
            spawnSucceeded = result?.success === true;
            spawnAnswered = true;
          }
        });

        const started = performance.now();
        host.send({
          type: "spawn",
          id: terminalId,
          options: {
            cwd: REPO_ROOT,
            // Wide enough that a ~40-character line never wraps, so a missing
            // line index means a lost line rather than a reflowed one.
            cols: 200,
            rows: 50,
            shell: process.execPath,
            args: [ptyPayloadScript(), String(PTY_LINES)],
            isEphemeral: true,
          },
        });

        // The payload holds the PTY open until it is released, so the host
        // reads at its own pace and node-pty never destroys a socket with
        // unread bytes behind it. Wait for the output, THEN let it exit.
        const streamDeadline = performance.now() + PTY_STREAM_TIMEOUT_MS;
        while (
          countDeliveredLines(chunks.join(""), PTY_LINES) < PTY_LINES &&
          performance.now() < streamDeadline
        ) {
          // A spawn that failed will never produce a line; waiting out the
          // whole window for it only delays the miss counts that say so.
          if (spawnAnswered && !spawnSucceeded) break;
          await sleep(PTY_STREAM_POLL_MS);
        }
        host.send({ type: "write", id: terminalId, data: "\n" });

        const exit = await host.waitFor(
          (message) => message.type === "exit" && message.id === terminalId,
          PTY_RUN_TIMEOUT_MS
        );
        await sleep(PTY_DRAIN_MS);
        const durationMs = performance.now() - started;
        stop();
        const exitedCleanly = exit !== null && exit.exitCode === 0;

        const text = chunks.join("");
        const payloadBytes = Buffer.byteLength(text, "utf8");
        const delivered = countDeliveredLines(text, PTY_LINES);
        const lineMisses = PTY_LINES - delivered;
        // The host owns the PTY, so tearing the host down takes the terminal
        // with it; a separate `kill` request would only race that.
        const residualHostCount = await teardown(host);

        return {
          durationMs,
          metrics: {
            ptyDataMessages,
            ptyMirrorMessages,
            ptyDataBytes,
            payloadBytes,
            // Two shape numbers that survive a hardware change: how much
            // channel traffic a terminal's output costs, and how much of that
            // traffic is framing rather than output.
            messagesPerKLine: (ptyDataMessages * 1000) / PTY_LINES,
            // Named for its operands, not for what it means. "Overhead ratio"
            // is ambiguous about whether it divides times or bytes, and
            // `comparability.ts` has to decide that from the name alone — it
            // read the old `cloneOverheadRatio` as duration-derived and took
            // away a comparison this number is entitled to.
            cloneBytesPerPayloadByte: payloadBytes > 0 ? ptyDataBytes / payloadBytes : 0,
            // The pairings. Harder coalescing and outright dropping both look
            // like "fewer messages" without `lineMisses`, and `payloadBytes`
            // above is the exact-arithmetic companion: 2000 lines is a fixed
            // byte total, so a short read shows there even if every marker
            // happened to survive.
            lineMisses,
            spawnMisses: spawnSucceeded ? 0 : 1,
            exitMisses: exit ? 0 : 1,
            // A PTY whose command died mid-stream also exits — with a nonzero
            // code. Without this, a truncated run reads as a smaller payload.
            exitCodeMisses: exitedCleanly ? 0 : 1,
            residualHostCount,
          },
          notes:
            lineMisses > 0
              ? `${lineMisses} of ${PTY_LINES} lines never arrived — the message count is not a coalescing win`
              : undefined,
        };
      } finally {
        host.kill();
      }
    },
  },
  {
    id: "PERF-046",
    name: "Utility Host Refork Readiness After Repeated Kills",
    description:
      "SIGKILL the workspace-host three times over, re-forking it each time, measuring respawn-to-ready and confirming the replacement actually serves a request. The product supervisor (WorkspaceHostProcess: crash classification, restart backoff, state replay) is NOT in this loop — this measures how fast a killed host comes back and whether it works, not whether Daintree would have restarted it.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 3, nightly: 5 },
    warmups: 0,
    correctness: ["respawnReadyMisses", "respawnHealthMisses", "reapMisses"],
    async run() {
      const cycles = 3;
      let host = spawnUtilityHost({ kind: "workspace" });
      let respawnReadyMisses = 0;
      let respawnHealthMisses = 0;
      let respawnToReadyMaxMs = 0;
      let reapMisses = 0;
      let respawns = 0;

      const started = performance.now();
      try {
        const firstBoot = await host.waitForReady(HOST_BOOT_TIMEOUT_MS);
        if (firstBoot === null) {
          return failClosed(`workspace-host never became ready: ${host.stderr.slice(-400)}`, {
            crashRespawnCount: 0,
            respawnReadyMisses: cycles,
            respawnHealthMisses: cycles,
            reapMisses: 0,
            respawnToReadyMaxMs: 0,
            residualHostCount: await teardown(host),
          });
        }

        for (let cycle = 0; cycle < cycles; cycle += 1) {
          host.kill();
          // The replacement must not be forked until the corpse is reaped, or
          // "recovery" would be measured against two live hosts. An unreaped
          // host stops the loop outright rather than stacking another one on
          // top of it: the remaining cycles would measure contention, and the
          // pile would outlive the scenario.
          if (!(await host.waitForExit(DISPOSE_TIMEOUT_MS))) {
            reapMisses += 1;
            break;
          }

          host = spawnUtilityHost({ kind: "workspace" });
          respawns += 1;
          const readyMs = await host.waitForReady(HOST_BOOT_TIMEOUT_MS);
          if (readyMs === null) {
            respawnReadyMisses += 1;
            respawnHealthMisses += 1;
            continue;
          }
          respawnToReadyMaxMs = Math.max(respawnToReadyMaxMs, readyMs);
          // A restarted host that boots but does not serve is the crash-loop
          // failure mode worth catching; a ready message alone would miss it.
          if ((await healthCheck(host)) === null) respawnHealthMisses += 1;
        }

        const durationMs = performance.now() - started;
        const residualHostCount = await teardown(host);

        return {
          durationMs,
          metrics: {
            crashRespawnCount: respawns,
            respawnReadyMisses,
            respawnHealthMisses,
            reapMisses,
            respawnToReadyMaxMs,
            residualHostCount,
          },
          notes:
            respawnHealthMisses > 0
              ? `${respawnHealthMisses} of ${respawns} respawned hosts never served a request`
              : respawns < cycles
                ? `stopped after ${respawns} of ${cycles} respawns — a killed host was never reaped`
                : undefined,
        };
      } finally {
        host.kill();
      }
    },
  },
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Also reports what it actually did, because the headline is a lag: a load that
 * stopped loading and a sampler that stopped sampling both drive the number
 * toward zero, which is the best result this scenario can record.
 */
async function measureEventLoopLag(
  sampleCount: number,
  loadFn: () => Promise<number>
): Promise<{ maxLagMs: number; samples: number; loadTurns: number }> {
  const intervalMs = 4;
  let maxLag = 0;
  let samples = 0;
  let loadTurns = 0;

  for (let i = 0; i < sampleCount; i += 1) {
    const start = performance.now();
    const timer = delay(intervalMs);
    loadTurns += await loadFn();
    await timer;

    const elapsed = performance.now() - start;
    const lag = Math.max(0, elapsed - intervalMs);
    maxLag = Math.max(maxLag, lag);
    samples += 1;
  }

  return { maxLagMs: maxLag, samples, loadTurns };
}
