import { existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { matchesGlob, normalize, relative, resolve } from "node:path";
import parcelWatcher, {
  type AsyncSubscription,
  type BackendType,
  type Event as ParcelWatcherEvent,
  type Options,
  type SubscribeCallback,
} from "@parcel/watcher";

/**
 * @parcel/watcher 2.6.0 mutates its process-global backend registry from the
 * JavaScript thread during subscribe/unsubscribe construction and from a
 * libuv worker while the last unsubscribe completes. The registry has no
 * global lock, so overlapping lifecycle operations can corrupt it and crash
 * the process (parcel-bundler/watcher#259).
 *
 * Keep the native transitions serial on macOS/Linux while leaving every
 * established watcher fully concurrent. Windows bypasses this native backend
 * entirely below. This queue is deliberately failure-tolerant: one rejected
 * arm/teardown must not poison every watcher created afterwards.
 */
let lifecycleBusy = false;
const lifecycleQueue: Array<() => void> = [];
const lifecycleIdleWaiters = new Set<() => void>();
const liveSubscriptions = new Set<AsyncSubscription>();

function enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = (): void => {
      const next = lifecycleQueue.shift();
      if (next) {
        next();
        return;
      }
      lifecycleBusy = false;
      for (const waiter of lifecycleIdleWaiters) waiter();
      lifecycleIdleWaiters.clear();
    };

    const run = (): void => {
      lifecycleBusy = true;
      let result: Promise<T>;
      try {
        result = operation();
      } catch (error) {
        reject(error);
        finish();
        return;
      }
      void Promise.resolve(result).then(
        (value) => {
          resolve(value);
          finish();
        },
        (error: unknown) => {
          reject(error);
          finish();
        }
      );
    };

    if (lifecycleBusy) lifecycleQueue.push(run);
    else run();
  });
}

function waitForLifecycleIdle(): Promise<void> {
  if (!lifecycleBusy && lifecycleQueue.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => lifecycleIdleWaiters.add(resolve));
}

/**
 * Backend pin for every remaining `@parcel/watcher` subscription.
 *
 * `getBackend("default")` probes `WatchmanBackend::checkAvailable()` before the
 * native platform backend, and that probe is a `popen("watchman ...")`. The
 * shared-backend cache is dropped once subscriptions hit zero, so every
 * teardown-to-re-arm cycle pays the probe again. macOS short-circuits on
 * FSEvents before watchman is tested; Linux does not.
 *
 * The trade: users who happen to have watchman installed lose automatic
 * selection of it — a capability Daintree neither advertises nor tests — in
 * exchange for deterministic process behaviour. Windows subscriptions use the
 * fs.watch implementation below instead of Parcel's unsafe Windows backend.
 *
 * Platforms outside this map (BSD, where parcel compiles kqueue) are left
 * unpinned: `BackendType` has no `kqueue` member, so parcel must choose.
 */
