import type { SessionLostReason } from "@shared/types/panel";

interface SessionLostCopy {
  title: string;
  description: string;
  dismissAllLabel: string;
  dismissAllAriaLabel: string;
}

export interface RestartBannerCopyMap {
  "auto-restarting": { title: string };
  restarting: { title: string };
  "session-resume-unavailable": (args: { reason: SessionLostReason }) => SessionLostCopy;
  "exit-error": (args: { exitCode: number }) => { title: string };
}

// Bulk control copy is reason-independent — it's about how many panes are
// flagged, not why any one of them is (issue #11589).
const DISMISS_ALL: Pick<SessionLostCopy, "dismissAllLabel" | "dismissAllAriaLabel"> = {
  dismissAllLabel: "Dismiss all",
  dismissAllAriaLabel: "Dismiss all session-lost warnings",
};

// Neutral, non-accusatory copy per issue #9802 and the CLAUDE.md microcopy
// rule. Titles are period-free noun phrases. Descriptions reassure rather
// than prompt an action (issue #10823) — the terminal already relaunched into
// a fresh, usable session, so the banner is a dismissable acknowledgement.
// Reason-specific per issue #12182: a sibling pane already holding the
// conversation is a materially different situation from there being nothing
// to resume, and the two shouldn't read as the same "it's gone" message.
const SESSION_LOST_COPY: Record<
  SessionLostReason,
  Omit<SessionLostCopy, keyof typeof DISMISS_ALL>
> = {
  "no-resume-command": {
    title: "Session no longer reachable",
    description: "The previous session couldn't be restored. A fresh session was started.",
  },
  "no-resume-path": {
    title: "Session no longer reachable",
    description: "The previous session couldn't be restored. A fresh session was started.",
  },
  "sibling-owns-session-id": {
    title: "Session already open elsewhere",
    description: "Another pane already holds this conversation. A fresh session was started here.",
  },
  "sibling-owns-resume-latest-slot": {
    title: "Most recent session claimed elsewhere",
    description:
      "Another pane in this folder already reopened the most recent session. A fresh session was started here.",
  },
};

export const RESTART_BANNER_COPY: RestartBannerCopyMap = {
  "auto-restarting": { title: "Auto-restarting…" },
  restarting: { title: "Restarting…" },
  "session-resume-unavailable": ({ reason }) => ({ ...SESSION_LOST_COPY[reason], ...DISMISS_ALL }),
  "exit-error": ({ exitCode }) => ({ title: `Session exited with code ${exitCode}` }),
};
