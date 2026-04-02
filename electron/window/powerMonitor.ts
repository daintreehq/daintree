import { app, BrowserWindow, powerMonitor } from "electron";
import type { PtyClient } from "../services/PtyClient.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";
import type { ProjectStatsService } from "../services/ProjectStatsService.js";
import { CHANNELS } from "../ipc/channels.js";
import { getAppWebContents } from "./webContentsRegistry.js";

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
          await workspaceClient.refresh();
        }
        const sleepDuration = suspendTime ? Date.now() - suspendTime : 0;
        BrowserWindow.getAllWindows().forEach((win) => {
          if (win && !win.isDestroyed()) {
            const wc = getAppWebContents(win);
            if (!wc.isDestroyed()) {
              try {
                wc.send(CHANNELS.SYSTEM_WAKE, {
                  sleepDuration,
                  timestamp: Date.now(),
                });
              } catch {
                // Silently ignore send failures during window disposal.
              }
            }
          }
        });
        suspendTime = null;
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
