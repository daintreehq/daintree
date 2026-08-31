import { performance } from "node:perf_hooks";
import type { PerfScenario, ScenarioSample } from "../types";
import {
  liveSupervisionChildCount,
  runSupervisionProbe,
  runWatchdogLadder,
  type SupervisorLadder,
} from "../lib/supervisionFixture";

/**
 * Utility-process SUPERVISION — the decision to restart, not the restart.
 *
 * PERF-046 and PERF-224 both measure a killed host coming back and both say, in
 * as many words, that they do not measure whether Daintree would have brought
 * it back: `WorkspaceHostProcess`, `PtyHostLifecycle`, `PluginDevWorkerHost`,
 * `MainProcessWatchdogClient` and the state replay behind them are outside
 * every existing fixture. This family is that half.
 *
 * Every headline here is a count, a byte total or a schedule, because a
 * supervisor is the subsystem where speed and correctness point in opposite
 * directions. **A supervisor that gives up immediately is the fastest
 * supervisor there is.** So is one that classifies every exit as fatal, one
 * that retries with no backoff, and one that respawns a host and hands it
 * nothing. All four post excellent numbers, and only a paired predicate
 * separates them from a supervisor that works.
 *
 * The predicates are therefore behavioural rather than self-reported. "Survived
 * a crash" means the fresh host answered a nonce round trip through the
 * supervisor's own broker, or received the exact message that makes it usable —
 * never that a respawn was attempted. "Replayed" means the state read back off
 * the fresh child matched what main had cached, field by field.
 *
 * `lib/supervisionFixture.ts` states the boundary in full. The short version:
 * the supervisors are real and unmodified, Electron and the OS fork are not,
 * `setTimeout` is a recorder rather than a sleep, and the only scenario with no
 * stub anywhere in its path is PERF-263.
 *
 * The four probe-backed scenarios report the probe's OWN `probeMs`, measured
 * inside the child, rather than wall-clocking `runSupervisionProbe`. Each
 * measured iteration still forks a fresh child — the probe installs
 * process-wide `electron`, timer, `Math.random` and `process.kill` wrappers, so
 * reuse across iterations is not sound — but that fork is a `node --import tsx`
 * boot plus a main-process module graph, and wrapping it made these headlines
 * mostly a reading of Node starting up.
 */

/** Rounds of the watchdog decision ladder per iteration. */
const WATCHDOG_ROUNDS = 40;

/**
 * A measurement that did not happen.
 *
 * Reported as a sample with every miss counter set high rather than thrown, so
 * an apparatus failure annotates the run instead of aborting it — and so the
 * absence can never read as a clean zero. Mirrors `scenarios/pluginHost.ts`.
 */
function failClosed(notes: string, metrics: Record<string, number>): ScenarioSample {
  return { durationMs: 0, metrics, notes };
}

function sum(ladders: readonly SupervisorLadder[], key: keyof SupervisorLadder): number {
  return ladders.reduce((total, entry) => total + Number(entry[key] ?? 0), 0);
}

