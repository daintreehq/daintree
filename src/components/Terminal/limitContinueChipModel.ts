import type {
  CodexLimitContinueSkipReason,
  CodexLimitContinueState,
} from "@shared/types/codexLimitContinuation";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * How long a pane's chip says how its wait ended, from when main recorded it.
 * A day covers a night: a skip at 3:41 AM is still on the pane at 8 AM.
 */
export const LIMIT_CONTINUE_OUTCOME_TTL_MS = DAY_MS;

const clockFormat: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/**
 * An instant as the header names it, in the viewer's locale, clock and word
 * order: "3:40 PM" today, "Mon 10:00 AM" within a week, "Nov 26, 10:00 AM"
 * beyond, where a weekday alone could mean two days.
 */
export function formatLimitClock(at: number, now: number, locale?: string): string {
  const date = new Date(at);
  if (sameDay(at, now)) return date.toLocaleTimeString(locale, clockFormat);
  const day: Intl.DateTimeFormatOptions =
    Math.abs(at - now) < WEEK_MS ? { weekday: "short" } : { month: "short", day: "numeric" };
  return date.toLocaleString(locale, { ...day, ...clockFormat });
}

/** The instant in full, for the tooltip: "Mon, Nov 23, 10:00 AM PST". */
export function formatLimitInstant(at: number, locale?: string): string {
  return new Date(at).toLocaleString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...clockFormat,
    timeZoneName: "short",
  });
}

/**
 * How the chip treats each recorded skip (#17909): `no-reset` for a reset
 * Daintree couldn't establish, `skipped` for a check that refused the stop or
 * the line, at the stop or at the reset, `unconfirmed` where the line may have
 * gone in with no answer to say so, and `hidden` for a stop the pane's own
 * fallback handles. Each copy says what Daintree saw, not what it concludes.
 * Exhaustive, so a new reason has to be placed here.
 */
const SKIPS: Record<
  CodexLimitContinueSkipReason,
  { kind: "no-reset" | "skipped" | "unconfirmed" | "hidden"; copy: string }
> = {
  "no-reset": { kind: "no-reset", copy: "The limit names no reset, as a credit or spend cap" },
  "no-reset-stated": { kind: "no-reset", copy: "Codex didn't say when the limit resets" },
  "unreadable-banner": { kind: "no-reset", copy: "The limit message couldn't be read" },
  unattributed: {
    kind: "no-reset",
    copy: "Daintree didn't start this Codex, so its account and time zone aren't known",
  },
  "zone-unknown": {
    kind: "no-reset",
    copy: "The time zone the pane was started with couldn't be read",
  },
  "unreadable-time": {
    kind: "no-reset",
    copy: "The reset time in the limit message couldn't be read",
  },
  "ambiguous-time": {
    kind: "no-reset",
    copy: "The reset time in the limit message could mean more than one moment",
  },
  "late-reading": {
    kind: "no-reset",
    copy: "The account's usage wasn't read before the reset's minute began",
  },
  "quota-disagrees": {
    kind: "no-reset",
    copy: "The account's usage reading doesn't match the limit message",
  },
  "quota-incomplete": { kind: "no-reset", copy: "The account's usage reading was incomplete" },
  "ambiguous-bucket": {
    kind: "no-reset",
    copy: "More than one of the account's limits could be the one hit",
  },
  "no-banner": { kind: "skipped", copy: "The limit message wasn't on screen" },
  "not-observed": {
    kind: "skipped",
    copy: "Daintree couldn't confirm it read the pane's output the whole time since the limit message showed",
  },
  "banner-changed": { kind: "skipped", copy: "The limit message changed" },
  "host-unanswered": {
    kind: "unconfirmed",
    copy: "The pane's host didn't answer. Check the pane to see where it stands.",
  },
  "falls-back": {
    kind: "hidden",
    copy: "The pane's preset falls back to another preset on usage limits",
  },
  "fallback-undetermined": {
    kind: "skipped",
    copy: "Whether the pane's preset falls back on usage limits couldn't be told",
  },
  "already-continued": { kind: "skipped", copy: "Daintree already tried this reset" },
  disarmed: { kind: "skipped", copy: "It was turned off for this pane" },
  "process-changed": { kind: "skipped", copy: "The pane restarted, exited or moved" },
  "agent-gone": { kind: "skipped", copy: "Codex left the pane, or the pane is in the trash" },
  "banner-gone": { kind: "skipped", copy: "The limit message left the screen" },
  "input-since": {
    kind: "skipped",
    copy: "Something was typed or sent to the pane after the limit",
  },
  "dialog-since": { kind: "skipped", copy: "A dialog showed in the pane after the limit" },
  "input-pending": {
    kind: "skipped",
    copy: "Input was still waiting to be written to the pane",
  },
  "input-locked": { kind: "skipped", copy: "The pane's input was locked" },
  "agent-working": { kind: "skipped", copy: "Codex looked busy" },
  "output-since": { kind: "skipped", copy: "The pane printed while it was being checked" },
  "reads-paused": { kind: "skipped", copy: "The pane's output wasn't being read" },
  "unreadable-screen": { kind: "skipped", copy: "The pane's screen couldn't be read" },
  "banner-not-last": { kind: "skipped", copy: "Something was printed after the limit message" },
  "no-composer": { kind: "skipped", copy: "Daintree didn't recognize Codex's prompt on screen" },
  draft: { kind: "skipped", copy: "The prompt wasn't empty" },
  "unrecognized-footer": {
    kind: "skipped",
    copy: "Daintree didn't recognize what Codex's footer showed",
  },
  "not-delivered": {
    kind: "skipped",
    copy: "The line was refused or interrupted on its way in. It may be at the prompt, unsent.",
  },
};

