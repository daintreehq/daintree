import { app, BrowserWindow, powerMonitor } from "electron";
import type { PtyClient } from "../services/PtyClient.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";
import type { MainProcessWatchdogClient } from "../services/MainProcessWatchdogClient.js";
import type { ProjectStatsService } from "../services/ProjectStatsService.js";
import type { FleetSnapshotService } from "../services/FleetSnapshotService.js";
import type { IdleTerminalNotificationService } from "../services/IdleTerminalNotificationService.js";
import { CHANNELS } from "../ipc/channels.js";
import { getAppWebContents } from "./webContentsRegistry.js";
import { getForgeProviderImplEntries } from "../services/forgeProviderRegistry.js";
import { events } from "../services/events.js";
import {
  setDiskSpaceMonitorPollInterval,
  refreshDiskSpaceMonitor,
} from "../services/DiskSpaceMonitor.js";
import {
  setAppMetricsMonitorPollInterval,
  refreshAppMetricsMonitor,
} from "../services/ProcessMemoryMonitor.js";
import { RESOURCE_PROFILE_CONFIGS } from "../../shared/types/resourceProfile.js";
import { getResourceProfileService } from "./serviceRefs.js";
import {
  FOCUS_THROTTLE_MULTIPLIER,
  isFocusThrottled,
  setFocusThrottled,
} from "./focusThrottleState.js";

let resumeTimeout: NodeJS.Timeout | null = null;

export function clearResumeTimeout(): void {
  if (resumeTimeout) {
    clearTimeout(resumeTimeout);
    resumeTimeout = null;
  }
}

/** Fire-and-forget token-health re-probe across every registered forge provider. */
function refreshForgeTokenHealth(options?: { force?: boolean }): void {
  for (const [, impl] of getForgeProviderImplEntries()) {
    try {
      void impl.healthEvents?.refreshTokenHealth?.(options);
    } catch {
      // A throwing provider must not break resume/focus handling.
    }
  }
}

/**
 * Announce one completed wake to every renderer window and to the internal
 * bus, with a single shared timestamp so no two consumers disagree about when
 * the machine came back.
 */
function publishWake(sleepDuration: number): void {
  const timestamp = Date.now();
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win || win.isDestroyed()) continue;
      const wc = getAppWebContents(win);
      if (wc.isDestroyed()) continue;
      wc.send(CHANNELS.EVENTS_PUSH, {
        name: "system:wake",
        payload: { sleepDuration, timestamp },
      });
    } catch {
      // A window tearing down mid-broadcast must not cost the others theirs —
      // the whole lookup is guarded, not just the send.
    }
  }
  // Same wake, same numbers, on the internal bus — this is what reaches
  // main-process listeners the renderer push cannot serve, plugins via
  // `host.onDidWake` above all (#12175). Emitted after the renderer fan-out so
  // a throwing bus subscriber cannot cost a window its push. A throw still
  // aborts the remaining bus listeners, which is why every plugin-facing
  // listener contains its own callback rather than relying on this guard.
  try {
    events.emit("sys:wake", { sleepDuration, timestamp });
  } catch (error) {
    console.error("[MAIN] sys:wake listener threw during resume:", error);
  }
}

export interface PowerMonitorDeps {
  getPtyClient: () => PtyClient | null;
  getWorkspaceClient: () => WorkspaceClient | null;
  getMainProcessWatchdogClient?: () => MainProcessWatchdogClient | null;
}

