import { execFile } from "node:child_process";
import { logDebug, logInfo, logWarn } from "../utils/logger.js";
import { readElectronSwapUsage, type SwapUsage } from "../utils/systemMemory.js";
import { recordSwapPressure, SWAP_PRESSURE_STALE_MS } from "./systemSwapPressure.js";
import {
  getLastKernelPressureReadingAt,
  isKernelPressureCritical,
  recordKernelPressureLevel,
} from "./systemKernelPressure.js";
import { recordWatchdogMemoryPressure } from "./watchdogMemoryPressure.js";
import type {
  SystemMemoryPressurePayload,
  SystemMemoryWorkloads,
} from "../../shared/types/ipc/system.js";
import type { CompositeMemorySnapshot } from "../../shared/types/memoryAccounting.js";

/**
 * Floor between samples. Sampling rides the app-metrics poll (30s, stretched
 * to 150s while focus-throttled), so this gates on elapsed time rather than a
 * tick count — on Darwin each sample costs two short process spawns.
 */
export const SAMPLE_INTERVAL_MS = 60_000;
export const SWAP_USED_PERCENT_THRESHOLD = 80;
export const FSEVENTSD_RSS_THRESHOLD_MB = 8 * 1024;
/**
 * Swap in use, beyond the percentage, before kernel-plus-swap pressure counts
 * toward cached-view reclaim (#13223). macOS swap is dynamic, so the percentage
 * is relative to whatever swapfiles exist right now: a single small swapfile
 * reads 90% full on a machine that is barely swapping.
 */
export const SWAP_PRESSURE_MIN_USED_MB = 4096;
/**
 * Consecutive samples meeting the kernel-plus-swap test before reclaim may act
 * on it. Shorter than {@link EPISODE_OPEN_SAMPLES}: the cache sampler applies
 * its own confirmation and minimum view age on top.
 */
export const SWAP_PRESSURE_CONFIRM_SAMPLES = 2;
/** Consecutive over-threshold samples that open an episode. */
export const EPISODE_OPEN_SAMPLES = 3;
/**
 * Consecutive fully observed clear samples that close one. Hysteresis: a
 * reading that hovers on a threshold would otherwise reopen the notice every
 * few minutes.
 */
export const EPISODE_CLEAR_SAMPLES = 3;
/**
 * Longest a publish waits on {@link SystemMemoryPressureMonitorDeps.readWorkloads}
 * before going out without it: a pty host stalled by the same pressure must
 * not hold back the warning.
 */
export const WORKLOADS_READ_TIMEOUT_MS = 2_000;
/** Projects a published payload names, heaviest first. */
export const MAX_PUBLISHED_WORKLOADS = 3;

const PROBE_TIMEOUT_MS = 5_000;
const SYSCTL_MAX_BUFFER = 64 * 1024;
const PS_MAX_BUFFER = 1024 * 1024;

const SWAP_UNIT_MB: Record<string, number> = {
  B: 1 / (1024 * 1024),
  K: 1 / 1024,
  M: 1,
  G: 1024,
  T: 1024 * 1024,
};

/**
 * `kern.memorystatus_vm_pressure_level` as XNU defines it: 1 normal, 2 warn,
 * 4 critical. Nothing else is a valid reading.
 */
export type KernelPressureLevel = 1 | 2 | 4;

export const KERNEL_PRESSURE_WARN: KernelPressureLevel = 2;
export const KERNEL_PRESSURE_CRITICAL: KernelPressureLevel = 4;

export interface SystemMemorySample {
  /** Null when the reading failed. */
  swap: SwapUsage | null;
  /** Null when the reading failed, or off Darwin where it does not apply. */
  fseventsdRssMb: number | null;
  /** Null when the reading failed, or off Darwin where it does not apply. */
  kernelPressureLevel: KernelPressureLevel | null;
}

