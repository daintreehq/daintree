import { isHostModeRequested } from "../boot/hostModeLaunch.js";
import { reapOrphanedAdvert } from "./host/advertRecord.js";
import { followAppImageMoves } from "./host/appImageRelocation.js";
import { hostLocation } from "./host/hostLocation.js";
import { readHostModeSettings } from "./host/hostModeSettings.js";
import type { HostSocketLocation } from "./host/hostSocketPath.js";
import { createLazyHostMode } from "./host/lazyHostMode.js";
import { registerRemoteService } from "./runtime.js";

function resolveLocation(override: HostSocketLocation | undefined): HostSocketLocation | null {
  try {
    return override ?? hostLocation();
  } catch {
    // Reported through the listener's own error when it tries to start.
    return null;
  }
}

/**
 * The Host role's start: Host mode's service (registered whatever the
 * setting, so its switch can start it at runtime) and, when Host mode is on
 * for this launch, its listener. Loaded by boot.ts only under
 * `__DAINTREE_REMOTE_HOST_ROLE__`, so a Windows build, which is only ever a
 * Shell, carries none of it. The service and the Host server behind it load
 * only once something needs them (#17027).
 *
 * Resolves with why listening failed, if it did; everything else is up.
 */
export async function startHostRole(
  options: { hostMode: boolean; hostLocation?: HostSocketLocation },
  addTeardown: (teardown: () => void | Promise<void>) => void
): Promise<{ error: unknown } | null> {
  const location = resolveLocation(options.hostLocation);
  // Whatever the settings now say: an advert the last launch left behind keeps announcing this machine.
  if (location) reapOrphanedAdvert(location.dir);
  const hostMode = createLazyHostMode({
    readSettings: readHostModeSettings,
    socketPath: location?.socketPath ?? null,
    load: async () => {
      const { createHostModeService } = await import("./host/hostModeDefaults.js");
      return () => createHostModeService({ location: options.hostLocation });
    },
  });
  addTeardown(registerRemoteService("hostMode", hostMode));
  addTeardown(() => hostMode.dispose());
  const listenError: { error: unknown } | null = options.hostMode
    ? await hostMode.startListening().then(
        () => null,
        (error: unknown) => ({ error })
      )
    : null;
  // Started by its login item or unit: bring that item up to this build's text.
  if (isHostModeRequested(process.argv)) void hostMode.refreshStartAtLogin();
  // Never torn down: the updater renames an AppImage after this has stopped.
  followAppImageMoves();
  return listenError;
}
