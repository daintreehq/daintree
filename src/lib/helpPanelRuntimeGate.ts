// HelpPanel mounts lazily (on first open, or at idle after hydration), but its
// lane runtimes are what subscribe to a bound assistant session's main→renderer
// events, and those listeners don't replay. A launch that spawns and binds a
// session before the panel has mounted would drop whatever arrives in between,
// so launches wait on this gate first. Module state is per V8 context, which is
// per project view — the same scope as the panel it tracks.

const DEFAULT_TIMEOUT_MS = 5000;

let mounted = false;
let requested = false;
const waiters = new Set<() => void>();
const requestListeners = new Set<() => void>();

/** Called by HelpPanel once its lane runtimes have armed their controllers. */
export function markHelpPanelRuntimeMounted(): void {
  mounted = true;
  requested = false;
  for (const resolve of waiters) resolve();
  waiters.clear();
}

export function markHelpPanelRuntimeUnmounted(): void {
  mounted = false;
}

/** AppLayout listens here to mount the panel ahead of its idle schedule. */
export function onHelpPanelRuntimeRequested(listener: () => void): () => void {
  requestListeners.add(listener);
  // A launch can ask before AppLayout has subscribed (e.g. across the
  // skeleton → hydrated remount); honour it on subscription.
  if (requested && !mounted) listener();
  return () => {
    requestListeners.delete(listener);
  };
}

/**
 * Resolve once HelpPanel is mounted, asking AppLayout to mount it now if it
 * hasn't yet. Never rejects: on timeout it resolves anyway so a launch is
 * never blocked outright by a panel that failed to load.
 */
export function ensureHelpPanelRuntime(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  if (mounted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      waiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    waiters.add(done);
    requested = true;
    for (const listener of requestListeners) listener();
  });
}

export function resetHelpPanelRuntimeGateForTests(): void {
  mounted = false;
  requested = false;
  waiters.clear();
  requestListeners.clear();
}
