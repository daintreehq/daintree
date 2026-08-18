/**
 * Freeze harness (#11846) — Playwright-free, real-app measurement of whether a
 * cached project view's renderer actually stops executing tasks when the
 * production efficiency-freeze path freezes it.
 *
 * Why this exists rather than an E2E spec: Playwright sends
 * `Emulation.setFocusEmulationEnabled` to every page target it attaches to,
 * which takes out a `WebContents` capturer with `stay_hidden=false`. The
 * renderer is then permanently told it is user-visible, `WasHidden()` has
 * nothing to do, and `Page.setWebLifecycleState(frozen)` no-ops while still
 * returning success. Freeze is therefore unobservable from Playwright in every
 * project view, always. This harness boots the real `main.ts`/`bootstrap.ts`
 * with no debugger client of its own, so the freeze it measures is the freeze
 * users get.
 *
 * Three constraints shape the design:
 *
 * 1. No debugger client on the measured view. `freezeWebContents` calls
 *    `ensureAttached`; a second attach collides, lands in `EXPECTED_CDP_ERRORS`
 *    and is swallowed — the harness would suppress the freeze it came to
 *    observe. The renderer counts its own tasks instead, and
 *    `webContents.executeJavaScript` (Blink script execution, not CDP) moves
 *    the numbers out. The CPU throttle and memory purge the app itself attaches
 *    for are part of the production path and are deliberately left alone.
 *
 * 2. A frozen renderer cannot answer. `executeJavaScript` will not return while
 *    the page is frozen, so nothing can be read *during* the frozen window. The
 *    probe accumulates per-bucket tick counts keyed by wall-clock epoch time;
 *    the harness thaws first, then reads the whole timeline and slices out the
 *    interval that elapsed while frozen. Main and renderer share one system
 *    clock, so the slice boundaries need no clock alignment.
 *
 * 3. Ratios, not bounds. Reference numbers are ~113,000 tasks unfrozen against
 *    0 frozen. A timing threshold goes red on a loaded box; a hundredfold ratio
 *    does not.
 *
 * `MessageChannel` self-posting is the tick source on purpose. Timers are
 * subject to background throttling, which would confound "frozen" with "merely
 * throttled"; `MessageChannel` tasks are not throttled, so a collapse to zero
 * isolates freeze specifically.
 */

import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { execFile } from "child_process";
import os from "os";
import path from "path";
import { promisify } from "util";
import type { ProjectViewManager } from "../window/ProjectViewManager.js";
import { CACHED_VIEW_PURGE_DELAY_MS } from "../window/ProjectViewLifecycleController.js";
import { projectStore } from "./ProjectStore.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

const execFileAsync = promisify(execFile);

export const FREEZE_HARNESS_LOG_PREFIX = "[FREEZE-HARNESS]";

/**
 * Renderer-side tick bucket width. Bounds probe memory at one entry per bucket
 * (~1,600 entries for a default run). Kept small so bucket quantisation at a
 * window edge stays a rounding error rather than a measurable contribution.
 */
const BUCKET_MS = 10;
/** Let the tick loop reach steady state before the control window opens. */
const PROBE_WARMUP_MS = 750;
/**
 * Each measurement leg runs for this long. All three legs use the same width.
 * Overridable for run-to-run variance work, but the whole run must stay inside
 * `CACHED_VIEW_PURGE_DELAY_MS` (from the moment the view is cached) so the
 * periodic CDP memory purge never lands mid-measurement. `evaluatePurgeBudget`
 * enforces that against the elapsed clock and fails the run rather than
 * reporting a number measured across a purge.
 */
const MEASURE_WINDOW_MS = readWindowMsOverride() ?? 3_000;