export interface SystemMemoryPressureMonitorDeps {
  isDarwin: boolean;
  swapKind: SystemMemoryPressurePayload["swapKind"];
  readSwap: () => Promise<SwapUsage | null>;
  readFseventsdRssMb: () => Promise<number | null>;
  readKernelPressureLevel: () => Promise<KernelPressureLevel | null>;
  publish: (payload: SystemMemoryPressurePayload) => void;
  /**
   * What Daintree is hosting, read only when a `degraded` payload is about to
   * be published. Null, or a rejection, publishes without it.
   */
  readWorkloads?: () => Promise<SystemMemoryWorkloads | null>;
  /**
   * Called with every sample's verdict on kernel-plus-swap pressure — kernel
   * warning or worse while swap is both over {@link SWAP_USED_PERCENT_THRESHOLD}
   * and {@link SWAP_PRESSURE_MIN_USED_MB}, for
   * {@link SWAP_PRESSURE_CONFIRM_SAMPLES} samples in a row. The kernel level
   * alone never qualifies: since #12815 a warning only asks renderers to trim.
   */
  onSwapPressure?: (confirmed: boolean) => void;
  /** Called with every sample's kernel level, null when it was not read. */
  onKernelPressureLevel?: (level: KernelPressureLevel | null) => void;
  /**
   * Called with every sample's verdict for the main-process watchdog (#13528):
   * true on a kernel warning or worse, or swap over
   * {@link SWAP_USED_PERCENT_THRESHOLD} (and on Darwin, whose swap is dynamic,
   * over {@link SWAP_PRESSURE_MIN_USED_MB} too); false when every reading that
   * applies came back below; null when a failed reading leaves it undecided.
   * No confirmation run: one sample is enough to lengthen the watchdog's
   * deadline. `sampledAt` is the wall-clock start of the sample.
   */
  onWatchdogPressure?: (elevated: boolean | null, sampledAt: number) => void;
  now?: () => number;
  /**
   * Wall clock for the swap-pressure run. The monotonic `now` stops while the
   * machine sleeps, which is exactly the gap this has to see.
   */
  wallNow?: () => number;
}

export interface SystemMemoryPressureMonitor {
  /**
   * Takes a sample when {@link SAMPLE_INTERVAL_MS} has elapsed and none is in
   * flight; otherwise a no-op. Never rejects.
   */
  sample: () => Promise<void>;
}

function parseSwapFigureMb(stdout: string, label: "total" | "used"): number | null {
  const match = new RegExp(`(?:^|\\s)${label} = (\\d+(?:\\.\\d+)?)([BKMGT])`).exec(stdout);
  if (!match) return null;
  const value = Number(match[1]) * SWAP_UNIT_MB[match[2]!]!;
  return Number.isFinite(value) ? value : null;
}

/**
 * Parses `sysctl -n vm.swapusage`, e.g.
 * `total = 2048.00M  used = 642.75M  free = 1405.25M  (encrypted)`.
 * The unit suffix varies and the `(encrypted)` tail is optional.
 */
export function parseDarwinSwapUsage(stdout: string): SwapUsage | null {
  const totalMb = parseSwapFigureMb(stdout, "total");
  const usedMb = parseSwapFigureMb(stdout, "used");
  if (totalMb === null || usedMb === null || usedMb > totalMb) return null;
  return { usedMb, totalMb };
}

/**
 * Parses `sysctl -n kern.memorystatus_vm_pressure_level`. Anything but an exact
 * 1, 2 or 4 is an unreadable sample, not a pressure level.
 */
export function parseKernelPressureLevel(stdout: string): KernelPressureLevel | null {
  const text = stdout.trim();
  if (text === "1") return 1;
  if (text === "2") return 2;
  if (text === "4") return 4;
  return null;
}

export function describeKernelPressureLevel(
  level: KernelPressureLevel | null
): SystemMemoryPressurePayload["kernelPressureLevel"] {
  if (level === KERNEL_PRESSURE_CRITICAL) return "critical";
  if (level === KERNEL_PRESSURE_WARN) return "warn";
  return null;
}

/**
 * Largest resident size (MB) of a process named exactly `fseventsd` in
 * `ps -axo rss=,ucomm=` output, or 0 when none is running. RSS leads the line
 * because `ucomm` can itself contain spaces; `ucomm` rather than `comm`
 * because `comm` is the full framework path, which `ps` truncates before the
 * name whenever the column is not last.
 */
export function parseFseventsdRssMb(stdout: string): number {
  let maxKb = 0;
  for (const line of stdout.split("\n")) {
    if (!line.includes("fseventsd")) continue;
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match || match[2] !== "fseventsd") continue;
    const kb = Number(match[1]);
    if (Number.isFinite(kb) && kb > maxKb) maxKb = kb;
  }
  return maxKb / 1024;
}

/** Null where the reading failed. */
interface OverCauses {
  swapOver: boolean | null;
  fseventsdOver: boolean | null;
  kernelPressureLevel: KernelPressureLevel | null;
}

