import { performance } from "node:perf_hooks";

import type { PerfScenario, ScenarioSample } from "../types";
import type { ImagePathProbe as ImagePathProbeType } from "../../../electron/services/pty/ImagePathProbe";
import {
  allSpawnMark,
  allSpawnsSince,
  installGitSpawnCounter,
  sleep,
  spawnObserverMisses,
  type ProcessSpawnWindow,
} from "../lib/gitPipelineFixture";

/**
 * What a PID the image-path probe cannot read costs per minute (PERF-405).
 *
 * `ProcessDetector` calls `ImagePathProbe.readBasename()` for every process at
 * depth 2 or less on every ProcessTreeCache poll, and the pty-host polls at
 * 1500ms. Before #12239 a null result was indistinguishable from "never
 * probed", so a PID that can never resolve — one owned by another user, one
 * `lsof` cannot inspect, or any probe that timed out under load — started a
 * fresh `lsof` (macOS) or `powershell.exe` (Windows) on every single poll, for
 * as long as the process lived.
 *
 * Both directions are measured in ONE window, at the real cadence, against the
 * same real absent PID:
 *
 *   - the SUSTAINED arm is one long-lived probe read 40 times, which is what
 *     the product does;
 *   - the BASELINE arm is a fresh probe per read. That is not a simulation of
 *     the old code — it is the old rule exactly, because a read of a PID with
 *     no result scheduled a probe every time, which is what a first read of a
 *     fresh instance does. Same PID, same machine, same session, same minute.
 *
 * So `baselineToSustainedSpawnRatio` is a measured before/after rather than
 * arithmetic over a remembered number, and it stays honest if the curve is
 * ever retuned.
 *
 * PLATFORMS. Linux is declared `unsupported` and skipped rather than reported:
 * there the probe is `readlink /proc/<pid>/exe`, pure Node with no subprocess
 * at all, so `probeSpawns` is structurally zero both before and after the fix
 * and the benchmark could never move. Counting readlink calls instead would
 * mean wrapping the subject's own dependency, which is the shape this harness
 * exists to refuse. Windows is `diagnostic`: PowerShell is a direct child and
 * so is visible to the observer, but its start cost dominates the reading and
 * the observer's own Windows caveats apply.
 *
 * WHAT THIS IS NOT. The counted probes are absent-PID lookups. They exercise
 * the real failure path end to end, but a failing probe has no observable end,
 * so their individual cost is not timed here and `lsof` does less work when
 * there is no process to inspect anyway. `controlProbeWallMs` is timed against
 * a live process instead — this one — and is the closest thing to the issue's
 * 40ms figure that this scenario can honestly report. The spawn counts are the
 * finding; the wall figure is scale for it.
 */

/**
 * A PID no platform will have allocated: above 32-bit `pid_t`'s positive range
 * and far above every default `pid_max`. Chosen over "a PID owned by another
 * user" (which depends on who is running the benchmark) and over "a PID that
 * just exited" (which is a PID-reuse race against the rest of the machine).
 */
const ABSENT_PID = 2_147_483_647;

/** The pty-host's own `new ProcessTreeCache(1500)` cadence. */
const POLL_INTERVAL_MS = 1_500;

/** Reads in a 60s window at that cadence: t = 0, 1500 … 58500. */
const WINDOW_READS = 40;

/** Long enough for the 750ms probe timeout plus the process teardown after it. */
const SETTLE_TIMEOUT_MS = 5_000;
const SETTLE_POLL_MS = 5;

/**
 * How long the absent PID is given to come back with something before it is
 * accepted as unresolvable. A failing probe publishes nothing, so there is no
 * edge to wait for — polling it would just burn the timeout. One poll interval
 * clears the probe's own 750ms cap with room to spare.
 */
const QUALIFY_SETTLE_MS = 1_500;

/** The reduction the issue requires before this change is worth shipping. */
const REQUIRED_REDUCTION = 5;

const CORRECTNESS = [
  "spawnObserverMisses",
  "probeLivenessMisses",
  "faultQualificationMisses",
  "absentPidResolutionMisses",
  "backoffMisses",
  "cadenceMisses",
] as const;

