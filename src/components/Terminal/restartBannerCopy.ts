export interface RestartBannerCopyMap {
  "auto-restarting": { title: string };
  restarting: { title: string };
  "session-resume-unavailable": { title: string; description: string };
  "exit-error": (args: { exitCode: number }) => { title: string };
}

export const RESTART_BANNER_COPY: RestartBannerCopyMap = {
  "auto-restarting": { title: "Auto-restarting…" },
  restarting: { title: "Restarting…" },
  // Neutral, non-accusatory copy per issue #9802 and the CLAUDE.md
  // Title-Message-Action microcopy rule. Title is a noun phrase; the action
  // label ("Start new session") lives in the banner component.
  "session-resume-unavailable": {
    title: "Session no longer reachable",
    description: "The previous conversation couldn't be restored. Start a new session to continue.",
  },
  "exit-error": ({ exitCode }) => ({ title: `Session exited with code ${exitCode}` }),
};
