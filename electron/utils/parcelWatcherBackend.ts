import type { BackendType } from "@parcel/watcher";

/**
 * Backend pin for every `@parcel/watcher` subscription.
 *
 * `getBackend("default")` probes `WatchmanBackend::checkAvailable()` before the
 * native Windows backend, and that probe is a `popen("watchman ...")` — on
 * Windows `_popen` goes through `COMSPEC`, so each arm flashes a `cmd.exe`
 * console. The shared-backend cache is dropped once subscriptions hit zero, so
 * every teardown-to-re-arm cycle pays the probe again. macOS short-circuits on
 * FSEvents before watchman is tested; Windows and Linux do not.
 *
 * The trade: users who happen to have watchman installed lose automatic
 * selection of it — a capability Daintree neither advertises nor tests — in
 * exchange for deterministic process behaviour and no console flashes. Native
 * `ReadDirectoryChangesW` is the expected Windows backend, and the existing
 * polling fallback remains the overflow safety net.
 *
 * Platforms outside this map (BSD, where parcel compiles kqueue) are left
 * unpinned: `BackendType` has no `kqueue` member, so parcel must choose.
 */
const BACKEND_BY_PLATFORM: Partial<Record<NodeJS.Platform, BackendType>> = {
  win32: "windows",
  darwin: "fs-events",
  linux: "inotify",
};

/**
 * Subscribe options carrying the pinned backend, spreadable into a call site's
 * own options. Reads `process.platform` per call rather than at module load so
 * the pin follows the running platform under test.
 */
export function parcelWatcherBackendOption(): { backend?: BackendType } {
  const backend = BACKEND_BY_PLATFORM[process.platform];
  return backend ? { backend } : {};
}