export function setupPowerMonitor(deps: PowerMonitorDeps): void {
  let suspendTime: number | null = null;

  powerMonitor.on("suspend", () => {
    clearResumeTimeout();
    const ptyClient = deps.getPtyClient();
    const workspaceClient = deps.getWorkspaceClient();
    const watchdog = deps.getMainProcessWatchdogClient?.() ?? null;
    if (ptyClient) {
      ptyClient.pauseHealthCheck();
      ptyClient.pauseAll();
    }
    if (workspaceClient) {
      workspaceClient.pauseHealthCheck();
      workspaceClient.setPollingEnabled(false);
    }
    if (watchdog) {
      // Suppresses kill-on-miss across suspend. Without this, a long sleep
      // would accumulate enough missed pings for the watchdog to SIGKILL
      // main on wake — exactly the false-positive we have to avoid.
      watchdog.pause();
    }
    suspendTime = Date.now();
  });

  powerMonitor.on("resume", () => {
    clearResumeTimeout();
    resumeTimeout = setTimeout(async () => {
      resumeTimeout = null;
      // Capture and clear suspendTime up front so a mid-handler exception
      // can't leak it into the next wake cycle's sleepDuration calculation.
      const sleepDuration = suspendTime ? Date.now() - suspendTime : 0;
      suspendTime = null;
      try {
        const ptyClient = deps.getPtyClient();
        const workspaceClient = deps.getWorkspaceClient();
        const watchdog = deps.getMainProcessWatchdogClient?.() ?? null;
        if (watchdog) {
          // Resume before pty/workspace so the watchdog is actively armed
          // by the time the heavier post-wake refresh work begins.
          watchdog.resume();
        }
        if (ptyClient) {
          ptyClient.resumeAll();
          ptyClient.resumeHealthCheck();
        }
        if (workspaceClient) {
          await workspaceClient.waitForReady();
          // Only re-enable polling if a window is focused. If the app is
          // still fully blurred (e.g. user suspended overnight, machine
          // wakes before they return), leave polling paused —
          // removeThrottle() will re-enable it on the next focus event.
          if (BrowserWindow.getFocusedWindow()) {
            workspaceClient.setPollingEnabled(true);
          }
          workspaceClient.resumeHealthCheck();
          await workspaceClient.refreshOnWake();
        }
        // Force an immediate token-health probe on wake — a credential that
        // expired during a long laptop sleep would otherwise sit undetected
        // until the provider's next scheduled probe.
        refreshForgeTokenHealth({ force: true });
      } catch (error) {
        console.error("[MAIN] Error during resume:", error);
      }
      // Announced whether or not the recovery above succeeded. A failed or
      // partial recovery is exactly when a listener most needs to know the
      // machine woke: suppressing the signal there would strand every renderer
      // and every plugin on suspend-era state with nothing to tell them, which
      // is the unbounded staleness this event exists to end (#12175).
      publishWake(sleepDuration);
    }, 2000);
  });
}

// --- Window Focus Throttle ---

const THROTTLE_MULTIPLIER = FOCUS_THROTTLE_MULTIPLIER;
const BLUR_DEBOUNCE_MS = 100;

const DISK_SPACE_NORMAL = 5 * 60 * 1000;
const APP_METRICS_NORMAL = 30_000;
const IDLE_TERMINAL_NORMAL = 5 * 60 * 1000;

export interface WindowFocusThrottleDeps {
  getPtyClient: () => PtyClient | null;
  getWorkspaceClient: () => WorkspaceClient | null;
  getProjectStatsService: () => ProjectStatsService | null;
  getFleetSnapshotService?: () => FleetSnapshotService | null;
  getIdleTerminalNotificationService?: () => IdleTerminalNotificationService | null;
}

/**
 * The services that poll `getAllTerminals*` on the project-stats cadence.
 *
 * Collected rather than throttled individually because they read the same
 * source at the same rate: throttling one and not the other would leave the
 * unthrottled poller fanning out to every shard every 5s while its sibling
 * backed off to 125s, quietly defeating the profile's whole purpose.
 */
function terminalPollers(): Array<{
  updatePollInterval: (ms: number) => void;
  refresh: () => void;
}> {
  if (!focusThrottleDeps) return [];
  const services = [
    focusThrottleDeps.getProjectStatsService(),
    focusThrottleDeps.getFleetSnapshotService?.() ?? null,
  ];
  return services.filter((s): s is NonNullable<typeof s> => s !== null);
}

const focusThrottleState = {
  blurTimeout: null as NodeJS.Timeout | null,
};

let focusThrottleDeps: WindowFocusThrottleDeps | null = null;

/**
 * Polling baselines derive from the live resource profile, not hardcoded
 * balanced constants. removeThrottle() runs on every browser-window-focus;
 * restoring balanced values there would silently revert profile-tuned
 * cadences (e.g. efficiency's slower polling) until the next profile
 * transition — which may never come while the profile is stable.
 */
function profilePollingBaseline() {
  const profile = getResourceProfileService()?.getProfile() ?? "balanced";
  const config = RESOURCE_PROFILE_CONFIGS[profile];
  return {
    workspaceActive: config.pollIntervalActive,
    workspaceBackground: config.pollIntervalBackground,
    stats: config.projectStatsPollInterval,
    processTree: config.processTreePollInterval,
  };
}

