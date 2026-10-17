import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { onWindowsTreeKillUnavailable } from "../utils/windowsTreeKill.js";

/**
 * The one notice a session gets when PowerShell cannot run Windows tree kills
 * at all — missing, blocked by AppLocker or WDAC, or held in Constrained
 * Language Mode. Every process that kills trees (Main, each pty-host) detects
 * it on its own; Main says it once. There is no in-app fix and nothing else
 * shows it: closed terminals look closed while what ran in them carries on.
 */
let noticeGiven = false;
let installed = false;

export function reportWindowsTreeKillUnavailable(reason: string, source: string): void {
  if (noticeGiven) return;
  noticeGiven = true;
  console.warn(
    `[WindowsTreeKill] ${source}: PowerShell could not run the process-tree kill (${reason}); programs started in closed terminals may keep running until Daintree quits`
  );
  try {
    broadcastToRenderer(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "warning",
      title: "Process cleanup limited",
      message:
        "Daintree couldn't run PowerShell, which it uses to stop programs started in a terminal. Terminals still close, but those programs may keep running until Daintree quits.",
      rateLimitKey: "windows-tree-kill-unavailable",
    });
  } catch (error) {
    console.warn("[WindowsTreeKill] Could not show the PowerShell notice:", error);
  }
}

/** Report Main's own helper failures through {@link reportWindowsTreeKillUnavailable}. Idempotent. */
export function installWindowsTreeKillNotice(): void {
  if (installed || process.platform !== "win32") return;
  installed = true;
  onWindowsTreeKillUnavailable((reason) => reportWindowsTreeKillUnavailable(reason, "main"));
}

/** Test-only: a fresh session. */
export function resetWindowsTreeKillNoticeForTest(): void {
  noticeGiven = false;
}
