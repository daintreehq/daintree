import type { CrashType } from "@shared/types/pty-host";
import type { PanelSuspectReason } from "@shared/types/ipc/crashRecovery";
import type { HostBannerVariant } from "@/store/hostConnectionStore";
import { formatRelativeTime } from "@/lib/formatRelativeTime";

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

export const RESTORE_CONFIRMATION_TITLE = "Session recovered after unexpected exit";

/**
 * The caveat under the title, or `undefined` when there is none — a clean
 * recovery is a one-line reassurance, and the description is what turns it
 * into a warning.
 */
export function getRestoreConfirmationDescription(suspectCount: number): string | undefined {
  if (suspectCount <= 0) return undefined;
  return `${suspectCount} ${suspectCount === 1 ? "panel" : "panels"} created near the crash may be affected.`;
}

export function getSuspectPanelBannerTitle(count: number, deselected: boolean): string {
  const noun = count === 1 ? "panel" : "panels";
  if (deselected) {
    return `${count} ${noun} deselected — created shortly before the crash`;
  }
  return `${count} ${noun} created shortly before the crash`;
}

/**
 * Per-panel reason text shown on the suspect badge. Reasons with no
 * user-facing copy yet (and unknown/future values) return `undefined`, which
 * the row renders as an icon-only badge with no tooltip.
 */
export function getPanelSuspectReasonTitle(reason?: PanelSuspectReason): string | undefined {
  switch (reason) {
    case "crash-window":
      return "Created within 30 seconds of the crash";
    default:
      return undefined;
  }
}

export const SUSPECT_PANEL_BANNER_DESCRIPTION_DESELECTED =
  "These panels may have caused the crash. Re-check to include them.";
export const SUSPECT_PANEL_BANNER_DESCRIPTION_SELECTED =
  "These panels may be related to the crash. Consider deselecting before restoring.";

const HOST_READ_ONLY_DESCRIPTION = "Terminals are read-only until it reconnects.";

/**
 * Copy for the window's link to its host. It states what was observed — lost,
 * unreachable, a different build — and never guesses why.
 */
export function getHostConnectionBannerCopy(
  variant: HostBannerVariant,
  hostName: string,
  lastSeenAt: number | null,
  now: number = Date.now()
): RecoveryBannerCopy {
  switch (variant) {
    case "reconnecting":
      return {
        title: `Connection to ${hostName} lost. Reconnecting…`,
        description: HOST_READ_ONLY_DESCRIPTION,
      };
    case "connecting":
      return { title: `Connecting to ${hostName}…`, description: HOST_READ_ONLY_DESCRIPTION };
    case "unreachable":
      return {
        title:
          lastSeenAt === null
            ? `${hostName} is unreachable`
            : `${hostName} is unreachable · last seen ${formatRelativeTime(lastSeenAt, now)}`,
        description: HOST_READ_ONLY_DESCRIPTION,
      };
    case "version-mismatch":
      return {
        title: `${hostName} runs a different build`,
        description: "Nothing is sent to it until both run the same Daintree version.",
      };
    case "disconnected":
      return {
        title: `Disconnected from ${hostName}`,
        description: "Terminals are read-only until you connect again.",
      };
    case "checking":
      return {
        title: `Checking with ${hostName}…`,
        description: "The connection dropped before it answered. Confirming what happened.",
      };
  }
}

/**
 * Copy for a project another machine drives. Only one frontend drives at a
 * time, so this states who does and offers to take it; it never mirrors.
 */
export function getDriveLeaseBannerCopy(
  state:
    | { kind: "taken-from-host"; driverName: string }
    | { kind: "driven-elsewhere"; driverName: string; driverIsHostScreen: boolean },
  hostName: string
): RecoveryBannerCopy & { actionLabel: string } {
  if (state.kind === "taken-from-host") {
    return {
      title: `Being driven from ${state.driverName}`,
      description: "Terminals here are read-only while it drives. Take back to type here again.",
      actionLabel: "Take back",
    };
  }
  return {
    title: state.driverIsHostScreen
      ? `${hostName} is being driven from its own screen`
      : `${hostName} is being driven from ${state.driverName}`,
    description: "Terminals here are read-only while it drives. Take over to type here instead.",
    actionLabel: "Take over",
  };
}
