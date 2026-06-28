export interface RestartBannerCopyMap {
  "auto-restarting": { title: string };
  restarting: { title: string };
  "session-resume-unavailable": { title: string; description: string };
  "exit-error": (args: { exitCode: number }) => { title: string };
}

export const RESTART_BANNER_COPY: RestartBannerCopyMap = {
  "auto-restarting": { title: "Auto-restarting…" },
  restarting: { title: "Restarting…" },
  // Neutral, non-accusatory copy per issue #9802 and the CLAUDE.md microcopy
  // rule. Title is a period-free noun phrase. The description reassures rather
  // than prompts an action (issue #10823) — the terminal already relaunched
  // into a fresh, usable session, so the banner is a dismissable acknowledgement.
  "session-resume-unavailable": {
    title: "Session no longer reachable",
    description: "The previous session couldn't be restored. A fresh session is ready.",
  },
  "exit-error": ({ exitCode }) => ({ title: `Session exited with code ${exitCode}` }),
};
