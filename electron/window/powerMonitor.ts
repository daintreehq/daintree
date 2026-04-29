import { app, BrowserWindow, powerMonitor } from "electron";
import type { PtyClient } from "../services/PtyClient.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";
import type { ProjectStatsService } from "../services/ProjectStatsService.js";
import { CHANNELS } from "../ipc/channels.js";
import { getAppWebContents } from "./webContentsRegistry.js";
import { gitHubTokenHealthService } from "../services/github/GitHubTokenHealthService.js";
import { agentConnectivityService } from "../services/connectivity/AgentConnectivityService.js";

let resumeTimeout: NodeJS.Timeout | null = null;

export function clearResumeTimeout(): void {
  if (resumeTimeout) {
    clearTimeout(resumeTimeout);
    resumeTimeout = null;
  }
}

export interface PowerMonitorDeps {
  getPtyClient: () => PtyClient | null;
  getWorkspaceClient: () => WorkspaceClient | null;
}

export function setupPowerMonitor(deps: PowerMonitorDeps): void {
  let suspendTime: number | null = null;

  powerMonitor.on("suspend", () => {
    clearResumeTimeout();
    const ptyClient = deps.getPtyClient();
    const workspaceClient = deps.getWorkspaceClient();
    if (ptyClient) {
      ptyClient.pauseHealthCheck();
      ptyClient.pauseAll();
    }
    if (workspaceClient) {
      workspaceClient.pauseHealthCheck();
      workspaceClient.setPollingEnabled(false);
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
        if (ptyClient) {
          ptyClient.resumeAll();
          ptyClient.resumeHealthCheck();
        }
        if (workspaceClient) {
          await workspaceClient.waitForReady();
          workspaceClient.setPollingEnabled(true);
          workspaceClient.resumeHealthCheck();
          await workspaceClient.refreshOnWake();
        }
        // Force an immediate token-health probe on wake — a PAT that expired
        // during a long laptop sleep would otherwise sit undetected until the
        // next 30-minute poll tick.
        void gitHubTokenHealthService.refresh({ force: true });
        // Re-probe agent provider reachability on wake. A long sleep across a
        // network change (Wi-Fi swap, airplane mode toggle) often invalidates
        // the cached "reachable" state.
        void agentConnectivityService.refresh({ force: true, reason: "resume" });
        BrowserWindow.getAllWindows().forEach((win) => {
          if (win && !win.isDestroyed()) {
            const wc = getAppWebContents(win);
            if (!wc.isDestroyed()) {
              try {
                wc.send(CHANNELS.EVENTS_PUSH, {
                  name: "system:wake",
                  payload: {
                    sleepDuration,
                    timestamp: Date.now(),
                  },
                });
              } catch {
                // Silently ignore send failures during window disposal.
              }
            }
          }
        });
      } catch (error) {
        console.error("[MAIN] Error during resume:", error);
      }
    }, 2000);
  });
}

// --- Window Focus Throttle ---

const THROTTLE_MULTIPLIER = 5;
const BLUR_DEBOUNCE_MS = 100;

const WORKSPACE_ACTIVE_NORMAL = 2_000;
const WORKSPACE_BACKGROUND_NORMAL = 10_000;
const STATS_NORMAL = 5_000;
const PROCESS_TREE_NORMAL = 2_500;

export interface WindowFocusThrottleDeps {
  getPtyClient: () => PtyClient | null;
  getWorkspaceClient: () => WorkspaceClient | null;
  getProjectStatsService: () => ProjectStatsService | null;
}

const focusThrottleState = {
  isThrottled: false,
  blurTimeout: null as NodeJS.Timeout | null,
};

let focusThrottleDeps: WindowFocusThrottleDeps | null = null;

function applyThrottle(): void {
  if (focusThrottleState.isThrottled || !focusThrottleDeps) return;
  focusThrottleState.isThrottled = true;

  const workspaceClient = focusThrottleDeps.getWorkspaceClient();
  if (workspaceClient) {
    workspaceClient.updateMonitorConfig({
      pollIntervalActive: WORKSPACE_ACTIVE_NORMAL * THROTTLE_MULTIPLIER,
      pollIntervalBackground: WORKSPACE_BACKGROUND_NORMAL * THROTTLE_MULTIPLIER,
    });
  }

  const statsService = focusThrottleDeps.getProjectStatsService();
  if (statsService) {
    statsService.updatePollInterval(STATS_NORMAL * THROTTLE_MULTIPLIER);
  }

  const ptyClient = focusThrottleDeps.getPtyClient();
  if (ptyClient) {
    ptyClient.setProcessTreePollInterval(PROCESS_TREE_NORMAL * THROTTLE_MULTIPLIER);
  }
}

function removeThrottle(): void {
  if (!focusThrottleState.isThrottled || !focusThrottleDeps) return;
  focusThrottleState.isThrottled = false;

  const workspaceClient = focusThrottleDeps.getWorkspaceClient();
  if (workspaceClient) {
    workspaceClient.updateMonitorConfig({
      pollIntervalActive: WORKSPACE_ACTIVE_NORMAL,
      pollIntervalBackground: WORKSPACE_BACKGROUND_NORMAL,
    });
    void workspaceClient.refresh();
  }

  const statsService = focusThrottleDeps.getProjectStatsService();
  if (statsService) {
    statsService.updatePollInterval(STATS_NORMAL);
    statsService.refresh();
  }

  const ptyClient = focusThrottleDeps.getPtyClient();
  if (ptyClient) {
    ptyClient.setProcessTreePollInterval(PROCESS_TREE_NORMAL);
  }

  // Opportunistic token-health re-check on focus regain, gated by the
  // service's own 5-minute cooldown so rapid window switching doesn't
  // hammer the API.
  void gitHubTokenHealthService.refresh();
  // Same opportunistic re-check for agent reachability — internal cooldown
  // prevents the alt-tab path from fanning out probes.
  void agentConnectivityService.refresh({ reason: "focus" });
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
