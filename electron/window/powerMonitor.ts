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
  powerPolicyPollMultiplier,
  type PowerObservations,
  type PowerPolicySnapshot,
} from "../../shared/types/powerPolicy.js";
import { setPollThrottle } from "./focusThrottleState.js";
import { getPowerPolicy, subscribePowerPolicy, updatePowerObservations } from "./powerPolicy.js";
import { publishPowerPolicy } from "./powerPolicyDelivery.js";

let resumeTimeout: NodeJS.Timeout | null = null;
// One workspace refresh per wake, whichever of resume, unlock or focus lands
// first. While the delayed resume handler has yet to decide, it owns the
// refresh; if it finds nobody watching, the refresh is owed to whoever comes
// back rather than run into a locked screen and then again on unlock.
let wakeRecoveryPending = false;
let wakeRefreshOwed = false;
// Bumped by every suspend and resume. A recovery handler still awaiting the
// workspace host when the machine sleeps again, or wakes again, is superseded:
// it must not re-enable polling, refresh, or touch the flags above.
let wakeGeneration = 0;

export function clearResumeTimeout(): void {
  if (resumeTimeout) {
    clearTimeout(resumeTimeout);
    resumeTimeout = null;
  }
  wakeRecoveryPending = false;
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

  try {
    updatePowerObservations({ onBattery: powerMonitor.isOnBatteryPower() });
  } catch {
    // Unknown power source reads as AC — Linux commonly reports that anyway.
  }
  powerMonitor.on("on-battery", () => updatePowerObservations({ onBattery: true }));
  powerMonitor.on("on-ac", () => updatePowerObservations({ onBattery: false }));
  // macOS and Windows only; Linux sessions usually never fire these, which is
  // why hidden/minimized windows reach `deep` on their own. A locked screen
  // fires no window blur, so without this a frontmost Daintree keeps polling
  // at the foreground rate all night. Unlock re-reads the windows too — focus
  // may have moved while the screen was locked.
  powerMonitor.on("lock-screen", () => updatePowerObservations({ screenLocked: true }));
  powerMonitor.on("unlock-screen", () => {
    // One update, so a stale pre-lock focus reading never flashes `active`.
    updatePowerObservations({ screenLocked: false, ...readWindowObservations() });
  });

  powerMonitor.on("suspend", () => {
    clearResumeTimeout();
    wakeGeneration += 1;
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
    wakeRecoveryPending = true;
    const generation = ++wakeGeneration;
    const superseded = () => generation !== wakeGeneration;
    resumeTimeout = setTimeout(async () => {
      resumeTimeout = null;
      let refreshDecided = false;
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
          if (superseded()) return;
          // Only re-enable polling and refresh if someone can see a window. If
          // the app is still blurred or the screen is still locked (the usual
          // state right after a laptop wakes), leave polling paused and owe the
          // refresh — the power policy pays it once when the user comes back.
          evaluateWindowObservations();
          const observable = getPowerPolicy().canObserve;
          wakeRecoveryPending = false;
          refreshDecided = true;
          if (observable) {
            workspaceClient.setPollingEnabled(true);
          }
          workspaceClient.resumeHealthCheck();
          if (observable) {
            wakeRefreshOwed = false;
            await workspaceClient.refreshOnWake();
            if (superseded()) return;
          } else {
            wakeRefreshOwed = true;
          }
        }
        // Force an immediate token-health probe on wake — a credential that
        // expired during a long laptop sleep would otherwise sit undetected
        // until the provider's next scheduled probe.
        refreshForgeTokenHealth({ force: true });
      } catch (error) {
        console.error("[MAIN] Error during resume:", error);
        // Recovery failed before deciding: keep the refresh owed rather than
        // dropping it along with any focus that returned meanwhile.
        if (!refreshDecided && !superseded()) wakeRefreshOwed = true;
      } finally {
        if (!superseded()) wakeRecoveryPending = false;
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
let unsubscribePowerPolicy: (() => void) | null = null;
const trackedWindows = new Set<BrowserWindow>();
// What applyPollingPolicy last pushed. Starts at the unthrottled state every
// poller boots in, so the first transition is always a real change.
const appliedPolling = { multiplier: 1, canObserve: true };

/**
 * Polling baselines derive from the live resource profile, not hardcoded
 * balanced constants. The unthrottle path runs on every focus return;
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

/**
 * The single place main's optional pollers are re-timed for the power policy.
 * Every cadence is `profile baseline × multiplier`; workspace polling and PR
 * cadence additionally stop while nobody can see a window. Returning to an
 * observable state refreshes each poller once — the current state, never a
 * replay of the ticks skipped while throttled.
 */
function applyPollingPolicy(snapshot: PowerPolicySnapshot): void {
  if (!focusThrottleDeps) return;
  const multiplier = powerPolicyPollMultiplier(snapshot);
  const { canObserve } = snapshot;
  if (multiplier === appliedPolling.multiplier && canObserve === appliedPolling.canObserve) {
    return;
  }
  const observabilityChanged = canObserve !== appliedPolling.canObserve;
  const regainedObserver = observabilityChanged && canObserve;
  appliedPolling.multiplier = multiplier;
  appliedPolling.canObserve = canObserve;
  setPollThrottle({ throttled: !canObserve, multiplier });

  const baseline = profilePollingBaseline();

  const workspaceClient = focusThrottleDeps.getWorkspaceClient();
  if (workspaceClient) {
    workspaceClient.updateMonitorConfig({
      pollIntervalActive: baseline.workspaceActive * multiplier,
      pollIntervalBackground: baseline.workspaceBackground * multiplier,
    });
    if (observabilityChanged) {
      workspaceClient.setPollingEnabled(canObserve);
      workspaceClient.setPRPollCadence(canObserve);
    }
    // A pending wake recovery refreshes on its own, settling any refresh an
    // earlier wake left owed; otherwise pay that debt, or refresh plainly.
    if (regainedObserver && !wakeRecoveryPending) {
      if (wakeRefreshOwed) {
        wakeRefreshOwed = false;
        void workspaceClient.refreshOnWake();
      } else {
        void workspaceClient.refresh();
      }
    }
  }

  for (const poller of terminalPollers()) {
    poller.updatePollInterval(baseline.stats * multiplier);
    if (regainedObserver) poller.refresh();
  }

  const ptyClient = focusThrottleDeps.getPtyClient();
  if (ptyClient) {
    ptyClient.setProcessTreePollInterval(baseline.processTree * multiplier);
  }

  setDiskSpaceMonitorPollInterval(DISK_SPACE_NORMAL * multiplier);
  setAppMetricsMonitorPollInterval(APP_METRICS_NORMAL * multiplier);
  if (regainedObserver) {
    refreshDiskSpaceMonitor();
    refreshAppMetricsMonitor();
  }

  const idleTerminalService = focusThrottleDeps.getIdleTerminalNotificationService?.() ?? null;
  if (idleTerminalService) {
    idleTerminalService.updatePollInterval(IDLE_TERMINAL_NORMAL * multiplier);
  }

  if (regainedObserver) {
    // Opportunistic token-health re-check when the user comes back, gated by
    // each provider's own cooldown so rapid window switching doesn't hammer APIs.
    refreshForgeTokenHealth();
  }
}

function isWindowVisible(win: BrowserWindow): boolean {
  try {
    if (win.isDestroyed()) return false;
    return win.isVisible() && !win.isMinimized();
  } catch {
    return false;
  }
}

/**
 * Re-read focus and visibility from the windows themselves rather than
 * inferring them from whichever event fired: `showInactive()` fires `show`
 * with no `focus`, `restore` arrives before focus does, and a locked screen
 * fires no blur at all.
 */
function readWindowObservations(): Pick<
  PowerObservations,
  "anyWindowFocused" | "anyWindowVisible"
> {
  let anyWindowVisible = false;
  for (const win of trackedWindows) {
    if (isWindowVisible(win)) {
      anyWindowVisible = true;
      break;
    }
  }
  return { anyWindowFocused: BrowserWindow.getFocusedWindow() !== null, anyWindowVisible };
}

function evaluateWindowObservations(): void {
  updatePowerObservations(readWindowObservations());
}

function clearBlurTimeout(): void {
  if (focusThrottleState.blurTimeout) {
    clearTimeout(focusThrottleState.blurTimeout);
    focusThrottleState.blurTimeout = null;
  }
}

export function setupWindowFocusThrottle(deps: WindowFocusThrottleDeps): void {
  focusThrottleDeps = deps;

  unsubscribePowerPolicy?.();
  unsubscribePowerPolicy = subscribePowerPolicy((next, previous) => {
    applyPollingPolicy(next);
    if (next.level !== previous.level) {
      focusThrottleDeps?.getPtyClient()?.setPowerPolicy(next.level);
    }
    publishPowerPolicy(next);
  });
  // Observations recorded before this point (battery at launch) still apply —
  // to main's pollers, and to a pty host or view that already came up assuming
  // `active`.
  const current = getPowerPolicy();
  applyPollingPolicy(current);
  if (current.level !== "active") {
    deps.getPtyClient()?.setPowerPolicy(current.level);
    publishPowerPolicy(current);
  }

  app.on("browser-window-blur", () => {
    clearBlurTimeout();
    focusThrottleState.blurTimeout = setTimeout(() => {
      focusThrottleState.blurTimeout = null;
      evaluateWindowObservations();
    }, BLUR_DEBOUNCE_MS);
  });

  // The focus event is itself the observation: a window that just took focus
  // is on screen. Reading getFocusedWindow() here could lag the event, and a
  // window can focus before it is registered (a macOS reopen shows the window
  // during setup), either of which would strand the policy throttled.
  app.on("browser-window-focus", () => {
    clearBlurTimeout();
    updatePowerObservations({ anyWindowFocused: true, anyWindowVisible: true });
  });
}

export function registerWindowForFocusThrottle(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  trackedWindows.add(win);
  const evaluate = () => evaluateWindowObservations();
  win.on("minimize", evaluate);
  win.on("restore", evaluate);
  win.on("hide", evaluate);
  win.on("show", evaluate);
  win.on("closed", () => {
    trackedWindows.delete(win);
    evaluateWindowObservations();
  });
  // Registration runs after async window setup, by which point the window may
  // already be showing — reconcile, or a policy that went deep when the last
  // window closed would sit there until the next window event. A window not
  // yet shown is left to its own `show` event.
  if (isWindowVisible(win)) evaluateWindowObservations();
}
