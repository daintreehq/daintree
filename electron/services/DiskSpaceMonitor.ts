import { promises as fs } from "node:fs";
import { app } from "electron";
import { logDebug, logInfo, logWarn } from "../utils/logger.js";
import { setAlignedInterval } from "../utils/setAlignedInterval.js";
import { setWritesSuppressed } from "./diskPressureState.js";
import { getSystemSleepService } from "./SystemSleepService.js";

export type DiskSpaceStatus = "normal" | "warning" | "critical";

export interface DiskSpacePayload {
  status: DiskSpaceStatus;
  availableMb: number;
  writesSuppressed: boolean;
}

export interface DiskSpaceMonitorActions {
  sendStatus: (payload: DiskSpacePayload) => void;
  onCriticalChange: (isCritical: boolean) => void;
  showNativeNotification: (title: string, body: string) => void;
  isWindowFocused: () => boolean;
}

const WARNING_MB = 2000;
const WARNING_EXIT_MB = WARNING_MB + 50;
const CRITICAL_MB = 500;
const CRITICAL_EXIT_MB = CRITICAL_MB + 50;
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const NOTIFICATION_COOLDOWN_MS = 30 * 60 * 1000;

let currentStatus: DiskSpacePayload = {
  status: "normal",
  availableMb: Infinity,
  writesSuppressed: false,
};

export function getCurrentDiskSpaceStatus(): DiskSpacePayload {
  return currentStatus;
}

let currentDiskSpacePollIntervalMs = POLL_INTERVAL_MS;
let rearmDiskSpaceTimer: (() => void) | null = null;
let diskSpacePollFn: (() => Promise<boolean>) | null = null;

export function setDiskSpaceMonitorPollInterval(ms: number): void {
  if (ms === currentDiskSpacePollIntervalMs) return;
  currentDiskSpacePollIntervalMs = ms;
  rearmDiskSpaceTimer?.();
}

export function refreshDiskSpaceMonitor(): void {
  void diskSpacePollFn?.();
}

/**
 * Reads free space now and resolves with what that read saw, once the flag
 * and every callback it caused have been published. A read already under way
 * is the one waited for. Null when no monitor runs or the read failed, so a
 * caller never takes the status from before as a fresh one.
 */
export async function checkDiskSpaceNow(): Promise<DiskSpacePayload | null> {
  const poll = diskSpacePollFn;
  if (!poll) return null;
  const read = await poll().catch(() => false);
  return read ? currentStatus : null;
}

export function startDiskSpaceMonitor(actions: DiskSpaceMonitorActions): () => void {
  let lastStatus: DiskSpaceStatus = "normal";
  let lastNotificationAt = 0;
  let disposed = false;
  let inFlight: Promise<boolean> | null = null;
  let removeSuspendListener: (() => void) | null = null;
  let removeWakeListener: (() => void) | null = null;

  /** One read at a time: a poll asked for while one runs shares it. True once a read was published. */
  function poll(): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    inFlight ??= read().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function read(): Promise<boolean> {
    let availableMb: number;
    try {
      const userDataPath = app.getPath("userData");
      const stats = await fs.statfs(userDataPath, { bigint: true });
      availableMb = Number((stats.bavail * stats.bsize) / (1024n * 1024n));
    } catch (err) {
      logWarn("disk-space-poll-failed", { error: String(err) });
      return false;
    }

    if (disposed) return false;

    let status: DiskSpaceStatus;
    if (availableMb < CRITICAL_MB) {
      status = "critical";
    } else if (availableMb < WARNING_MB) {
      status = "warning";
    } else {
      status = "normal";
    }

    // Schmitt trigger: latch prevents premature upward recovery.
    // Escalation always uses enter thresholds; recovery requires exit thresholds.
    if (lastStatus === "critical" && availableMb <= CRITICAL_EXIT_MB) {
      status = "critical";
    } else if (lastStatus === "warning" && status === "normal" && availableMb <= WARNING_EXIT_MB) {
      status = "warning";
    } else if (lastStatus === "critical" && status === "normal" && availableMb <= WARNING_EXIT_MB) {
      // Post-critical exit: don't skip the warning band.
      status = "warning";
    }

    const writesSuppressed = status === "critical";

    // Publish the flag before any logger call so the very next log line that
    // would hit disk under critical pressure is also dropped.
    currentStatus = { status, availableMb, writesSuppressed };
    setWritesSuppressed(writesSuppressed);

    logDebug("disk-space-check", {
      availableMb: Math.round(availableMb),
      status,
    });

    if (status !== lastStatus) {
      logInfo("disk-space-status-changed", {
        from: lastStatus,
        to: status,
        availableMb: Math.round(availableMb),
      });

      actions.sendStatus(currentStatus);

      if (status === "critical" && lastStatus !== "critical") {
        actions.onCriticalChange(true);
      } else if (status !== "critical" && lastStatus === "critical") {
        actions.onCriticalChange(false);
      }

      if (status === "warning" || status === "critical") {
        const now = Date.now();
        const escalating = status === "critical" && lastStatus !== "critical";
        if (escalating || now - lastNotificationAt >= NOTIFICATION_COOLDOWN_MS) {
          if (!actions.isWindowFocused()) {
            const title =
              status === "critical" ? "Critical: Disk space very low" : "Low disk space warning";
            const body =
              status === "critical"
                ? `Only ${Math.round(availableMb)} MB remaining. Session backups and terminal snapshots have been paused.`
                : `${Math.round(availableMb)} MB remaining on the application data volume. Free disk space to avoid data loss.`;
            actions.showNativeNotification(title, body);
          }
          lastNotificationAt = now;
        }
      }

      lastStatus = status;
    }

    return true;
  }

  diskSpacePollFn = poll;

  let clearAlignedInterval: (() => void) | null = null;
  const armTimer = () => {
    clearAlignedInterval?.();
    clearAlignedInterval = setAlignedInterval(() => {
      void poll();
    }, currentDiskSpacePollIntervalMs);
  };
  rearmDiskSpaceTimer = armTimer;

  void poll();
  armTimer();

  try {
    removeSuspendListener = getSystemSleepService().onSuspend(() => {
      clearAlignedInterval?.();
      clearAlignedInterval = null;
    });
    removeWakeListener = getSystemSleepService().onWake(() => {
      if (disposed || clearAlignedInterval !== null) return;
      void poll();
      armTimer();
    });
  } catch {
    // SystemSleepService may not be initialized yet at early startup.
  }

  return () => {
    disposed = true;
    clearAlignedInterval?.();
    clearAlignedInterval = null;
    diskSpacePollFn = null;
    rearmDiskSpaceTimer = null;
    removeSuspendListener?.();
    removeWakeListener?.();
  };
}