export function describeSkipReason(reason: CodexLimitContinueSkipReason): string {
  return SKIPS[reason].copy;
}

/** What the header says about a pane's continuation. */
export interface LimitContinueChip {
  /** Waiting for the reset, a stop with no reset to wait for, or how the wait ended. */
  kind: "waiting" | "no-reset" | "skipped" | "unconfirmed" | "continued";
  /** The chip's label; it yields to the glyph on a narrow header. */
  label: string;
  /** The tooltip's lines, the first its title, which also names the chip on a narrow header. */
  lines: string[];
}

/**
 * Whether a state can put anything on the chip at some time: main keeps an
 * outcome until the next stop, the chip only for a while.
 */
export function canShowLimitContinue(state: CodexLimitContinueState | undefined): boolean {
  if (!state || state.status === "armed") return false;
  return state.status !== "skipped" || SKIPS[state.reason].kind !== "hidden";
}

/**
 * The chip for a pane's continuation at `now`, or null when it says nothing:
 * armed with no stop yet (the pane menu's checked item shows that), a stop
 * the pane's fallback takes, or an outcome older than a day. A wait shows
 * for as long as main holds it, however far off its reset.
 */
export function describeLimitContinue(
  state: CodexLimitContinueState | undefined,
  now: number,
  locale?: string
): LimitContinueChip | null {
  if (!state || !canShowLimitContinue(state)) return null;
  switch (state.status) {
    case "armed":
      return null;
    case "waiting": {
      const when = formatLimitClock(state.continueAt, now, locale);
      // Its time came and no result has arrived yet: the owner is checking,
      // waking, or the answer is on its way.
      const due = state.continueAt <= now;
      return {
        kind: "waiting",
        label: due ? `Resume due ${when}` : `Resumes ${when}`,
        lines: [
          due ? `Resume due ${when}` : `Resumes ${when}`,
          `The usage limit resets ${formatLimitInstant(state.resetsAt, locale)}`,
          `Continues ${formatLimitInstant(state.continueAt, locale)}, if the pane is still where the limit left it`,
        ],
      };
    }
    case "continued": {
      if (now - state.at >= LIMIT_CONTINUE_OUTCOME_TTL_MS) return null;
      // What Daintree did, typed the line, not that the agent took it up.
      return {
        kind: "continued",
        label: `Resume sent ${formatLimitClock(state.at, now, locale)}`,
        lines: [
          `Resume sent ${formatLimitInstant(state.at, locale)}`,
          `Daintree typed "${state.line}" once the usage limit reset`,
        ],
      };
    }
    case "skipped": {
      if (now - state.at >= LIMIT_CONTINUE_OUTCOME_TTL_MS) return null;
      const { kind, copy } = SKIPS[state.reason];
      if (kind === "no-reset") {
        return {
          kind: "no-reset",
          label: "No reset time",
          // A credit or spend cap names no reset, so there's nothing to look up.
          lines:
            state.reason === "no-reset"
              ? ["No reset time to wait for", copy]
              : [
                  "No reset time to wait for",
                  copy,
                  "Check the limit message for when the limit resets",
                ],
        };
      }
      const label = kind === "unconfirmed" ? "Resume unconfirmed" : "Resume skipped";
      return {
        kind: kind === "unconfirmed" ? "unconfirmed" : "skipped",
        label,
        lines: [`${label} ${formatLimitInstant(state.at, locale)}`, copy],
      };
    }
  }
}
