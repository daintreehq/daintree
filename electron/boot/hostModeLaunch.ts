// Pure launch classification for Host mode. Imported by setup/environment.ts at
// module load, before `app` is ready, so it must stay free of Electron and
// store imports.

export const HOST_MODE_FLAG = "--host-mode";
export const HIDDEN_LAUNCH_FLAG = "--hidden";
/**
 * Host setup from another machine: switch Host mode on as the Settings switch
 * does (saved, start at login installed, keychain checked), not just listen
 * for this run. Implies `--host-mode`.
 */
export const ENABLE_HOST_MODE_FLAG = "--enable-host-mode";
/**
 * Only hand the other flags to a Daintree that is already running; never
 * become one. Setup runs it from an SSH session, where the backend must not run.
 */
export const HOST_MODE_HANDOFF_FLAG = "--host-mode-handoff";
/**
 * Bridge stdin/stdout to the Daintree already running here (see
 * `remote/host/attachStdio.ts`) and exit: never a second instance, never a
 * window, never a backend.
 */
export const ATTACH_STDIO_FLAG = "--attach-stdio";
/** A handoff launch that found no Daintree running to hand over to. */
export const HOST_MODE_HANDOFF_NOBODY_EXIT_CODE = 3;

export function isHostModeRequested(argv: readonly string[]): boolean {
  return argv.includes(HOST_MODE_FLAG) || argv.includes(ENABLE_HOST_MODE_FLAG);
}

export function isHostModeEnableRequested(argv: readonly string[]): boolean {
  return argv.includes(ENABLE_HOST_MODE_FLAG);
}

export function isAttachStdioRequested(argv: readonly string[]): boolean {
  return argv.includes(ATTACH_STDIO_FLAG);
}

export function isHostModeHandoffOnly(argv: readonly string[]): boolean {
  return argv.includes(HOST_MODE_HANDOFF_FLAG);
}

/**
 * A Host-mode (or `--attach-stdio`) launch on Linux with no display server has to run Chromium on
 * the headless Ozone backend, or Ozone init aborts before `ready`. Everything
 * else keeps today's platform auto-detection.
 */
export function shouldUseHeadlessOzone(input: {
  platform: NodeJS.Platform;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}): boolean {
  if (input.platform !== "linux") return false;
  if (!isHostModeRequested(input.argv) && !isAttachStdioRequested(input.argv)) return false;
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
