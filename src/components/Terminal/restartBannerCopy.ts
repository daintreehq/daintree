export interface RestartBannerCopyMap {
  "auto-restarting": { title: string };
  "exit-error": (args: { exitCode: number }) => { title: string };
}

export const RESTART_BANNER_COPY: RestartBannerCopyMap = {
  "auto-restarting": { title: "Auto-restarting…" },
  "exit-error": ({ exitCode }) => ({ title: `Session exited with code ${exitCode}` }),
};
