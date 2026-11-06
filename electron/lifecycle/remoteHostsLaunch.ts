/**
 * When Remote Hosts starts at launch (#15888).
 *
 * A launch whose restored windows name a host starts it as soon as the focused
 * window is up and dials those hosts, so a window that was on a host doesn't
 * wait on every local window behind it. Any other launch starts it once the
 * restore has finished, as before, so a person with no hosts pays for nothing
 * earlier. Either way it starts once, and never after a quit has begun.
 *
 * Extracted from main.ts so the ordering can be tested; the composition root
 * supplies the dynamic import of the Remote Hosts runtime.
 */

export interface RemoteHostsRuntime {
  /**
   * `halted` turns true once a quit has begun, before the quit's stop step
   * runs: a start in flight checks it to go no further.
   */
  start(halted: () => boolean): Promise<void>;
  stop(): Promise<void>;
}

export interface RemoteHostsLaunchDeps {
  isShuttingDown(): boolean;
  /** Loads Remote Hosts and wires what its start needs, starting nothing. */
  load(): Promise<RemoteHostsRuntime>;
  /** Remote Hosts is up and no quit has begun: what follows a start. */
  onStarted(): void;
  dial(hostId: string): void;
  onError(message: string, error: unknown): void;
}

export interface RemoteHostsLaunch {
  /** Starts Remote Hosts; every caller shares the first attempt. Never rejects. */
  start(): Promise<void>;
  /** Restored windows need these hosts: start now, and dial them once up. */
  need(hostIds: readonly string[]): void;
  /** The quit's stop: nothing starts from now on, and whatever started stops. */
  stop(): Promise<void>;
}

/**
 * The hosts among `hostIds` still set up here. A saved window can name a host
 * removed since, and only a host that exists is worth starting early for.
 */
export function hostsStillSetUp(
  hostIds: readonly string[],
  hosts: readonly { id: string }[] | undefined
): string[] {
  const configured = new Set(hosts?.map((host) => host.id));
  return hostIds.filter((hostId) => configured.has(hostId));
}

export function createRemoteHostsLaunch(deps: RemoteHostsLaunchDeps): RemoteHostsLaunch {
  let stopped = false;
  let up = false;
  let runtime: RemoteHostsRuntime | null = null;
  let attempt: Promise<void> | null = null;
  const wanted = new Set<string>();
  // The quit's stop step runs once, possibly before anything here has loaded,
  // so every step re-checks rather than relying on that stop to catch it.
  const halted = (): boolean => stopped || deps.isShuttingDown();

  const dial = (hostId: string): void => {
    try {
      deps.dial(hostId);
    } catch (error) {
      deps.onError(`Couldn't dial ${hostId} for a restored window`, error);
    }
  };

  const run = async (): Promise<void> => {
    if (halted()) return;
    const loaded = await deps.load();
    if (halted()) return;
    // Published before the start resolves, so a quit during it still stops
    // whatever the start got as far as.
    runtime = loaded;
    await loaded.start(halted);
    if (halted()) return;
    up = true;
    deps.onStarted();
    for (const hostId of wanted) dial(hostId);
  };

  const start = (): Promise<void> => {
    attempt ??= run().catch((error: unknown) => {
      deps.onError("Remote Hosts failed to start", error);
    });
    return attempt;
  };

  return {
    start,
    need(hostIds) {
      if (hostIds.length === 0) return;
      for (const hostId of hostIds) {
        if (wanted.has(hostId)) continue;
        wanted.add(hostId);
        if (up && !halted()) dial(hostId);
      }
      void start();
    },
    stop() {
      stopped = true;
      return runtime?.stop() ?? Promise.resolve();
    },
  };
}