function readWindowMsOverride(): number | null {
  const raw = process.env.DAINTREE_FREEZE_HARNESS_WINDOW_MS;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
/**
 * `setEfficiencyFreeze(true)` debounces its freeze pass by 500ms internally,
 * then the CDP command has to land. Excluded from the frozen window so the
 * measurement covers only time the view was actually frozen.
 */
const FREEZE_SETTLE_MS = 1_500;
/**
 * Guard between the close of the frozen window and the thaw. Without it the
 * window's trailing edge coincides with `setEfficiencyFreeze(false)`, so the
 * boundary bucket straddling that instant is filled with post-thaw ticks and
 * attributed to the frozen leg — a false negative that scales with how fast the
 * renderer runs. Symmetric with FREEZE_SETTLE_MS: both keep the measured window
 * strictly inside the interval the view was actually frozen, so the harness
 * measures the freeze rather than its transitions.
 */
const FREEZE_TRAILING_GUARD_MS = 750;
/** Symmetric allowance for the renderer to resume after `setEfficiencyFreeze(false)`. */
const THAW_SETTLE_MS = 1_000;
/** A still-frozen or dead renderer never answers; fail loudly instead of hanging. */
const PROBE_READ_TIMEOUT_MS = 15_000;
const VIEW_SETTLE_MS = 1_500;
/**
 * Slack subtracted from the purge deadline before the budget is accepted, so a
 * schedule that only fits if every `setTimeout` lands on time is rejected rather
 * than run. Timer overshoot across eight sequential delays is cumulative.
 */
const PURGE_BUDGET_GUARD_MS = 1_000;

/**
 * Liveness floor for the positive control only. Without it, a probe that never
 * started reads 0/0/0 and every ratio is vacuous. This is not a threshold on
 * the behavior under test — that assertion is the ratio below.
 */
export const MIN_CONTROL_TICKS = 1_000;
/** Reference gap is ~113,000 against 0. A hundredfold is the conservative floor. */
export const MIN_FREEZE_RATIO = 100;
export const MIN_RECOVERY_RATIO = 100;
/** Recovery must resume at a comparable rate, not merely be non-zero. */
export const MIN_RECOVERY_FRACTION_OF_CONTROL = 0.1;

export type TickBucket = readonly [bucket: number, count: number];

export interface ProbeReading {
  total: number;
  buckets: TickBucket[];
  visibilityState: string;
  hasFocus: boolean;
}

export interface FreezeMeasurement {
  controlTicks: number;
  frozenTicks: number;
  recoveredTicks: number;
}

export interface FreezeVerdict {
  passed: boolean;
  failures: string[];
  freezeRatio: number;
  recoveryRatio: number;
  recoveryFraction: number;
}

/**
 * Bucket-to-window overlap policy. `"contained"` counts only buckets wholly
 * inside the window; `"overlapping"` counts any bucket that touches it.
 *
 * The two modes are not symmetric by accident. The frozen leg is summed with
 * `"overlapping"` so a bucket straddling a boundary inflates the frozen count,
 * and the control and recovery legs with `"contained"` so a straddling bucket
 * deflates them. Both choices push the ratio down, so bucket quantisation can
 * only make the harness harder to pass, never easier.
 */
export function sumTicksInWindow(
  buckets: readonly TickBucket[],
  startMs: number,
  endMs: number,
  mode: "contained" | "overlapping",
  bucketMs: number = BUCKET_MS
): number {
  let total = 0;
  for (const [bucket, count] of buckets) {
    const bucketStart = bucket * bucketMs;
    const bucketEnd = bucketStart + bucketMs;
    const matches =
      mode === "contained"
        ? bucketStart >= startMs && bucketEnd <= endMs
        : bucketEnd > startMs && bucketStart < endMs;
    if (matches) total += count;
  }
  return total;
}

/**
 * Longest zero-tick stretch in the timeline, with its wall-clock bounds.
 * Diagnostic only — never asserted, because a duration is exactly the kind of
 * timing bound that goes red on a loaded box. Its value is in explaining a red
 * run: comparing the stall's bounds against the frozen window's bounds
 * separates "freeze leaked" from "the measurement window was misaligned".
 */
export function longestStall(
  buckets: readonly TickBucket[],
  bucketMs: number = BUCKET_MS
): { startMs: number; endMs: number; durationMs: number } {
  const live = buckets
    .filter(([, count]) => count > 0)
    .map(([bucket]) => bucket)
    .sort((a, b) => a - b);
  let best = { startMs: 0, endMs: 0, durationMs: 0 };
  for (let i = 1; i < live.length; i++) {
    const startMs = (live[i - 1]! + 1) * bucketMs;
    const endMs = live[i]! * bucketMs;
    const durationMs = endMs - startMs;
    if (durationMs > best.durationMs) best = { startMs, endMs, durationMs };
  }
  return best;
}

export interface PurgeBudget {
  /** Deterministic schedule still ahead of the check point, in ms. */
  plannedRemainingMs: number;
  /** When the last window closes, measured from the instant the view was cached. */
  plannedFinishMs: number;
  /** The purge instant the run has to beat, guard already subtracted. */
  deadlineMs: number;
  /** Signed slack against the deadline. Negative means the run would overrun it. */
  headroomMs: number;
  fits: boolean;
}

/**
 * Does the rest of the run fit before the cached view's first memory purge?
 *
 * The purge timer is armed inside `deactivateEntry` the moment the view flips to
 * `cached`, and fires `CACHED_VIEW_PURGE_DELAY_MS` later. A purge landing
 * mid-measurement perturbs the very throughput being measured, so the docstring
 * on `MEASURE_WINDOW_MS` has always said the run must finish first — this makes
 * that a check rather than a promise, because `MEASURE_WINDOW_MS` is
 * env-overridable and a large override silently produces a corrupted number.
 *
 * Takes elapsed time rather than assuming it: probe injection is an IPC
 * round-trip of unbounded duration, so the setup cost is only knowable at the
 * check point. Everything after that point is `setTimeout`s of known width.
 */
export function evaluatePurgeBudget({
  elapsedSinceCachedMs,
  measureWindowMs,
  purgeDelayMs = CACHED_VIEW_PURGE_DELAY_MS,
  guardMs = PURGE_BUDGET_GUARD_MS,
}: {
  elapsedSinceCachedMs: number;
  measureWindowMs: number;
  purgeDelayMs?: number;
  guardMs?: number;
}): PurgeBudget {
  // Three measurement legs plus the two settles and the trailing guard that
  // separate them. Mirrors the call order in `runFreezeHarness` below.
  const plannedRemainingMs =
    3 * measureWindowMs + FREEZE_SETTLE_MS + FREEZE_TRAILING_GUARD_MS + THAW_SETTLE_MS;
  const plannedFinishMs = elapsedSinceCachedMs + plannedRemainingMs;
  const deadlineMs = purgeDelayMs - guardMs;
  const headroomMs = deadlineMs - plannedFinishMs;
  return { plannedRemainingMs, plannedFinishMs, deadlineMs, headroomMs, fits: headroomMs >= 0 };
}

export function evaluateFreezeMeasurement(measurement: FreezeMeasurement): FreezeVerdict {
  const { controlTicks, frozenTicks, recoveredTicks } = measurement;
  // Guard the divisor, not the numerator: a genuine freeze reads exactly 0 and
  // must not divide by zero, but it also must not be rounded up into a pass.
  const divisor = Math.max(frozenTicks, 1);
  const freezeRatio = controlTicks / divisor;
  const recoveryRatio = recoveredTicks / divisor;
  const recoveryFraction = controlTicks > 0 ? recoveredTicks / controlTicks : 0;

  const failures: string[] = [];

  if (controlTicks < MIN_CONTROL_TICKS) {
    failures.push(
      `positive control is not alive: ${controlTicks} ticks in the unfrozen window (need >= ${MIN_CONTROL_TICKS}). ` +
        `Every ratio below is vacuous without it.`
    );
  }

  if (freezeRatio < MIN_FREEZE_RATIO) {
    failures.push(
      `freeze did not stop the renderer: ${controlTicks} ticks unfrozen vs ${frozenTicks} frozen ` +
        `(ratio ${freezeRatio.toFixed(1)}x, need >= ${MIN_FREEZE_RATIO}x).`
    );
  }

  if (recoveryRatio < MIN_RECOVERY_RATIO) {
    failures.push(
      `recovery leg did not clear the frozen leg: ${recoveredTicks} ticks recovered vs ${frozenTicks} frozen ` +
        `(ratio ${recoveryRatio.toFixed(1)}x, need >= ${MIN_RECOVERY_RATIO}x).`
    );
  }

  if (recoveryFraction < MIN_RECOVERY_FRACTION_OF_CONTROL) {
    failures.push(
      `view did not resume at a comparable rate after thaw: ${recoveredTicks} ticks vs ${controlTicks} control ` +
        `(${(recoveryFraction * 100).toFixed(1)}%, need >= ${MIN_RECOVERY_FRACTION_OF_CONTROL * 100}%). ` +
        `A view measuring zero because it died looks identical to one that froze properly.`
    );
  }

  return { passed: failures.length === 0, failures, freezeRatio, recoveryRatio, recoveryFraction };
}

const PROBE_START_JS = `(() => {
  if (window.__daintreeFreezeProbe) return "already-running";
  const probe = { total: 0, buckets: new Map() };
  window.__daintreeFreezeProbe = probe;
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    probe.total++;
    const bucket = Math.floor(Date.now() / ${BUCKET_MS});
    probe.buckets.set(bucket, (probe.buckets.get(bucket) || 0) + 1);
    channel.port2.postMessage(0);
  };
  channel.port2.postMessage(0);
  return "started";
})()`;

const PROBE_READ_JS = `(() => {
  const probe = window.__daintreeFreezeProbe;
  if (!probe) return null;
  return {
    total: probe.total,
    buckets: Array.from(probe.buckets.entries()),
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
  };
})()`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function log(message: string, ...args: unknown[]): void {
  console.error(`${FREEZE_HARNESS_LOG_PREFIX} ${message}`, ...args);
}

async function createHarnessRepo(root: string, name: string): Promise<string> {
  const repoPath = path.join(root, name);
  await mkdir(repoPath, { recursive: true });
  await writeFile(path.join(repoPath, "README.md"), `# ${name}\n`, "utf8");
  await execFileAsync("git", ["init"], { cwd: repoPath });
  return repoPath;
}

/**
 * Drives the real freeze path on one cached view and reports whether the
 * renderer genuinely stopped. Returns false on any failed assertion or setup
 * error; the caller maps that to the process exit code.
 */
export async function runFreezeHarness(pvm: ProjectViewManager): Promise<boolean> {
  // Every failure has to come back as `false`, not a rejection: the caller maps
  // the return value to the process exit code, and a throw would escape
  // `setupWindowServices` with the harness window still up and no exit issued.
  // `mkdtemp` is inside the guard for that reason — a full or unwritable tmpdir
  // is a setup failure like any other.
  let tempRoot: string | null = null;
  const createdProjectIds: string[] = [];

  try {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "daintree-freeze-harness-"));
    const pathA = await createHarnessRepo(tempRoot, "project-a");
    const pathB = await createHarnessRepo(tempRoot, "project-b");
    const projectA = await projectStore.addProject(pathA);
    createdProjectIds.push(projectA.id);
    const projectB = await projectStore.addProject(pathB);
    createdProjectIds.push(projectB.id);

    // Real activation path: A becomes active, then B displaces it. `switchTo`
    // runs `deactivateEntry` on A — detach, setVisible(false), CPU throttle,
    // cached state — which is exactly the state a freeze acts on in production.
    await pvm.switchTo(projectA.id, pathA);
    await delay(VIEW_SETTLE_MS);
    await pvm.switchTo(projectB.id, pathB);
    await delay(VIEW_SETTLE_MS);

    const cached = pvm.getAllViews().find((entry) => entry.projectId === projectA.id);
    if (!cached) {
      log("FAILED — project A has no view after switching away from it");
      return false;
    }
    if (cached.state !== "cached") {
      log("FAILED — project A's view is %s, expected cached", cached.state);
      return false;
    }
    const cachedWc = cached.view.webContents;
    if (cachedWc.isDestroyed()) {
      log("FAILED — project A's cached webContents was destroyed before measurement");
      return false;
    }
    log(
      "CHECK: cached view ready — projectId=%s visible=%s",
      projectA.id.slice(0, 8),
      String(cached.view.getVisible())
    );

    // Establish a known-thawed baseline before injecting. `deactivateEntry`
    // freezes the outgoing view immediately — no debounce — when efficiency
    // freeze is already on, and `ResourceProfileService` can turn it on at any
    // point on its own 30s cadence. Without this, a run that started under the
    // efficiency profile would inject into a frozen renderer (which never
    // answers) or measure a control leg that was frozen the whole time. Calling
    // it with `false` when already false and idle is a no-op; with a freeze
    // timer pending it cancels the timer and thaws, which is what we want.
    pvm.setEfficiencyFreeze(false);

    const started = await withTimeout(
      cachedWc.executeJavaScript(PROBE_START_JS, true) as Promise<string>,
      PROBE_READ_TIMEOUT_MS,
      "probe injection timed out"
    );
    if (started !== "started") {
      log("FAILED — probe did not start (%s)", String(started));
      return false;
    }
    await delay(PROBE_WARMUP_MS);
    log("CHECK: probe running — OK");

    // Last point before the clock matters. Setup is done, so the only unknown —
    // how long injection took — is now measured rather than assumed.
    const budget = evaluatePurgeBudget({
      elapsedSinceCachedMs: Date.now() - cached.lastUsed,
      measureWindowMs: MEASURE_WINDOW_MS,
    });
    if (!budget.fits) {
      log(
        "FAILED — measurement would outlast the cached-view purge: window=%dms needs %dms more, " +
          "finishing at %dms after caching against a %dms deadline (%dms short). " +
          "Lower DAINTREE_FREEZE_HARNESS_WINDOW_MS.",
        MEASURE_WINDOW_MS,
        budget.plannedRemainingMs,
        budget.plannedFinishMs,
        budget.deadlineMs,
        -budget.headroomMs
      );
      return false;
    }

    const controlStart = Date.now();
    await delay(MEASURE_WINDOW_MS);
    const controlEnd = Date.now();

    pvm.setEfficiencyFreeze(true);
    await delay(FREEZE_SETTLE_MS);
    const frozenStart = Date.now();
    await delay(MEASURE_WINDOW_MS);
    const frozenEnd = Date.now();

    await delay(FREEZE_TRAILING_GUARD_MS);
    pvm.setEfficiencyFreeze(false);
    await delay(THAW_SETTLE_MS);
    const recoveredStart = Date.now();
    await delay(MEASURE_WINDOW_MS);
    const recoveredEnd = Date.now();

    // First read of the run. Anything earlier would have to survive the frozen
    // window, and a frozen renderer does not answer.
    const reading = await withTimeout(
      cachedWc.executeJavaScript(PROBE_READ_JS, true) as Promise<ProbeReading | null>,
      PROBE_READ_TIMEOUT_MS,
      "probe read timed out after thaw — the view never resumed executing JavaScript"
    );
    if (!reading) {
      log("FAILED — probe state was missing after thaw (renderer navigated or was replaced)");
      return false;
    }

    const measurement: FreezeMeasurement = {
      controlTicks: sumTicksInWindow(reading.buckets, controlStart, controlEnd, "contained"),
      frozenTicks: sumTicksInWindow(reading.buckets, frozenStart, frozenEnd, "overlapping"),
      recoveredTicks: sumTicksInWindow(reading.buckets, recoveredStart, recoveredEnd, "contained"),
    };
    const verdict = evaluateFreezeMeasurement(measurement);

    const stall = longestStall(reading.buckets);
    log(
      "visibilityState=%s hasFocus=%s totalTicks=%d",
      reading.visibilityState,
      String(reading.hasFocus),
      reading.total
    );
    // Offsets are relative to the frozen window's start, so a red run shows at
    // a glance whether the stall covered the window or fell beside it.
    log(
      "frozenWindow=[0,%d] longestStall=[%d,%d] durationMs=%d frozenInterior=%d",
      frozenEnd - frozenStart,
      stall.startMs - frozenStart,
      stall.endMs - frozenStart,
      stall.durationMs,
      sumTicksInWindow(reading.buckets, frozenStart, frozenEnd, "contained")
    );
    log(
      "window=%dms control=%d frozen=%d recovered=%d",
      MEASURE_WINDOW_MS,
      measurement.controlTicks,
      measurement.frozenTicks,
      measurement.recoveredTicks
    );
    log(
      "freezeRatio=%sx recoveryRatio=%sx recoveryFraction=%s%%",
      verdict.freezeRatio.toFixed(1),
      verdict.recoveryRatio.toFixed(1),
      (verdict.recoveryFraction * 100).toFixed(1)
    );
    log(
      "RESULT %s",
      JSON.stringify({
        control: measurement.controlTicks,
        frozen: measurement.frozenTicks,
        recovered: measurement.recoveredTicks,
        freezeRatio: Number(verdict.freezeRatio.toFixed(2)),
        recoveryRatio: Number(verdict.recoveryRatio.toFixed(2)),
        visibilityState: reading.visibilityState,
      })
    );

    if (!verdict.passed) {
      for (const failure of verdict.failures) {
        log("FAILED — %s", failure);
      }
      return false;
    }

    log("CHECK: freeze ratio — OK");
    log("CHECK: recovery — OK");
    log("PASS");
    return true;
  } catch (error) {
    log("FAILED — %s", formatErrorMessage(error, "freeze harness threw"));
    return false;
  } finally {
    // An early return or a throw can leave the view frozen; the process is about
    // to exit either way, but a frozen view can't answer the CDP teardown the
    // shutdown path issues.
    try {
      pvm.setEfficiencyFreeze(false);
    } catch {
      // best-effort
    }
    for (const projectId of createdProjectIds) {
      try {
        await projectStore.removeProject(projectId);
      } catch {
        // best-effort cleanup
      }
    }
    if (tempRoot) {
      // Guarded: on Windows the app can still hold a handle under this root, and
      // a rejected unlink here would replace a completed verdict with a throw.
      try {
        await rm(tempRoot, { recursive: true, force: true });
      } catch (error) {
        log("WARN — could not remove %s: %s", tempRoot, formatErrorMessage(error, "unknown"));
      }
    }
  }
}