export const supervisionScenarios: PerfScenario[] = [
  {
    id: "PERF-260",
    name: "Utility-host restart ladder and give-up boundary",
    description:
      "Feeds crashes to all four real utility-process supervisors and reports what each one decided: restarts attempted, the scheduled backoff bounds, and the crash at which it stops trying.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    warmups: 1,
    correctness: [
      "recoveryMisses",
      "firstCrashMisses",
      "giveUpMisses",
      "manualRecoveryMisses",
      "backoffMisses",
    ],
    run: async () => {
      let ladders: readonly SupervisorLadder[];
      let probeMs: number;
      try {
        ({ supervisors: ladders, probeMs } = await runSupervisionProbe("ladder"));
      } catch (error) {
        return failClosed(`supervision ladder probe failed: ${String(error)}`, {
          supervisorCount: 0,
          recoveryMisses: 99,
          firstCrashMisses: 99,
          giveUpMisses: 99,
          manualRecoveryMisses: 99,
          backoffMisses: 99,
        });
      }

      const byName = (name: string): SupervisorLadder | undefined =>
        ladders.find((entry) => entry.name === name);
      const ceilingOf = (name: string): number => byName(name)?.backoffCeilingMsSum ?? 0;
      /** Automatic restarts the budget grants before the supervisor stops. */
      const restartBudgetOf = (name: string): number =>
        Math.max(0, (byName(name)?.gaveUpAtCrash ?? 0) - 1);

      return {
        durationMs: probeMs,
        metrics: {
          supervisorCount: ladders.length,
          // The ladder itself: what the supervisors did, not how long it took.
          restartsAttempted: sum(ladders, "restartsAttempted"),
          crashesSurvivedCount: sum(ladders, "crashesSurvived"),
          hostForkCount: sum(ladders, "forks"),
          // The give-up boundary as a budget. Every supervisor in the app is
          // supposed to share this policy; reading them side by side is the
          // point, because they hold it as four duplicated private constants.
          workspaceRestartsBeforeGiveUp: restartBudgetOf("WorkspaceHostProcess"),
          ptyRestartsBeforeGiveUp: restartBudgetOf("PtyHostLifecycle"),
          pluginRestartsBeforeGiveUp: restartBudgetOf("PluginDevWorkerHost"),
          watchdogRestartsBeforeGiveUp: restartBudgetOf("MainProcessWatchdogClient"),
          // Zero armed timers means a supervisor respawns with no backoff at
          // all — a real difference between these four, invisible in latency
          // and, until `backoffMisses` below, ungraded: an instant-restart
          // supervisor recovers, serves and gives up identically.
          backoffTimersArmedCount: sum(ladders, "backoffTimersArmed"),
          // Deterministic despite the `~` marker the classifier gives a `*Ms`
          // name: these are the exact bounds of the product's own jitter range,
          // recovered by pinning `Math.random` to each end.
          backoffFloorMsSum: sum(ladders, "backoffFloorMsSum"),
          workspaceBackoffCeilingMs: ceilingOf("WorkspaceHostProcess"),
          ptyBackoffCeilingMs: ceilingOf("PtyHostLifecycle"),
          pluginBackoffCeilingMs: ceilingOf("PluginDevWorkerHost"),
          watchdogBackoffCeilingMs: ceilingOf("MainProcessWatchdogClient"),
          recoveryMisses: sum(ladders, "recoveryMisses"),
          firstCrashMisses: sum(ladders, "firstCrashMisses"),
          giveUpMisses: sum(ladders, "giveUpMisses"),
          manualRecoveryMisses: sum(ladders, "manualRecoveryMisses"),
          backoffMisses: sum(ladders, "backoffMisses"),
          residualChildCount: liveSupervisionChildCount(),
        },
        notes: ladders
          .map(
            (entry) =>
              `${entry.name}: ${entry.restartsAttempted} restarts, gave up at crash ${entry.gaveUpAtCrash}`
          )
          .join("; "),
      };
    },
  },
  {
    id: "PERF-261",
    name: "State replay into a respawned utility host",
    description:
      "Seeds a live session's cached host state, crashes the host, and reads back what the supervisor handed the replacement — messages, bytes, and whether each value survived.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    warmups: 1,
    correctness: ["replayMisses", "serveMisses"],
    run: async () => {
      try {
        const result = await runSupervisionProbe("replay");
        return {
          durationMs: result.probeMs,
          metrics: {
            replayMessages: result.replayMessages,
            replayBytes: result.replayBytes,
            // Supervisor work only: the scheduled backoff was fired on demand
            // and the fork is a stand-in, so this is the floor a respawn adds
            // on top of the delay PERF-260 reports, never a respawn latency.
            respawnToServingMs: result.respawnToServingMs,
            servedRoundTrips: result.servedRequests,
            replayMisses: result.replayMisses,
            serveMisses: result.serveMisses,
            residualChildCount: liveSupervisionChildCount(),
          },
          notes: `${result.replayMessages} replay messages, ${result.replayBytes} B, ${result.servedRequests} served round trip`,
        };
      } catch (error) {
        return failClosed(`supervision replay probe failed: ${String(error)}`, {
          replayMessages: 0,
          replayMisses: 99,
          serveMisses: 99,
        });
      }
    },
  },
  {
    id: "PERF-262",
    name: "Crash classification through the child-process-gone race",
    description:
      "Grades the real PTY host lifecycle against a table of exits, authoritative crash reasons that arrive a tick late, and one sibling shard's reason that must not be consumed.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    warmups: 1,
    correctness: ["classificationMisses", "crossAttributionMisses"],
    run: async () => {
      try {
        const result = await runSupervisionProbe("classification");
        return {
          // The whole case sweep, timed in the child. There is no separate
          // `sweepMs` metric because it would be this number twice.
          durationMs: result.probeMs,
          metrics: {
            classificationDecisionCount: result.classificationDecisions,
            goneReasonDecisionCount: result.goneReasonDecisions,
            classificationMisses: result.classificationMisses,
            crossAttributionMisses: result.crossAttributionMisses,
            residualChildCount: liveSupervisionChildCount(),
          },
          notes: `${result.classificationDecisions} verdicts, ${result.goneReasonDecisions} resolved from a deferred reason`,
        };
      } catch (error) {
        return failClosed(`supervision classification probe failed: ${String(error)}`, {
          classificationDecisionCount: 0,
          classificationMisses: 99,
          crossAttributionMisses: 99,
        });
      }
    },
  },
  {
    id: "PERF-263",
    name: "Watchdog core deadlock decision",
    description:
      "Drives the real watchdog core through a healthy main, a suspend, a wake burst and a freeze, reporting the detection window and grading kills in both directions.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: 2,
    correctness: ["spuriousKillMisses", "undetectedFreezeMisses", "flagMisses", "pidParseMisses"],
    run: () => {
      const started = performance.now();
      const result = runWatchdogLadder(WATCHDOG_ROUNDS);
      return {
        durationMs: performance.now() - started,
        metrics: {
          watchdogDecisionCount: result.watchdogDecisions,
          // How many heartbeats a frozen main survives, and the window that
          // buys it. Both are read off the core's own behaviour under an
          // injected clock, so they are exact on every machine.
          beatsToKillCount: result.beatsToKill,
          detectionWindowMs: result.detectionWindowMs,
          suppressedWakeTickCount: result.suppressedWakeTicks,
          ladderMs: result.ladderMs,
          // Graded in both directions: a kill that should not have fired, and a
          // freeze that was never killed.
          spuriousKillMisses: result.falseKills,
          undetectedFreezeMisses: result.missedKills,
          flagMisses: result.flagMisses,
          pidParseMisses: result.pidParseMisses,
        },
        notes: `kill after ${result.beatsToKill} missed beats (${result.detectionWindowMs}ms unresponsive)`,
      };
    },
  },
  {
    id: "PERF-264",
    name: "Terminal fleet replay after a PTY host crash",
    description:
      "Crashes the host under a 24-terminal fleet and grades the real PtyClient replay: every terminal re-sent, its launch options intact, and a fresh incarnation generation on each.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    warmups: 1,
    correctness: ["spawnReplayMisses", "generationMisses", "configReplayMisses"],
    run: async () => {
      try {
        const result = await runSupervisionProbe("ptyReplay");
        return {
          durationMs: result.probeMs,
          metrics: {
            replayedSpawns: result.replayedSpawns,
            replaySpawnBytes: result.replaySpawnBytes,
            configReplayMessages: result.configReplayMessages,
            // The replay burst is synchronous inside the shard's `ready`
            // handler, so this is main-thread time the whole app pays at once.
            replayMs: result.replayMs,
            spawnReplayMisses: result.spawnReplayMisses,
            generationMisses: result.generationMisses,
            configReplayMisses: result.configReplayMisses,
            residualChildCount: liveSupervisionChildCount(),
          },
          notes: `${result.replayedSpawns} terminals replayed in ${result.replayMs.toFixed(2)}ms`,
        };
      } catch (error) {
        return failClosed(`supervision pty-replay probe failed: ${String(error)}`, {
          replayedSpawns: 0,
          spawnReplayMisses: 99,
          generationMisses: 99,
          configReplayMisses: 99,
        });
      }
    },
  },
];
