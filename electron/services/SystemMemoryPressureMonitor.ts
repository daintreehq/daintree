import { execFile } from "node:child_process";
import { logDebug, logInfo, logWarn } from "../utils/logger.js";
import { readElectronSwapUsage, type SwapUsage } from "../utils/systemMemory.js";
import type { SystemMemoryPressurePayload } from "../../shared/types/ipc/system.js";

/**
 * Floor between samples. Sampling rides the app-metrics poll (30s, stretched
 * to 150s while focus-throttled), so this gates on elapsed time rather than a
 * tick count — on Darwin each sample costs two short process spawns.
 */
export const SAMPLE_INTERVAL_MS = 60_000;
export const SWAP_USED_PERCENT_THRESHOLD = 80;
export const FSEVENTSD_RSS_THRESHOLD_MB = 8 * 1024;
/** Consecutive over-threshold samples that open an episode. */
export const EPISODE_OPEN_SAMPLES = 3;
/**
 * Consecutive fully observed clear samples that close one. Hysteresis: a
 * reading that hovers on a threshold would otherwise reopen the notice every
 * few minutes.
 */
export const EPISODE_CLEAR_SAMPLES = 3;

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
  now?: () => number;
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

/**
 * Observes whether the machine itself is degraded — swap nearly full, or on
 * Darwin an `fseventsd` grown to many gigabytes or the kernel reporting memory
 * pressure (#12799) — so a slow Mac is not read as
 * a slow Daintree (#12462). Numbers only: it never infers a cause.
 *
 * Every over-threshold sample logs a `system-health` record. An episode opens
 * after {@link EPISODE_OPEN_SAMPLES} consecutive ones and is published exactly
 * once; it closes, with one recovery record and one publish, after
 * {@link EPISODE_CLEAR_SAMPLES} consecutive fully observed clear samples. A
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

  function record(sample: SystemMemorySample): void {
    const { swap, fseventsdRssMb, kernelPressureLevel } = sample;
    const swapUsedPercent =
      swap === null ? null : swap.totalMb > 0 ? (swap.usedMb / swap.totalMb) * 100 : 0;
    const swapOver = swapUsedPercent !== null && swapUsedPercent > SWAP_USED_PERCENT_THRESHOLD;
    const fseventsdOver = fseventsdRssMb !== null && fseventsdRssMb > FSEVENTSD_RSS_THRESHOLD_MB;
    const kernelOver = kernelPressureLevel !== null && kernelPressureLevel >= KERNEL_PRESSURE_WARN;
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
      logWarn("system-health", { state: "over", ...figures, consecutiveSamples: overStreak });
      if (!episodeOpen && overStreak >= EPISODE_OPEN_SAMPLES) {
        episodeOpen = true;
        deps.publish({
          status: "degraded",
          swapUsedPercent: swapOver ? figures.swapUsedPercent : null,
          swapKind: deps.swapKind,
          fseventsdRssMb: fseventsdOver ? figures.fseventsdRssMb : null,
          kernelPressureLevel: describeKernelPressureLevel(kernelPressureLevel),
        });
      }
      return;
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
      return;
    }

    overStreak = 0;
    clearStreak++;
    if (!elevated || clearStreak < EPISODE_CLEAR_SAMPLES) return;

    logInfo("system-health", { state: "recovered", ...figures });
    const wasOpen = episodeOpen;
    elevated = false;
    episodeOpen = false;
    clearStreak = 0;
    if (wasOpen) {
      deps.publish({
        status: "normal",
        swapUsedPercent: null,
        swapKind: deps.swapKind,
        fseventsdRssMb: null,
        kernelPressureLevel: null,
      });
    }
  }

  async function takeSample(): Promise<void> {
    const [swap, fseventsdRssMb, kernelPressureLevel] = await Promise.all([
      deps.readSwap().catch(() => null),
      deps.isDarwin ? deps.readFseventsdRssMb().catch(() => null) : Promise.resolve(null),
      deps.isDarwin ? deps.readKernelPressureLevel().catch(() => null) : Promise.resolve(null),
    ]);
    record({ swap, fseventsdRssMb, kernelPressureLevel });
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
 * The production probes. Windows and Linux read swap from the Electron memory
 * call the other memory monitors already make, so they spawn nothing; Darwin
 * has no swap figure there and spawns `sysctl` plus a narrow `ps` per sample.
 * The pty-host's process census is not reused because it lives in another
 * process and runs only while terminals do.
 */
export function createDefaultSystemMemoryPressureMonitor(
  publish: SystemMemoryPressureMonitorDeps["publish"]
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
  });
}