type ImagePathProbeModule = typeof import("../../../electron/services/pty/ImagePathProbe");

let probeModulePromise: Promise<ImagePathProbeModule> | null = null;

/**
 * Loaded lazily, per the harness's lazy-fixture rule: `scenarios/index.ts`
 * imports every scenario module up front, so product code pulled in at module
 * scope would be charged to every run whichever id was selected.
 */
function loadImagePathProbeModule(): Promise<ImagePathProbeModule> {
  if (!probeModulePromise) {
    installGitSpawnCounter();
    probeModulePromise = import("../../../electron/services/pty/ImagePathProbe");
  }
  return probeModulePromise;
}

/**
 * Probe starts inside a window, by executable.
 *
 * Bucketed rather than taken from `count` so an unrelated start — the
 * observer's own self-validation child, anything the runner does — cannot be
 * read as a probe.
 */
function probeSpawnCount(window: ProcessSpawnWindow): number {
  const { byExecutable } = window;
  return (byExecutable.lsof ?? 0) + (byExecutable["powershell.exe"] ?? 0);
}

/** Read until the probe publishes something, or give up. Null means it never did. */
async function awaitResolution(
  probe: ImagePathProbeType,
  pid: number,
  timeoutMs = SETTLE_TIMEOUT_MS
): Promise<string | null> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const basename = probe.readBasename(pid);
    if (basename !== null) return basename;
    if (performance.now() >= deadline) return null;
    await sleep(SETTLE_POLL_MS);
  }
}

/**
 * Every miss set, for the paths where the apparatus itself did not work.
 *
 * A scenario that returns partial metrics after failing its own setup reports
 * a beautifully cheap window that measured nothing at all.
 */
function failClosed(reason: string, metrics: Record<string, number>): ScenarioSample {
  const failed: Record<string, number> = { ...metrics };
  for (const term of CORRECTNESS) {
    if (failed[term] === undefined || failed[term] === 0) failed[term] = 1;
  }
  return { durationMs: 0, metrics: failed, notes: `INVALID — ${reason}` };
}

