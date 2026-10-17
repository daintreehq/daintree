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
 * With {@link ENABLE_HOST_MODE_FLAG}, `--update-channel=<stable|nightly>`: the
 * channel of the Shell whose setup just installed this build here, so a fresh
 * host updates along with it instead of the default. Only setup sends it, and
 * only to a machine that had no Daintree before.
 */
export const UPDATE_CHANNEL_FLAG = "--update-channel";
/**
 * Bridge stdin/stdout to the Daintree already running here (see
 * `remote/host/attachStdio.ts`) and exit: never a second instance, never a
 * window, never a backend.
 */
export const ATTACH_STDIO_FLAG = "--attach-stdio";
/**
 * Chromium picks its Ozone backend before any of our code runs, so a headless
 * Host has to be started with this switch on its command line; appending it
 * from the main process is too late, and Ozone aborts looking for X11.
 */
export const HEADLESS_OZONE_SWITCH = "--ozone-platform=headless";
/** A handoff launch that found no Daintree running to hand over to. */
export const HOST_MODE_HANDOFF_NOBODY_EXIT_CODE = 3;

export function isHostModeRequested(argv: readonly string[]): boolean {
  return argv.includes(HOST_MODE_FLAG) || argv.includes(ENABLE_HOST_MODE_FLAG);
}

export function isHostModeEnableRequested(argv: readonly string[]): boolean {
  return argv.includes(ENABLE_HOST_MODE_FLAG);
}

/** The update channel host setup asked for alongside its enable request, if any. */
export function requestedUpdateChannel(argv: readonly string[]): "stable" | "nightly" | null {
  if (!isHostModeEnableRequested(argv)) return null;
  for (const arg of argv) {
    if (arg === `${UPDATE_CHANNEL_FLAG}=stable`) return "stable";
    if (arg === `${UPDATE_CHANNEL_FLAG}=nightly`) return "nightly";
  }
  return null;
}

export function isAttachStdioRequested(argv: readonly string[]): boolean {
  return argv.includes(ATTACH_STDIO_FLAG);
}

export function isHostModeHandoffOnly(argv: readonly string[]): boolean {
  return argv.includes(HOST_MODE_HANDOFF_FLAG);
}

/**
 * A Host-mode (or `--attach-stdio`) launch on Linux that runs Chromium on the
 * headless Ozone backend: one started with {@link HEADLESS_OZONE_SWITCH} (the
 * systemd unit always is), or one with no display server. Everything else
 * keeps today's platform auto-detection.
 */
export function shouldUseHeadlessOzone(input: {
  platform: NodeJS.Platform;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
}): boolean {
  if (input.platform !== "linux") return false;
  if (!isHostModeRequested(input.argv) && !isAttachStdioRequested(input.argv)) return false;
  if (input.argv.includes(HEADLESS_OZONE_SWITCH)) return true;
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