/**
 * A reading that differs from the last one seen. A failed reading is no
 * change, and neither is a first healthy reading of a figure that had only
 * ever failed — it completes the picture rather than altering it.
 */
function overCausesChanged(seen: OverCauses, observed: OverCauses): boolean {
  const differs = <T>(before: T | null, after: T | null, healthy: boolean) =>
    after !== null && after !== before && !(before === null && healthy);
  return (
    differs(seen.swapOver, observed.swapOver, observed.swapOver === false) ||
    differs(seen.fseventsdOver, observed.fseventsdOver, observed.fseventsdOver === false) ||
    differs(
      seen.kernelPressureLevel,
      observed.kernelPressureLevel,
      observed.kernelPressureLevel !== null && observed.kernelPressureLevel < KERNEL_PRESSURE_WARN
    )
  );
}

function mergeOverCauses(seen: OverCauses | null, observed: OverCauses): OverCauses {
  return {
    swapOver: observed.swapOver ?? seen?.swapOver ?? null,
    fseventsdOver: observed.fseventsdOver ?? seen?.fseventsdOver ?? null,
    kernelPressureLevel: observed.kernelPressureLevel ?? seen?.kernelPressureLevel ?? null,
  };
}

/**
 * Observes whether the machine itself is degraded — swap nearly full, or on
 * Darwin an `fseventsd` grown to many gigabytes or the kernel reporting memory
 * pressure (#12799) — so a slow Mac is not read as
 * a slow Daintree (#12462). Numbers only: it never infers a cause.
 *
 * The first over-threshold sample logs a `system-health` record, and another
 * follows only when the episode opens or which thresholds are crossed (or the
 * kernel level) changes — never merely because the figures moved (#12888). An
 * episode opens after {@link EPISODE_OPEN_SAMPLES} consecutive over-threshold
 * samples and is published; it is published again each time it worsens — a
 * higher kernel level or a threshold newly crossed (#13529) — never when it
 * eases or merely moves, so an episode publishes at most a few times; it closes, with one recovery record
 * and one publish, after {@link EPISODE_CLEAR_SAMPLES} consecutive fully
 * observed clear samples. A
 * sample with a failed reading breaks both runs — a missing measurement can
 * neither open an episode nor prove recovery.
 *
 * Owns no timer: `startAppMetricsMonitor` drives it from its existing poll.
 */
