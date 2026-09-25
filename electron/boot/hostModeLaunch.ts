// Pure launch classification for Host mode. Imported by setup/environment.ts at
// module load, before `app` is ready, so it must stay free of Electron and
// store imports.

export const HOST_MODE_FLAG = "--host-mode";
export const HIDDEN_LAUNCH_FLAG = "--hidden";

export function isHostModeRequested(argv: readonly string[]): boolean {
  return argv.includes(HOST_MODE_FLAG);
}

/**
 * A Host-mode launch on Linux with no display server has to run Chromium on
 * the headless Ozone backend, or Ozone init aborts before `ready`. Everything
 * else keeps today's platform auto-detection.
 */
export function shouldUseHeadlessOzone(input: {
  platform: NodeJS.Platform;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}): boolean {
  if (input.platform !== "linux") return false;
  if (!isHostModeRequested(input.argv)) return false;
  return !input.env.DISPLAY && !input.env.WAYLAND_DISPLAY;
}

/**
 * Whether this launch starts the backend with no window. `--host-mode` always
 * does (a login item or systemd unit asked for it). Otherwise it takes Host
 * mode being switched on AND a launch that asked to stay hidden — a plain
 * launch with Host mode on still opens the user's windows.
 */
export function resolveHostModeLaunch(input: {
  argv: readonly string[];
  hostModeEnabled: boolean;
  openedAsHidden: boolean;
}): boolean {
  if (isHostModeRequested(input.argv)) return true;
  if (!input.hostModeEnabled) return false;
  return input.openedAsHidden || input.argv.includes(HIDDEN_LAUNCH_FLAG);
}