function applyThrottle(): void {
  if (isFocusThrottled() || !focusThrottleDeps) return;
  setFocusThrottled(true);

  const baseline = profilePollingBaseline();

  const workspaceClient = focusThrottleDeps.getWorkspaceClient();
  if (workspaceClient) {
    workspaceClient.updateMonitorConfig({
      pollIntervalActive: baseline.workspaceActive * THROTTLE_MULTIPLIER,
      pollIntervalBackground: baseline.workspaceBackground * THROTTLE_MULTIPLIER,
    });
    workspaceClient.setPollingEnabled(false);
    workspaceClient.setPRPollCadence(false);
  }

  for (const poller of terminalPollers()) {
    poller.updatePollInterval(baseline.stats * THROTTLE_MULTIPLIER);
  }

  const ptyClient = focusThrottleDeps.getPtyClient();
  if (ptyClient) {
    ptyClient.setProcessTreePollInterval(baseline.processTree * THROTTLE_MULTIPLIER);
  }

  setDiskSpaceMonitorPollInterval(DISK_SPACE_NORMAL * THROTTLE_MULTIPLIER);
  setAppMetricsMonitorPollInterval(APP_METRICS_NORMAL * THROTTLE_MULTIPLIER);

  const idleTerminalService = focusThrottleDeps.getIdleTerminalNotificationService?.() ?? null;
  if (idleTerminalService) {
    idleTerminalService.updatePollInterval(IDLE_TERMINAL_NORMAL * THROTTLE_MULTIPLIER);
  }
}

function removeThrottle(): void {
  if (!isFocusThrottled() || !focusThrottleDeps) return;
  setFocusThrottled(false);

  const baseline = profilePollingBaseline();

  const workspaceClient = focusThrottleDeps.getWorkspaceClient();
  if (workspaceClient) {
    workspaceClient.updateMonitorConfig({
      pollIntervalActive: baseline.workspaceActive,
      pollIntervalBackground: baseline.workspaceBackground,
    });
    workspaceClient.setPollingEnabled(true);
    workspaceClient.setPRPollCadence(true);
    void workspaceClient.refresh();
  }

  for (const poller of terminalPollers()) {
    poller.updatePollInterval(baseline.stats);
    poller.refresh();
  }

  const ptyClient = focusThrottleDeps.getPtyClient();
  if (ptyClient) {
    ptyClient.setProcessTreePollInterval(baseline.processTree);
  }

  setDiskSpaceMonitorPollInterval(DISK_SPACE_NORMAL);
  setAppMetricsMonitorPollInterval(APP_METRICS_NORMAL);
  refreshDiskSpaceMonitor();
  refreshAppMetricsMonitor();

  const idleTerminalService = focusThrottleDeps.getIdleTerminalNotificationService?.() ?? null;
  if (idleTerminalService) {
    idleTerminalService.updatePollInterval(IDLE_TERMINAL_NORMAL);
  }

  // Opportunistic token-health re-check on focus regain, gated by each
  // provider's own cooldown so rapid window switching doesn't hammer APIs.
  refreshForgeTokenHealth();
}

export function setupWindowFocusThrottle(deps: WindowFocusThrottleDeps): void {
  focusThrottleDeps = deps;

  app.on("browser-window-blur", () => {
    if (focusThrottleState.blurTimeout) {
      clearTimeout(focusThrottleState.blurTimeout);
    }
    focusThrottleState.blurTimeout = setTimeout(() => {
      focusThrottleState.blurTimeout = null;
      if (!BrowserWindow.getFocusedWindow()) {
        applyThrottle();
      }
    }, BLUR_DEBOUNCE_MS);
  });

  app.on("browser-window-focus", () => {
    if (focusThrottleState.blurTimeout) {
      clearTimeout(focusThrottleState.blurTimeout);
      focusThrottleState.blurTimeout = null;
    }
    removeThrottle();
  });
}

export function registerWindowForFocusThrottle(win: BrowserWindow): void {
  win.on("minimize", () => {
    if (!BrowserWindow.getFocusedWindow()) {
      applyThrottle();
    }
  });

  win.on("restore", () => {
    removeThrottle();
  });
}