const BACKEND_BY_PLATFORM: Partial<Record<NodeJS.Platform, BackendType>> = {
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

function slashPath(value: string): string {
  return normalize(value).replaceAll("\\", "/");
}

function isGlobPattern(value: string): boolean {
  return /[*?[\]{}()!+@]/.test(value);
}

/**
 * Compile the subset of Parcel's ignore contract used by Daintree's watcher
 * call sites. Matching stays relative for globs/RegExp values and absolute for
 * literal paths, just like @parcel/watcher's wrapper.
 */
function createWindowsIgnorePredicate(dir: string, options: Options): (path: string) => boolean {
  const root = resolve(dir);
  const matchers = (options.ignore ?? []).map<(path: string, relativePath: string) => boolean>(
    (pattern) => {
      if (pattern instanceof RegExp) {
        if (pattern.flags !== "") {
          throw new Error(
            `RegExp ignore patterns must not have flags (got /${pattern.source}/${pattern.flags}). Flags are not supported by the watcher matcher.`
          );
        }
        return (_path, relativePath) => pattern.test(relativePath);
      }

      if (isGlobPattern(pattern)) {
        const glob = pattern.replaceAll("\\", "/");
        return (_path, relativePath) => matchesGlob(relativePath, glob);
      }

      const ignoredPath = slashPath(resolve(root, pattern)).toLowerCase();
      return (path) => {
        const candidate = slashPath(path).toLowerCase();
        return candidate === ignoredPath || candidate.startsWith(`${ignoredPath}/`);
      };
    }
  );

  return (path) => {
    const relativePath = slashPath(relative(root, path));
    return matchers.some((matches) => matches(path, relativePath));
  };
}

/**
 * Windows-only replacement for @parcel/watcher subscriptions.
 *
 * @parcel/watcher 2.6.0 destroys the OVERLAPPED storage for an outstanding
 * ReadDirectoryChangesW request from a libuv worker during unsubscribe. The
 * kernel can then deliver a completion APC carrying that freed pointer
 * (parcel-bundler/watcher#262), which is the 0xC0000005 crash seen when
 * worktree monitors rotate or stop. JavaScript lifecycle serialization cannot
 * repair that native use-after-free.
 *
 * Node's recursive fs.watch uses the same Windows facility behind a lifecycle
 * implementation owned by libuv, so close() drains safely. Daintree only needs
 * a recursive dirty signal; each consumer already debounces and re-scans its
 * authoritative state. The five-minute worktree heartbeat and 90-second
 * topology poll remain the overflow/missed-event safety nets.
 */
async function subscribeWindowsWatcher(
  dir: string,
  callback: SubscribeCallback,
  options: Options
): Promise<AsyncSubscription> {
  const root = resolve(dir);
  const isIgnored = createWindowsIgnorePredicate(root, options);
  let active = true;
  const watcher: FSWatcher = fsWatch(
    root,
    { recursive: true, encoding: "utf8" },
    (eventType, filename: string | null) => {
      if (!active) return;
      const eventPath = filename === null ? root : resolve(root, filename);
      if (isIgnored(eventPath)) return;
      const type: ParcelWatcherEvent["type"] =
        eventType === "change" ? "update" : existsSync(eventPath) ? "create" : "delete";
      callback(null, [{ path: eventPath, type }]);
    }
  );

  let unsubscribePromise: Promise<void> | null = null;
  const subscription: AsyncSubscription = {
    unsubscribe(): Promise<void> {
      if (!unsubscribePromise) {
        active = false;
        liveSubscriptions.delete(subscription);
        try {
          watcher.close();
          unsubscribePromise = Promise.resolve();
        } catch (error) {
          unsubscribePromise = Promise.reject(error);
        }
      }
      return unsubscribePromise;
    },
  };

  watcher.on("error", (error) => {
    if (active) callback(error, []);
  });
  liveSubscriptions.add(subscription);
  return subscription;
}

/**
 * Subscribe through the process-wide lifecycle queue.
 *
 * The returned teardown is idempotent as well as serialized. Callers may keep
 * their existing fire-and-forget disposal style; process owners that need a
 * hard shutdown boundary can use the helpers below to await the queue.
 */
export function subscribeParcelWatcher(
  dir: string,
  callback: SubscribeCallback,
  options: Options = {}
): Promise<AsyncSubscription> {
  if (process.platform === "win32") {
    return subscribeWindowsWatcher(dir, callback, options);
  }

  return enqueueLifecycle(() =>
    parcelWatcher.subscribe(dir, callback, {
      ...options,
      ...parcelWatcherBackendOption(),
    })
  ).then((nativeSubscription) => {
    let unsubscribePromise: Promise<void> | null = null;
    const subscription: AsyncSubscription = {
      unsubscribe(): Promise<void> {
        if (!unsubscribePromise) {
          liveSubscriptions.delete(subscription);
          unsubscribePromise = enqueueLifecycle(() => nativeSubscription.unsubscribe());
        }
        return unsubscribePromise;
      },
    };
    liveSubscriptions.add(subscription);
    return subscription;
  });
}

/** Wait until every lifecycle operation already queued by callers has settled. */
export async function settleParcelWatcherLifecycle(): Promise<void> {
  for (;;) {
    await waitForLifecycleIdle();
    // Let promise continuations enqueue disposal after a superseded arm.
    await Promise.resolve();
    if (!lifecycleBusy && lifecycleQueue.length === 0) return;
  }
}

/**
 * Process-teardown helper for short-lived perf children. Product services own
 * their subscriptions individually; a child that is about to exit owns all of
 * them and must release the native backend before deleting fixtures or calling
 * process.exit().
 */
export async function closeAllParcelWatcherSubscriptions(): Promise<void> {
  for (;;) {
    await settleParcelWatcherLifecycle();
    const subscriptions = [...liveSubscriptions];
    if (subscriptions.length === 0) return;
    await Promise.allSettled(subscriptions.map((subscription) => subscription.unsubscribe()));
  }
}