export function createSystemMemoryPressureMonitor(
  deps: SystemMemoryPressureMonitorDeps
): SystemMemoryPressureMonitor {
  // Monotonic, so a wall-clock step backwards cannot stall sampling.
  const now = deps.now ?? (() => performance.now());
  let lastSampleAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  let overStreak = 0;
  let clearStreak = 0;
  /** An over-threshold record was logged since the last recovery record. */
  let elevated = false;
  let episodeOpen = false;
  /**
   * Which thresholds were last seen crossed, and the kernel level, since the
   * last recovery; null until the first over-threshold sample. A failed reading
   * keeps the previous value rather than reading as a change.
   */
  let seenCauses: OverCauses | null = null;
  /** The worst the episode's publishes have reported; null while none is open. */
  let publishedCauses: {
    swapOver: boolean;
    fseventsdOver: boolean;
    kernelPressureLevel: KernelPressureLevel | null;
  } | null = null;
  const wallNow = deps.wallNow ?? (() => Date.now());
  let swapPressureStreak = 0;
  let swapPressureConfirmed = false;
  let lastSwapSampleAt = Number.NEGATIVE_INFINITY;

  /**
   * A failed reading breaks the run like any other: a missing measurement
   * cannot confirm pressure. So does a sample whose probes outlived their
   * timeout (they straddled a sleep, so their figures predate the wake), and a
   * gap longer than a verdict stays fresh — two samples an hour apart are not
   * consecutive.
   */
  function recordSwapPressureSample(
    sample: SystemMemorySample,
    swapUsedPercent: number | null,
    startedAt: number
  ) {
    const { swap, kernelPressureLevel } = sample;
    const finishedAt = wallNow();
    // A clock that stepped backwards can hide a sleep, so it counts as one.
    const probeMs = finishedAt - startedAt;
    const spannedSuspend = probeMs < 0 || probeMs > PROBE_TIMEOUT_MS * 2;
    const gapMs = finishedAt - lastSwapSampleAt;
    if (gapMs < 0 || gapMs > SWAP_PRESSURE_STALE_MS) swapPressureStreak = 0;
    lastSwapSampleAt = finishedAt;
    const qualifies =
      !spannedSuspend &&
      kernelPressureLevel !== null &&
      kernelPressureLevel >= KERNEL_PRESSURE_WARN &&
      swap !== null &&
      swapUsedPercent !== null &&
      swapUsedPercent > SWAP_USED_PERCENT_THRESHOLD &&
      swap.usedMb >= SWAP_PRESSURE_MIN_USED_MB;
    swapPressureStreak = qualifies ? swapPressureStreak + 1 : 0;
    const confirmed = swapPressureStreak >= SWAP_PRESSURE_CONFIRM_SAMPLES;
    if (confirmed !== swapPressureConfirmed) {
      swapPressureConfirmed = confirmed;
      logInfo("system-health-swap-pressure", {
        state: confirmed ? "confirmed" : "cleared",
        kernelPressureLevel,
        swapUsedPercent: swapUsedPercent === null ? null : Math.round(swapUsedPercent),
        swapUsedMb: swap === null ? null : Math.round(swap.usedMb),
      });
    }
    deps.onSwapPressure?.(confirmed);
  }

  /** The payload this sample publishes, if any; the caller attaches workloads. */
  function record(
    sample: SystemMemorySample,
    startedAt: number
  ): Omit<SystemMemoryPressurePayload, "workloads"> | null {
    const { swap, fseventsdRssMb, kernelPressureLevel } = sample;
    const swapUsedPercent =
      swap === null ? null : swap.totalMb > 0 ? (swap.usedMb / swap.totalMb) * 100 : 0;
    const swapOver = swapUsedPercent !== null && swapUsedPercent > SWAP_USED_PERCENT_THRESHOLD;
    const fseventsdOver = fseventsdRssMb !== null && fseventsdRssMb > FSEVENTSD_RSS_THRESHOLD_MB;
    const kernelOver = kernelPressureLevel !== null && kernelPressureLevel >= KERNEL_PRESSURE_WARN;
    recordSwapPressureSample(sample, swapUsedPercent, startedAt);
    if (deps.onWatchdogPressure) {
      const heavySwap =
        swapOver && swap !== null && (!deps.isDarwin || swap.usedMb >= SWAP_PRESSURE_MIN_USED_MB);
      const observedAll = swap !== null && (!deps.isDarwin || kernelPressureLevel !== null);
      deps.onWatchdogPressure(
        kernelOver || heavySwap ? true : observedAll ? false : null,
        startedAt
      );
    }
    const figures = {
      swapUsedPercent: swapUsedPercent === null ? null : Math.round(swapUsedPercent),
      swapUsedMb: swap === null ? null : Math.round(swap.usedMb),
      swapTotalMb: swap === null ? null : Math.round(swap.totalMb),
      swapKind: deps.swapKind,
      fseventsdRssMb: fseventsdRssMb === null ? null : Math.round(fseventsdRssMb),
      kernelPressureLevel,
    };

    if (swapOver || fseventsdOver || kernelOver) {
      overStreak++;
      clearStreak = 0;
      elevated = true;
      const episodeOpening = !episodeOpen && overStreak >= EPISODE_OPEN_SAMPLES;
      // Figures are left out: they move on every reading.
      const observed: OverCauses = {
        swapOver: swap === null ? null : swapOver,
        fseventsdOver: fseventsdRssMb === null ? null : fseventsdOver,
        kernelPressureLevel,
      };
      const causeChanged = seenCauses === null || overCausesChanged(seenCauses, observed);
      seenCauses = mergeOverCauses(seenCauses, observed);
      if (episodeOpening || causeChanged) {
        logWarn("system-health", { state: "over", ...figures, consecutiveSamples: overStreak });
      }
      // Sampling is at least a minute apart and the episode is already
      // confirmed, so a worse reading publishes at once.
      const escalating =
        publishedCauses !== null &&
        ((swapOver && !publishedCauses.swapOver) ||
          (fseventsdOver && !publishedCauses.fseventsdOver) ||
          (kernelPressureLevel !== null &&
            kernelPressureLevel > (publishedCauses.kernelPressureLevel ?? 1)));
      if (!episodeOpening && !escalating) return null;
      if (escalating) logWarn("system-health", { state: "escalated", ...figures });
      episodeOpen = true;
      const publishedLevel = publishedCauses?.kernelPressureLevel ?? null;
      publishedCauses = {
        swapOver: swapOver || (publishedCauses?.swapOver ?? false),
        fseventsdOver: fseventsdOver || (publishedCauses?.fseventsdOver ?? false),
        kernelPressureLevel:
          kernelPressureLevel !== null && kernelPressureLevel > (publishedLevel ?? 1)
            ? kernelPressureLevel
            : publishedLevel,
      };
      return {
        status: "degraded",
        swapUsedPercent: swapOver ? figures.swapUsedPercent : null,
        swapKind: deps.swapKind,
        fseventsdRssMb: fseventsdOver ? figures.fseventsdRssMb : null,
        kernelPressureLevel: describeKernelPressureLevel(kernelPressureLevel),
        escalated: escalating,
      };
    }

    const fullyObserved =
      swap !== null &&
      (!deps.isDarwin || (fseventsdRssMb !== null && kernelPressureLevel !== null));
    if (!fullyObserved) {
      // Breaks both runs: "consecutive" means consecutive observations. An
      // open episode stays open — only observed clear samples close it.
      overStreak = 0;
      clearStreak = 0;
      logDebug("system-health-sample-incomplete", figures);
      return null;
    }

    overStreak = 0;
    clearStreak++;
    if (!elevated || clearStreak < EPISODE_CLEAR_SAMPLES) return null;

    logInfo("system-health", { state: "recovered", ...figures });
    const wasOpen = episodeOpen;
    elevated = false;
    episodeOpen = false;
    clearStreak = 0;
    seenCauses = null;
    publishedCauses = null;
    if (!wasOpen) return null;
    return {
      status: "normal",
      swapUsedPercent: null,
      swapKind: deps.swapKind,
      fseventsdRssMb: null,
      kernelPressureLevel: null,
      escalated: false,
    };
  }

  async function readWorkloads(): Promise<SystemMemoryWorkloads | null> {
    const read = deps.readWorkloads;
    if (!read) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(read),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), WORKLOADS_READ_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function takeSample(): Promise<void> {
    const startedAt = wallNow();
    const [swap, fseventsdRssMb, kernelPressureLevel] = await Promise.all([
      deps.readSwap().catch(() => null),
      deps.isDarwin ? deps.readFseventsdRssMb().catch(() => null) : Promise.resolve(null),
      deps.isDarwin ? deps.readKernelPressureLevel().catch(() => null) : Promise.resolve(null),
    ]);
    deps.onKernelPressureLevel?.(kernelPressureLevel);
    const payload = record({ swap, fseventsdRssMb, kernelPressureLevel }, startedAt);
    if (!payload) return;
    // Samples are serialised, so a recovery can never overtake this read.
    const workloads = payload.status === "degraded" ? await readWorkloads() : null;
    deps.publish({ ...payload, workloads });
  }

  return {
    sample: () => {
      if (inFlight) return inFlight;
      const t = now();
      if (t - lastSampleAt < SAMPLE_INTERVAL_MS) return Promise.resolve();
      lastSampleAt = t;
      const pending = takeSample()
        .catch((err: unknown) => {
          logWarn("system-health-sample-failed", { error: String(err) });
        })
        .finally(() => {
          inFlight = null;
        });
      inFlight = pending;
      return pending;
    },
  };
}

