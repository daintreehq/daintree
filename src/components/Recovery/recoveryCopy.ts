import type { CrashType } from "@shared/types/pty-host";
import type { PanelSuspectReason } from "@shared/types/ipc/crashRecovery";
import { pluralize } from "@/lib/pluralize";
import type { HostBannerVariant } from "@/store/hostConnectionStore";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { sshRefusalLine } from "@shared/utils/sshRefusal";

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
  return `${pluralize(suspectCount, "panel")} created near the crash may be affected.`;
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
  now: number = Date.now(),
  /** What ssh said when it couldn't log in, for `access-denied`. */
  detail: string | null = null
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
    case "host-mode-off":
      return {
        title: `Daintree isn't running in Host mode on ${hostName}`,
        description: "Terminals are read-only until it is set up there.",
      };
    case "access-denied": {
      const said = sshRefusalLine(detail);
      return {
        title: `ssh couldn't log in to ${hostName}`,
        description: said
          ? `ssh said: ${said}. Not retrying until you connect again.`
          : "Not retrying until you connect again.",
      };
    }
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
 * Copy for a project another device controls. One device controls a project
 * at a time; this names it and offers control here. Its terminals' output
 * streams here live, but its layout, panels, drafts and the terminals it opens
 * later don't follow, so the copy says only what holds: this view is
 * read-only, in the pane strips' word.
 */
export function getDriveLeaseBannerCopy(
  state:
    | { kind: "taken-from-host"; driverName: string }
    | { kind: "driven-elsewhere"; driverName: string; driverIsHostScreen: boolean },
  hostName: string
): RecoveryBannerCopy & { actionLabel: string } {
  const controller =
    state.kind === "driven-elsewhere" && state.driverIsHostScreen
      ? `${hostName}'s own screen`
      : state.driverName;
  return {
    title: `${controller} has control of this project`,
    description:
      "Read-only. Terminal output streams here live, but layout, panels and drafts don't follow.",
    actionLabel: "Take control",
  };
}
