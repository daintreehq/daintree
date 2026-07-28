import os from "node:os";
import { getIsE2EFaultMode } from "../setup/runtimeFlags.js";

const CRITICAL_FRACTION = 0.1;
const WARNING_FRACTION = 0.2;
const CRITICAL_MAX_MB = 1024;
const WARNING_MAX_MB = 2048;

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

export function getSystemMemoryThresholds(totalMb: number): SystemMemoryThresholds {
  return {
    criticalMb: Math.min(totalMb * CRITICAL_FRACTION, CRITICAL_MAX_MB),
    warningMb: Math.min(totalMb * WARNING_FRACTION, WARNING_MAX_MB),
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
