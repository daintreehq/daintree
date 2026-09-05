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
 *   - the BASELINE arm is a fresh probe per read. A first read on a fresh
 *     instance takes the same path the old gate took on EVERY read of an
 *     unresolved PID, so its start count is the old rule's start count —
 *     subject to the one condition the old gate also carried, `!refreshing`,
 *     which `baselineFidelityMisses` checks by requiring one start per read.
 *     Same PID, same machine, same session, same minute.
 *
 * So `baselineToSustainedSpawnRatio` is a measured before/after rather than
 * arithmetic over a remembered number, and it stays honest if the curve is
 * ever retuned. It is a comparison of START COUNTS and only that: a fresh
 * instance also allocates a map and runs the creation-time sweep, so the two
 * arms are not identical in every byte of work, just in the thing being
 * counted. For a full before/after of the whole implementation, run this
 * scenario on the parent commit — `backoffMisses` is deliberately not an
 * integrity predicate so that reading stays valid.
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
 * `INT32_MAX` — a valid positive PID as far as the probe's own argument check
 * is concerned, so the lookup really does reach the OS, but far above every
 * default `pid_max` and above macOS's allocation range, so nothing holds it.
 * Chosen over "a PID owned by another user" (which depends on who is running
 * the benchmark) and over "a PID that just exited" (which is a PID-reuse race
 * against the rest of the machine). `faultQualificationMisses` checks the
 * choice rather than trusting it.
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

/**
 * Apparatus predicates only.
 *
 * `backoffMisses` — the issue's 5x bar — is REPORTED but deliberately not
 * declared here. It grades the subject rather than the apparatus, so under
 * `--enforce-integrity` it would make the pre-backoff tree unmeasurable, and a
 * valid reading of the old behaviour has to stay valid evidence.
 *
 * `retryLivenessMisses` is the term that makes the rest safe. Without it a
 * probe whose retries had stopped completely reports one start against a
 * forty-start reference — an 8x "improvement" bettered only by breaking it
 * further — with every other predicate at zero.
 */
