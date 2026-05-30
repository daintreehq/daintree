export interface RestartBannerCopyMap {
  "auto-restarting": { title: string };
  restarting: { title: string };
  "exit-error": (args: { exitCode: number }) => { title: string };
}

export const RESTART_BANNER_COPY: RestartBannerCopyMap = {
  "auto-restarting": { title: "Auto-restarting…" },
  restarting: { title: "Restarting…" },
  "exit-error": ({ exitCode }) => ({ title: `Session exited with code ${exitCode}` }),
};
