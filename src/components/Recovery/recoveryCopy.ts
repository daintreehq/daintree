import type { CrashType } from "@shared/types/pty-host";
import type { PanelSuspectReason } from "@shared/types/ipc/crashRecovery";
import { pluralize } from "@/lib/pluralize";
import type { HostBannerVariant } from "@/store/hostConnectionStore";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { formatCountdown } from "@/utils/formatCountdown";
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
 * unreachable, a different build — and never guesses why. Every title is one
 * clause naming the host, with an observed time after " · " where there is
 * one; the description says what happens next.
 */
export function getHostConnectionBannerCopy(
  variant: HostBannerVariant,
  hostName: string,
  lastSeenAt: number | null,
  now: number = Date.now(),
  /** What ssh said when it couldn't log in, for `access-denied`. */
  detail: string | null = null,
  /** Which side runs the older build, for `version-mismatch`; null when the builds have no order. */
  olderSide: "host" | "local" | null = null
): RecoveryBannerCopy & { contextLine?: string } {
  const seen = lastSeenAt === null ? "" : ` · last seen ${formatRelativeTime(lastSeenAt, now)}`;
  switch (variant) {
    case "reconnecting":
      return {
        title: `Lost connection to ${hostName}${seen}`,
        description: "Reconnecting on its own. Terminals are read-only until it's back.",
      };
    case "connecting":
      return {
        title: `Connecting to ${hostName}…`,
        description: "Terminals are read-only until it connects.",
      };
    case "restarting":
      // The host said it was shutting down: its word, not a guess.
      return { title: `${hostName} is restarting…`, description: HOST_READ_ONLY_DESCRIPTION };
    case "unreachable":
      return {
        title: `${hostName} is unreachable${seen}`,
        description: HOST_READ_ONLY_DESCRIPTION,
      };
    case "host-mode-off":
      // No Daintree listening there: quit, not started since a reboot, or
      // never set up all look the same from here, so say only what was seen.
      return {
        title: `Daintree isn't listening on ${hostName}${seen}`,
        description:
          "This window reconnects once Daintree is running there again. Terminals are read-only until then.",
      };
    case "access-denied": {
      // ssh's own words are the evidence, so they stay, as metadata under
      // the sentence rather than as the sentence.
      const said = sshRefusalLine(detail);
      return {
        title: `Couldn't log in to ${hostName} over ssh`,
        description: "Automatic retries have stopped. Terminals are read-only until it connects.",
        ...(said ? { contextLine: `ssh: ${said}` } : {}),
      };
    }
    case "version-mismatch":
      if (olderSide === "host") {
        return {
          title: `${hostName} runs an older version of Daintree`,
          description: `This window connects once ${hostName} is updated to match this machine.`,
        };
      }
      if (olderSide === "local") {
        return {
          title: `This machine runs an older version of Daintree than ${hostName}`,
          description: "This window connects once this machine is updated to match.",
        };
      }
      return {
        title: `${hostName} runs a different build of Daintree`,
        description: "This window connects once both run the same build.",
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
 * Who has control of a project, of what and where: the facts every surface
 * that offers Take control states in the same words — the window banner, a
 * pane's strip, the waiting gate, the file and plugin placeholders and the
 * host's connected-machines menu.
 */
export interface ControlFacts {
  /** The device with control: a machine's name, or the host's own screen. */
  holder: string;
  /** The host's own screen has control, so `holder` already names the host. */
  holderIsHostScreen: boolean;
  project: string;
  /** The host the project lives on, for a window attached to one; null on the host's own screen. */
  host: string | null;
}

/** How the host's own screen is named as the device with control. */
export function hostScreenName(hostName: string): string {
  return `${hostName}'s own screen`;
}

/** "greg-mbp has control of daintree on studio-01", without its full stop. */
export function controlHolderSentence(facts: ControlFacts): string {
  const where = facts.host !== null && !facts.holderIsHostScreen ? ` on ${facts.host}` : "";
  return `${facts.holder} has control of ${facts.project}${where}`;
}

/**
 * What taking control does to the device that has it, said wherever the
 * action is offered: the take is immediate and asks nobody, so the person
 * there is cut off mid-keystroke unless this says so first. Every surface
 * names the holder before this, so the host's own screen is "that screen".
 */
export function takeControlConsequence(facts: ControlFacts): string {
  const where = facts.holderIsHostScreen ? "that screen" : facts.holder;
  return `Makes ${facts.project} read-only on ${where}`;
}

/**
 * Copy for a project another device controls. One device controls a project
 * at a time, and this view follows it live but can't change it. The title
 * answers first whether anything can be done here, and names what this is
 * and where; the description names who has control and what taking it does
 * to them. While that device is away (`awaySeconds`), the host holds control
 * for it that much longer, then passes it on to a view still on the project
 * (not necessarily this one).
 */
export function getDriveLeaseBannerCopy(
  facts: ControlFacts,
  awaySeconds: number | null = null,
  busy = false
): RecoveryBannerCopy {
  const title = `Read-only · ${facts.project}${facts.host !== null ? ` on ${facts.host}` : ""}`;
  const who =
    awaySeconds !== null
      ? `${facts.holder} is away. Control passes on in ${formatCountdown(awaySeconds)} unless it comes back.`
      : `${facts.holder} has control.`;
  return { title, description: `${who} ${busy ? TAKING_CONTROL : takeControlSentence(facts)}` };
}

/**
 * What stands in for the consequence while a request is in flight, so the
 * busy button beside it is never a spinner with no words.
 */
export const TAKING_CONTROL = "Taking control here…";

/** The offer's accessible name: its visible label, then what it does. */
export function takeControlAriaLabel(facts: ControlFacts): string {
  return `Take control. ${takeControlConsequence(facts)}`;
}

/** The consequence as a sentence, beside an offer that already reads "Take control". */
export function takeControlSentence(facts: ControlFacts): string {
  const consequence = takeControlConsequence(facts);
  return `Taking control here ${consequence.charAt(0).toLowerCase()}${consequence.slice(1)}.`;
}

/**
 * Something the host serves only to the window with control — a file or diff
 * preview, a plugin's view — held here: who has control, and that it shows
 * here once this window does. `what` is its subject ("The file"). While the
 * host's link is down, that is what it waits for first, as the gate says.
 */
export function getControlRefusalCopy(
  what: string,
  facts: ControlFacts | null,
  linkDownHost: string | null = null
): RecoveryBannerCopy {
  if (linkDownHost !== null) {
    return {
      title: `Waiting for ${linkDownHost}`,
      description: `The connection to ${linkDownHost} is down. ${what} shows here once it's back and this window has control.`,
    };
  }
  return {
    title: "Waiting for control",
    description:
      facts === null
        ? `${what} shows here once this window has control of the project.`
        : `${controlHolderSentence(facts)}. ${what} shows here once this window has control.`,
  };
}

/**
 * A launch held until this window has control (#13913): what it waits for,
 * who has control, and that it starts on its own. While the host's link is
 * down, that is what it waits for first. It never promises a time: an away
 * holder's control may pass to another window.
 */
export function getDriveLeaseGateCopy(
  subject: string,
  facts: ControlFacts | null,
  away: boolean,
  linkDownHost: string | null
): RecoveryBannerCopy {
  if (linkDownHost !== null) {
    return {
      title: `${subject} is waiting for ${linkDownHost}`,
      description: `The connection to ${linkDownHost} is down. ${subject} starts here once it's back and this window has control.`,
    };
  }
  const starts = `${subject} starts here on its own once this window has control.`;
  if (facts === null) return { title: `${subject} is waiting for control`, description: starts };
  const where = facts.host !== null && !facts.holderIsHostScreen ? ` on ${facts.host}` : "";
  return {
    title: `${subject} is waiting for control`,
    description: away
      ? `${facts.holder} is away from ${facts.project}${where}. ${starts}`
      : `${controlHolderSentence(facts)}. ${starts}`,
  };
}