function execText(file: string, args: string[], maxBuffer: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer,
        windowsHide: true,
        // sysctl formats swap with the user's LC_NUMERIC (`2048,00M` under
        // de_DE), which the parser would reject as malformed.
        env: { ...process.env, LC_ALL: "C" },
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      }
    );
  });
}

/**
 * Reads the kernel's own memory-pressure level (#12799). Darwin only; the
 * sysctl is world-readable and needs no entitlement. Rejects on a failed
 * spawn, which callers treat as no reading.
 */
export async function readDarwinKernelPressureLevel(): Promise<KernelPressureLevel | null> {
  return parseKernelPressureLevel(
    await execText(
      "/usr/sbin/sysctl",
      ["-n", "kern.memorystatus_vm_pressure_level"],
      SYSCTL_MAX_BUFFER
    )
  );
}

/**
 * Longest a kernel reading answers {@link checkKernelPressureCritical} before
 * it probes again. A recipe or a session restore asks once per agent in a
 * burst; one sysctl covers all of them.
 */
export const KERNEL_PRESSURE_PROBE_CACHE_MS = 3_000;

let kernelProbeInFlight: Promise<boolean> | null = null;

/**
 * Whether the kernel reports critical memory pressure now (#13530), read live
 * rather than from the monitor's last sample, which can be minutes old. A
 * failed probe leaves the verdict as it was. Always false off Darwin, where
 * there is no kernel level to read. Never rejects.
 */
