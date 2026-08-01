export interface RestartBannerCopyMap {
  "auto-restarting": { title: string };
  restarting: { title: string };
  "session-resume-unavailable": {
    title: string;
    description: string;
    dismissAllLabel: string;
    dismissAllAriaLabel: string;
  };
  "exit-error": (args: { exitCode: number }) => { title: string };
}

export const RESTART_BANNER_COPY: RestartBannerCopyMap = {
  "auto-restarting": { title: "Auto-restarting…" },
  restarting: { title: "Restarting…" },
  // Neutral, non-accusatory copy per issue #9802 and the CLAUDE.md microcopy
  // rule. Title is a period-free noun phrase. The description reassures rather
  // than prompts an action (issue #10823) — the terminal already relaunched
  // into a fresh, usable session, so the banner is a dismissable acknowledgement.
  // The bulk control keeps a short visible label — it sits inline next to the
  // per-pane close X, where the banner's own title supplies the context — and
  // carries the full scope in its accessible name (issue #11589).
  "session-resume-unavailable": {
    title: "Session no longer reachable",
    description: "The previous session couldn't be restored. A fresh session was started.",
    dismissAllLabel: "Dismiss all",
    dismissAllAriaLabel: "Dismiss all session-lost warnings",
  },
  "exit-error": ({ exitCode }) => ({ title: `Session exited with code ${exitCode}` }),
};