const CORRECTNESS = [
  "spawnObserverMisses",
  "probeLivenessMisses",
  "faultQualificationMisses",
  "absentPidResolutionMisses",
  "retryLivenessMisses",
  "baselineFidelityMisses",
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
      "A real ImagePathProbe read at the pty-host's own 1500ms cadence for the 40 polls a minute contains, against a PID that can never resolve, counting the `lsof`/PowerShell starts it actually makes. Two arms share the window: one long-lived probe (what the product does) and a fresh probe per read, whose first read takes the same path the pre-#12239 gate took on every read of an unresolved PID. The ratio between them is a measured before/after on one machine in one session rather than arithmetic over a remembered number. The predicates grade the apparatus, not the feature: the observer proves it can still see a start, a positive control on this process's own PID proves the probe resolves anything at all, the absent PID is qualified as genuinely costing a subprocess, the reference arm must achieve its one-start-per-read workload, and — the one without which none of the rest is safe — the sustained arm must have retried at all and still be retrying in the back half of the window, because a probe whose retries died reports one start against forty and scores better than a working one. The issue's 5x bar is reported but deliberately left out of the predicates, so a reading taken on the pre-backoff tree stays valid evidence. Skipped on Linux, where the probe is a bare readlink and there is no subprocess storm to measure.",
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
        // probe here with an observable end, so it is where the wall cost is
        // taken — against a live process rather than an absent one, to a 5ms
        // polling granularity, and measured to PUBLICATION: if the first
        // lookup failed this includes its cooldown and the retry after it, so
        // read it as an upper bound on one probe, not as one probe.
        const controlStart = performance.now();
        const controlBasename = await awaitResolution(control, process.pid);
        const controlProbeWallMs = performance.now() - controlStart;

        // Qualification: the absent PID must cost a start and must not come
        // back with a basename. A candidate that resolved, or that the probe
        // rejected before reaching the OS, would make every count below
        // meaningless. This establishes "a start was attempted and nothing was
        // published", not the exit status of the command — the observer records
        // the start before handing off to the real `spawn`. That the lookups
        // genuinely COMPLETE is established later, by `retryLivenessMisses`:
        // the gate will not start a second probe while the first is in flight.
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

        let baselineSpawns = 0;
        let cadenceMisses = 0;
        let absentPidResolutionMisses = 0;
        /** Offset of every start the sustained arm made, for the liveness read. */
        const sustainedLaunchOffsets: number[] = [];

        const start = performance.now();
        for (let read = 0; read < WINDOW_READS; read += 1) {
          const deadline = start + read * POLL_INTERVAL_MS;
          const waitMs = deadline - performance.now();
          if (waitMs > 0) await sleep(waitMs);

          // Lateness is read AFTER the wait, not before it. Checking the
          // pre-sleep clock scores the slot the scheduler was asked for rather
          // than the one it delivered, so an oversleeping runner produces a
          // burst of catch-up reads that all look punctual.
          const offset = performance.now() - start;
          if (offset - read * POLL_INTERVAL_MS > POLL_INTERVAL_MS) cadenceMisses += 1;

          // The shipped path. `readBasename` starts its subprocess
          // synchronously, so the bracket needs no await to be complete.
          const sustainedMark = allSpawnMark();
          const served = sustained.readBasename(ABSENT_PID);
          if (probeSpawnCount(allSpawnsSince(sustainedMark)) > 0) {
            sustainedLaunchOffsets.push(offset);
          }
          // A PID that does not exist must never acquire a basename. This is
          // the direction a cache bug would break in silently.
          if (served !== null) absentPidResolutionMisses += 1;

          // The reference arm: a first read on a fresh instance, which is what
          // the pre-fix gate did on EVERY read of an unresolved PID — provided
          // the previous probe had settled, which the gate also required then.
          const baselineMark = allSpawnMark();
          const fresh = new ImagePathProbe();
          fresh.readBasename(ABSENT_PID);
          baselineSpawns += probeSpawnCount(allSpawnsSince(baselineMark));
          // Disposed immediately: its refresh settles into a disposed probe and
          // writes nothing, so the arm costs one start and no retained state.
          fresh.dispose();
        }
        const windowMs = performance.now() - start;
        const sustainedSpawns = sustainedLaunchOffsets.length;
        const lastLaunchOffset = sustainedLaunchOffsets[sustainedSpawns - 1] ?? 0;

        // Let the last arm's children finish rather than returning over the top
        // of them: `dispose()` clears cache state and cancels nothing, and the
        // smoke driver exits the process on return.
        await sleep(QUALIFY_SETTLE_MS);

        // THE predicate this scenario cannot be trusted without. A probe whose
        // retries stopped after the first failure reports one start against a
        // forty-start reference and scores better than a working one. Two
        // readings, both of which a dead retry path fails: it must have
        // retried at all, and it must still have been retrying in the back
        // half of the window. It doubles as proof that the probes COMPLETE —
        // the gate refuses to start a second one while the first is in flight,
        // so a second start cannot happen unless the first settled.
        const retryLivenessMisses =
          sustainedSpawns >= 2 && lastLaunchOffset >= windowMs / 2 ? 0 : 1;

        // The reference has to be the workload it claims. One start per read is
        // the pre-fix rule; anything less means its probes were not settling
        // between polls and it is understating what the old code cost.
        const baselineFidelityMisses = baselineSpawns === WINDOW_READS ? 0 : 1;

        const backoffMisses =
          sustainedSpawns >= 1 && baselineSpawns >= sustainedSpawns * REQUIRED_REDUCTION ? 0 : 1;

        const metrics: Record<string, number> = {
          ...preflight,
          sustainedProbeSpawns: sustainedSpawns,
          baselineProbeSpawns: baselineSpawns,
          baselineToSustainedSpawnRatio: sustainedSpawns > 0 ? baselineSpawns / sustainedSpawns : 0,
          lastSustainedLaunchMs: lastLaunchOffset,
          readCalls: WINDOW_READS,
          windowMs,
          absentPidResolutionMisses,
          retryLivenessMisses,
          baselineFidelityMisses,
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
              ? `no meaningful backoff: ${sustainedSpawns} starts against a ${baselineSpawns}-start reference, short of the required ${REQUIRED_REDUCTION}x`
              : `control resolved as "${controlBasename}"; ${sustainedSpawns} starts against a ${baselineSpawns}-start reference over ${WINDOW_READS} reads, last retry at ${Math.round(lastLaunchOffset)}ms`,
        };
      } finally {
        control.dispose();
        absent.dispose();
        sustained.dispose();
      }
    },
  },
];
