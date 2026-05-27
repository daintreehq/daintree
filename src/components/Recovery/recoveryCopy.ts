import type { CrashType } from "@shared/types/pty-host";
import type { PanelSuspectReason } from "@shared/types/ipc/crashRecovery";

export interface RecoveryBannerCopy {
  title: string;
  description: string;
}

export const HOST_CRASH_RECOVERING_COPY = {
  title: "Terminal service restarting",
  description: "The terminal backend stopped and is restarting automatically.",
} as const satisfies RecoveryBannerCopy;

export const HOST_CRASH_BANNER_COPY = {
  OUT_OF_MEMORY: {
    title: "Terminal service ran out of memory",
    description:
      "The terminal backend exhausted memory and gave up after three auto-restart attempts. Close unused terminals before restarting.",
  },
  SIGNAL_TERMINATED: {
    title: "Terminal service was terminated",
    description:
      "The OS or a watchdog ended the terminal backend three times in a row. Restart the service to continue.",
  },
  ASSERTION_FAILURE: {
    title: "Terminal service hit an assertion failure",
    description:
      "The terminal backend crashed three times in a row. Restart the service to continue.",
  },
  CLEAN_EXIT: {
    title: "Terminal service stopped unexpectedly",
    description:
      "The terminal backend exited without an error but wasn't asked to. Restart the service to continue.",
  },
  UNKNOWN_CRASH: {
    title: "Terminal service crashed",
    description:
      "The terminal backend stopped after three auto-restart attempts. Restart the service to continue.",
  },
} as const satisfies Record<CrashType, RecoveryBannerCopy>;

export function getHostCrashBannerCopy(crashType: CrashType | null): RecoveryBannerCopy {
  return HOST_CRASH_BANNER_COPY[crashType ?? "UNKNOWN_CRASH"];
}

export const SAFE_MODE_BANNER_COPY = {
  title: "Safe mode — panels weren't restored",
} as const;

export function getRestoreConfirmationTitle(suspectCount: number): string {
  if (suspectCount > 0) {
    return `Session recovered after unexpected exit — ${suspectCount} ${suspectCount === 1 ? "panel" : "panels"} created near the crash may be affected.`;
  }
  return "Session recovered after unexpected exit.";
}

export function getSuspectPanelBannerTitle(count: number, deselected: boolean): string {
  const noun = count === 1 ? "panel" : "panels";
  if (deselected) {
    return `${count} ${noun} deselected — created shortly before the crash`;
  }
  return `${count} ${noun} created shortly before the crash`;
}

/**
 * Per-panel reason text shown on the suspect badge. Returns `undefined` for
 * reasons with no user-facing copy yet (e.g. `repeated-suspect`), which the
 * row renders as an icon-only badge with no tooltip.
 */
export function getPanelSuspectReasonTitle(reason?: PanelSuspectReason): string | undefined {
  switch (reason) {
    case "crash-window":
      return "Created within 30 seconds of the crash";
    case "repeated-suspect":
      return "Flagged across multiple crash sessions";
    default:
      return undefined;
  }
}

export const SUSPECT_PANEL_BANNER_DESCRIPTION_DESELECTED =
  "These panels may have caused the crash. Re-check to include them.";
export const SUSPECT_PANEL_BANNER_DESCRIPTION_SELECTED =
  "These panels may be related to the crash. Consider deselecting before restoring.";
