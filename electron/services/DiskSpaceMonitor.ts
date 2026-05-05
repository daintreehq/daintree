import { promises as fs } from "node:fs";
import { app } from "electron";
import { logDebug, logInfo, logWarn } from "../utils/logger.js";
import { setAlignedInterval } from "../utils/setAlignedInterval.js";
import { setWritesSuppressed } from "./diskPressureState.js";

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
const CRITICAL_MB = 500;
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
let diskSpacePollFn: (() => Promise<void>) | null = null;

export function setDiskSpaceMonitorPollInterval(ms: number): void {
  if (ms === currentDiskSpacePollIntervalMs) return;
  currentDiskSpacePollIntervalMs = ms;
  rearmDiskSpaceTimer?.();
}

export function refreshDiskSpaceMonitor(): void {
  diskSpacePollFn?.();
}

export function startDiskSpaceMonitor(actions: DiskSpaceMonitorActions): () => void {
  let lastStatus: DiskSpaceStatus = "normal";
  let lastNotificationAt = 0;
  let disposed = false;

  async function poll(): Promise<void> {
    if (disposed) return;

    let availableMb: number;
    try {
      const userDataPath = app.getPath("userData");
      const stats = await fs.statfs(userDataPath);
      availableMb = (stats.bavail * stats.bsize) / (1024 * 1024);
    } catch (err) {
      logWarn("disk-space-poll-failed", { error: String(err) });
      return;
    }

    if (disposed) return;

    let status: DiskSpaceStatus;
    if (availableMb < CRITICAL_MB) {
      status = "critical";
    } else if (availableMb < WARNING_MB) {
      status = "warning";
    } else {
      status = "normal";
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

  return () => {
    disposed = true;
    clearAlignedInterval?.();
    clearAlignedInterval = null;
    diskSpacePollFn = null;
    rearmDiskSpaceTimer = null;
  };
}
