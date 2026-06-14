// eager-import-allow: stateless sync-fs reader/writer for the GPU-disabled sentinel
// Kept free of service imports so `electron/setup/environment.ts` can use it
// before its module body runs (userData re-pathing, stdio guards) — importing
// GpuCrashMonitorService there would hoist logger/telemetry/store evaluation
// ahead of `app.setPath("userData", ...)`.
import fs from "node:fs";
import path from "node:path";
import { resilientAtomicWriteFileSync } from "../utils/fs.js";
import type { GpuDisabledReason } from "../../shared/types/ipc/app.js";

export const GPU_DISABLED_FLAG_FILENAME = "gpu-disabled.flag";

/**
 * Sentinel version recorded for legacy timestamp-only flag files. Never equals
 * a real app version, so crash-reason legacy flags always qualify for the
 * version-change auto-retry.
 */
export const LEGACY_GPU_FLAG_VERSION = "0.0.0";

export interface GpuDisabledFlagData {
  reason: GpuDisabledReason;
  /** App version that wrote the flag (`LEGACY_GPU_FLAG_VERSION` for legacy files). */
  version: string;
  /** Epoch ms when the flag was written; 0 when unrecoverable from a legacy file. */
  timestamp: number;
}

/**
 * Parses flag-file content. Structured JSON (`{reason, version, timestamp}`)
 * is read field-by-field with safe fallbacks; anything else — including the
 * legacy bare-timestamp format — maps to a crash-reason legacy record, since
 * pre-reason flags were predominantly crash-written and treating them as
 * crash lets the auto-retry recover those users after the next update.
 */
export function parseGpuDisabledFlag(raw: string): GpuDisabledFlagData {
  const trimmed = raw.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && "reason" in parsed) {
      const candidate = parsed as { reason?: unknown; version?: unknown; timestamp?: unknown };
      return {
        reason: candidate.reason === "user" ? "user" : "crash",
        version:
          typeof candidate.version === "string" ? candidate.version : LEGACY_GPU_FLAG_VERSION,
        timestamp: typeof candidate.timestamp === "number" ? candidate.timestamp : 0,
      };
    }
  } catch {
    // Not JSON — fall through to the legacy bare-timestamp path.
  }
  const timestamp = Number.parseInt(trimmed, 10);
  return {
    reason: "crash",
    version: LEGACY_GPU_FLAG_VERSION,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
  };
}

/** Stateless read of the flag file; null when absent or unreadable. */
export function readGpuDisabledFlagData(userDataPath: string): GpuDisabledFlagData | null {
  let raw: unknown;
  try {
    raw = fs.readFileSync(path.join(userDataPath, GPU_DISABLED_FLAG_FILENAME), "utf8");
  } catch {
    return null;
  }
  // Real fs with an encoding always returns a string; partially-mocked fs in
  // tests can return undefined. Treat any non-string result as an absent flag
  // — matching how the pre-reason `existsSync` check tolerated those mocks.
  if (typeof raw !== "string") return null;
  return parseGpuDisabledFlag(raw);
}

export function writeGpuDisabledFlagFile(userDataPath: string, data: GpuDisabledFlagData): void {
  resilientAtomicWriteFileSync(
    path.join(userDataPath, GPU_DISABLED_FLAG_FILENAME),
    JSON.stringify(data),
    "utf8"
  );
}

/**
 * Crash-written flags are retried once per app version: if the GPU crashes
 * were caused by an Electron or driver bug, the fix would otherwise never
 * reach affected users because the flag outlives the update. User-written
 * flags are a deliberate choice and never auto-retried.
 */
export function shouldRetryGpuAfterUpdate(
  data: GpuDisabledFlagData | null,
  currentVersion: string
): boolean {
  return data !== null && data.reason === "crash" && data.version !== currentVersion;
}