export const imagePathProbeScenarios: PerfScenario[] = [
  {
    id: "PERF-405",
    name: "Image-Path Probe Retry Storm",
    description:
      "A real ImagePathProbe read at the pty-host's own 1500ms cadence for a full 60s window against a PID that can never resolve, counting the `lsof`/PowerShell starts it actually makes. Two arms share the window: one long-lived probe (what the product does) and a fresh probe per read, which is the pre-#12239 rule exactly rather than a stand-in for it — a read of an unresolved PID scheduled a probe every time. The ratio between them is therefore a measured before/after on one machine in one session. Graded against the apparatus rather than against itself: the observer proves it can still see a start, a positive control on this process's own PID proves the probe still resolves anything at all, the absent PID is qualified as genuinely costing a subprocess before the window opens, and the required 5x reduction is a predicate rather than a note. Skipped on Linux, where the probe is a bare readlink and there is no subprocess storm to measure.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    // One 60s window per iteration, and the count is a rate over that window:
    // a warmup would double the wall clock to sharpen a figure that is not
    // timing-sensitive.
    warmups: 0,
    iterations: { ci: 1, nightly: 1 },
    correctness: [...CORRECTNESS],
    platforms: { linux: "unsupported", win32: "diagnostic" },
    async run(): Promise<ScenarioSample> {
      const { ImagePathProbe } = await loadImagePathProbeModule();

      installGitSpawnCounter();
      // Before any measurement window: the observer's self-validation starts a
      // child of its own, which would otherwise land in the count it validates.
      const observerMisses = spawnObserverMisses();

      const control = new ImagePathProbe();
      const absent = new ImagePathProbe();
      const sustained = new ImagePathProbe();

      try {
        // Control: a PID that CAN be read must resolve. Without it, "almost no
        // probe starts" is indistinguishable from a probe that stopped working,
        // and the broken one posts the better number. It is also the only
        // probe here with an observable end, so it is where the per-probe wall
        // cost is taken — to a 5ms polling granularity, and against a live
        // process rather than an absent one.
        const controlStart = performance.now();
        const controlBasename = await awaitResolution(control, process.pid);
        const controlProbeWallMs = performance.now() - controlStart;

        // Qualification: the absent PID must actually cost a subprocess and
        // must actually fail. A candidate that resolved, or that never reached
        // the OS, would make every count below meaningless.
        const qualifyMark = allSpawnMark();
        absent.readBasename(ABSENT_PID);
        const qualifySpawns = probeSpawnCount(allSpawnsSince(qualifyMark));
        await sleep(QUALIFY_SETTLE_MS);
        const qualifyResult = absent.readBasename(ABSENT_PID);

        const preflight: Record<string, number> = {
          controlProbeWallMs,
          spawnObserverMisses: observerMisses,
          probeLivenessMisses: controlBasename === null ? 1 : 0,
          faultQualificationMisses: qualifySpawns >= 1 && qualifyResult === null ? 0 : 1,
        };

        if (preflight.probeLivenessMisses === 1) {
          return failClosed(
            "the probe could not resolve this process's own image path, so a low count here is a dead probe rather than a cheap one",
            preflight
          );
        }
        if (preflight.faultQualificationMisses === 1) {
          return failClosed(
            `the absent PID ${ABSENT_PID} did not produce a failing probe that costs a subprocess (${qualifySpawns} starts, resolved ${qualifyResult ?? "null"})`,
            preflight
          );
        }

        let sustainedSpawns = 0;
        let baselineSpawns = 0;
        let cadenceMisses = 0;
        let absentPidResolutionMisses = 0;

        const start = performance.now();
        for (let read = 0; read < WINDOW_READS; read += 1) {
          const deadline = start + read * POLL_INTERVAL_MS;
          const waitMs = deadline - performance.now();
          if (waitMs > 0) {
            await sleep(waitMs);
          } else if (waitMs < -POLL_INTERVAL_MS) {
            // A slot missed by more than a whole interval: the window did not
            // deliver the cadence it claims, so the rate it reports is not the
            // rate the product would pay.
            cadenceMisses += 1;
          }

          // The shipped path. `readBasename` starts its subprocess
          // synchronously, so the bracket needs no await to be complete.
          const sustainedMark = allSpawnMark();
          const served = sustained.readBasename(ABSENT_PID);
          sustainedSpawns += probeSpawnCount(allSpawnsSince(sustainedMark));
          // A PID that does not exist must never acquire a basename. This is
          // the direction a cache bug would break in silently.
          if (served !== null) absentPidResolutionMisses += 1;

          // The pre-fix rule: one probe per read of an unresolved PID.
          const baselineMark = allSpawnMark();
          const fresh = new ImagePathProbe();
          fresh.readBasename(ABSENT_PID);
          baselineSpawns += probeSpawnCount(allSpawnsSince(baselineMark));
          // Disposed immediately: its refresh settles into a disposed probe and
          // writes nothing, so the arm costs one start and no retained state.
          fresh.dispose();
        }
        const windowMs = performance.now() - start;

        const backoffMisses =
          sustainedSpawns >= 1 && baselineSpawns >= sustainedSpawns * REQUIRED_REDUCTION ? 0 : 1;

        const metrics: Record<string, number> = {
          ...preflight,
          sustainedProbeSpawns: sustainedSpawns,
          baselineProbeSpawns: baselineSpawns,
          baselineToSustainedSpawnRatio: sustainedSpawns > 0 ? baselineSpawns / sustainedSpawns : 0,
          readCalls: WINDOW_READS,
          windowMs,
          absentPidResolutionMisses,
          backoffMisses,
          cadenceMisses,
        };

        return {
          // Self-timed against nothing: the reading is a start count over a
          // fixed 60s window, and 60s of deliberate waiting is not a duration
          // anything should compare.
          durationMs: 0,
          metrics,
          notes:
            backoffMisses === 1
              ? `no meaningful backoff: ${sustainedSpawns} starts against a ${baselineSpawns}-start baseline, short of the required ${REQUIRED_REDUCTION}x`
              : `control resolved as "${controlBasename}"; ${sustainedSpawns} starts against a ${baselineSpawns}-start baseline over ${WINDOW_READS} reads`,
        };
      } finally {
        control.dispose();
        absent.dispose();
        sustained.dispose();
      }
    },
  },
];