export function checkKernelPressureCritical(
  probe: {
    readLevel?: () => Promise<KernelPressureLevel | null>;
    isDarwin?: boolean;
    now?: () => number;
  } = {}
): Promise<boolean> {
  const {
    readLevel = readDarwinKernelPressureLevel,
    isDarwin = process.platform === "darwin",
    now = Date.now,
  } = probe;
  if (!isDarwin) return Promise.resolve(false);
  const lastReadingAt = getLastKernelPressureReadingAt();
  const ageMs = lastReadingAt === null ? null : now() - lastReadingAt;
  if (ageMs !== null && ageMs >= 0 && ageMs < KERNEL_PRESSURE_PROBE_CACHE_MS) {
    return Promise.resolve(isKernelPressureCritical(now()));
  }
  if (kernelProbeInFlight) return kernelProbeInFlight;
  const pending = readLevel()
    .catch(() => null)
    .then((level) => {
      recordKernelPressureLevel(level, now());
      return isKernelPressureCritical(now());
    })
    .finally(() => {
      kernelProbeInFlight = null;
    });
  kernelProbeInFlight = pending;
  return pending;
}

/**
 * The heaviest projects' terminal trees and Daintree's own processes, from the
 * composite snapshot. Figures only: a slice that failed is left out rather
 * than reported as zero, and a stale terminal sweep is left out too, since it
 * could name a project whose terminals have since closed.
 */
export function summarizeSystemMemoryWorkloads(
  snapshot: CompositeMemorySnapshot,
  resolveProjectName: (projectId: string) => string | null
): SystemMemoryWorkloads | null {
  const appMemoryMb = snapshot.electron.available ? snapshot.electron.totalWorkingSetMb : null;
  const terminals = snapshot.terminalWorkloads;
  const projects =
    terminals.available && !terminals.stale
      ? terminals.byProject
          .filter((p) => p.memoryMb > 0)
          .sort((a, b) => b.memoryMb - a.memoryMb)
          .slice(0, MAX_PUBLISHED_WORKLOADS)
          .map((p) => ({
            projectId: p.projectId,
            projectName: p.projectId === null ? null : resolveProjectName(p.projectId),
            terminalCount: p.terminalCount,
            memoryMb: p.memoryMb,
          }))
      : [];
  if (appMemoryMb === null && projects.length === 0) return null;
  return { appMemoryMb, projects };
}

/**
 * The production probes. Windows and Linux read swap from the Electron memory
 * call the other memory monitors already make, so they spawn nothing; Darwin
 * has no swap figure there and spawns `sysctl` plus a narrow `ps` per sample.
 * The pty-host's process census is not reused because it lives in another
 * process and runs only while terminals do.
 */
export function createDefaultSystemMemoryPressureMonitor(
  publish: SystemMemoryPressureMonitorDeps["publish"],
  readWorkloads?: SystemMemoryPressureMonitorDeps["readWorkloads"]
): SystemMemoryPressureMonitor {
  const isDarwin = process.platform === "darwin";
  return createSystemMemoryPressureMonitor({
    isDarwin,
    swapKind: process.platform === "win32" ? "commit" : "swap",
    readSwap: isDarwin
      ? async () =>
          parseDarwinSwapUsage(
            await execText("/usr/sbin/sysctl", ["-n", "vm.swapusage"], SYSCTL_MAX_BUFFER)
          )
      : async () => readElectronSwapUsage(),
    readFseventsdRssMb: async () =>
      parseFseventsdRssMb(await execText("/bin/ps", ["-axo", "rss=,ucomm="], PS_MAX_BUFFER)),
    readKernelPressureLevel: readDarwinKernelPressureLevel,
    publish,
    readWorkloads,
    onSwapPressure: (confirmed) => recordSwapPressure(confirmed),
    onKernelPressureLevel: (level) => recordKernelPressureLevel(level),
    onWatchdogPressure: (elevated, sampledAt) => recordWatchdogMemoryPressure(elevated, sampledAt),
  });
}
