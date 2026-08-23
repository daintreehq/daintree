import os from "node:os";
import { getIsE2EFaultMode } from "../setup/runtimeFlags.js";

const CRITICAL_FRACTION = 0.1;
const WARNING_FRACTION = 0.2;
const CRITICAL_MAX_MB = 1024;

/** Floor substituted for any total at or below it — non-finite, non-positive,
 *  or merely absurd — so the band stays finite, positive and strictly ordered
 *  rather than propagating NaN into a pushed policy. The resulting edges
 *  (0.1 / 0.2 MB) sit below any reading a live machine can produce, so a
 *  malformed total fails open exactly as the NaN did. */
const MIN_TOTAL_MB = 1;

/** RAM above which CRITICAL_MAX_MB wins over CRITICAL_FRACTION — the point the
 *  band stops scaling with the machine and, before #11926, stopped moving at
 *  all. Derived rather than written out so the two can never drift apart. */
const BAND_KNEE_MB = CRITICAL_MAX_MB / CRITICAL_FRACTION;

/** RAM at which the band reaches BAND_MAX_MB and stops widening. */
const BAND_SATURATION_MB = 42 * 1024;

/** Widest the band gets, at BAND_SATURATION_MB and above.
 *
 *  Sized to what reclaim can actually hand back, not to the machine. The ladder
 *  in `memoryPressureTarget` sheds one cached renderer per equal slice of the
 *  band, so the band's natural unit is the cost of one renderer — ~100–500 MB
 *  (see computeDefaultCachedViews). At the top RAM tier the default cap is 5,
 *  i.e. 4 rungs, so 2048 MB puts ~512 MB on each: the upper end of that range,
 *  which is the conservative choice for a threshold that decides when to START
 *  giving memory back. */
const BAND_MAX_MB = 2 * CRITICAL_MAX_MB;

export interface SystemMemorySnapshot {
  totalMb: number;
  freeMb: number;
  purgeableMb: number;
  availableMb: number;
}

export interface SystemMemoryThresholds {
  criticalMb: number;
  warningMb: number;
}

/**
 * Available-memory band governing cached-view reclaim, the profile's system
 * memory signal, and ProcessMemoryMonitor's system-pressure flag.
 *
 * The two edges answer different questions, so #11926 moves only one of them.
 *
 * `criticalMb` is the emergency edge: crossing it makes tier-2 escalation
 * eligible (a forced one-pass collapse of every cached view in every window),
 * scores `+3` on the profile — enough to latch efficiency alone — and lets a
 * contemporaneous renderer `crashed`/`killed` be classified as probable OOM.
 * It is capped flat above the knee and stays that way. `availableMb` is
 * `free + purgeable`, which on Darwin omits `fileBacked` — the file cache, and
 * the bulk of what the OS would actually reclaim first. A large-RAM machine
 * therefore reports a far smaller "available" figure than it has headroom for,
 * and raising this edge against that scale would manufacture emergencies on
 * healthy machines. That measurement is the real ceiling on how far the band
 * can move and is worth fixing on its own; it is not this change.
 *
 * `warningMb` is the proactive edge: crossing it starts the graduated ladder,
 * which sheds at most one renderer per 30s sample per window and restores the
 * user's cap by itself as soon as memory recovers. Flat-capping THIS edge is
 * what left reclaim as an emergency-only path on large machines (#11926), so
 * above the knee it keeps widening — slowly, and to a bound — while the
 * fraction still governs every machine at or below the knee, unchanged.
 *
 * Continuous at the knee, monotonic non-decreasing in `totalMb`, and
 * `warningMb > criticalMb` for every input: the ladder degenerates to the
 * pre-#11469 cliff if the edges ever meet.
 */
export function getSystemMemoryThresholds(totalMb: number): SystemMemoryThresholds {
  const total = Number.isFinite(totalMb) && totalMb > MIN_TOTAL_MB ? totalMb : MIN_TOTAL_MB;
  const criticalMb = Math.min(total * CRITICAL_FRACTION, CRITICAL_MAX_MB);
  // Below the knee the band equals criticalMb, so `criticalMb + bandMb` is
  // exactly the warning fraction and the Math.min below is a no-op — that is
  // what keeps small machines bit-identical to the pre-#11926 behavior.
  const widenedBy =
    total <= BAND_KNEE_MB
      ? 0
      : ((Math.min(total, BAND_SATURATION_MB) - BAND_KNEE_MB) /
          (BAND_SATURATION_MB - BAND_KNEE_MB)) *
        (BAND_MAX_MB - CRITICAL_MAX_MB);
  const bandMb = criticalMb + widenedBy;
  return {
    criticalMb,
    warningMb: Math.min(total * WARNING_FRACTION, criticalMb + bandMb),
  };
}

export function readSystemMemorySnapshot(): SystemMemorySnapshot | null {
  const totalMb = os.totalmem() / 1024 / 1024;
  if (!Number.isFinite(totalMb) || totalMb <= 0) return null;

  if (getIsE2EFaultMode()) {
    const availableMb = Number(process.env.DAINTREE_E2E_SYSTEM_AVAILABLE_MEMORY_MB);
    if (Number.isFinite(availableMb) && availableMb > 0) {
      return { totalMb, freeMb: availableMb, purgeableMb: 0, availableMb };
    }
  }

  try {
    const getInfo = (
      process as {
        getSystemMemoryInfo?: () => { free: number; purgeable?: number; total: number };
      }
    ).getSystemMemoryInfo;
    if (typeof getInfo !== "function") return null;
    const info = getInfo.call(process);
    // Reject a missing or malformed `free` outright rather than coercing it to
    // 0: a negative reading paired with a plausible `purgeable` would otherwise
    // sum back into a healthy-looking figure.
    if (typeof info.free !== "number" || !Number.isFinite(info.free) || info.free < 0) return null;
    const freeMb = info.free / 1024;
    const purgeableMb =
      typeof info.purgeable === "number" && Number.isFinite(info.purgeable) && info.purgeable > 0
        ? info.purgeable / 1024
        : 0;
    const availableMb = freeMb + purgeableMb;
    // A zero total is treated as an API artifact, not a maximally-critical
    // reading: a transiently zeroed struct must not collapse every cached view
    // and downgrade the profile. Genuine exhaustion is caught by
    // ProcessMemoryMonitor's own-process RSS tiers.
    if (availableMb <= 0) return null;
    return { totalMb, freeMb, purgeableMb, availableMb };
  } catch {
    return null;
  }
}

export function readAvailableSystemMemoryMb(): number | null {
  return readSystemMemorySnapshot()?.availableMb ?? null;
}
