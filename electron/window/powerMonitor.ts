import { BrowserWindow, powerMonitor } from "electron";
import type { PtyClient } from "../services/PtyClient.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";
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
