import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { projectClient } from "@/clients";

export interface PollingLifecycleFetchContext {
  force: boolean;
  fetchId: number;
  isInvalidated: () => boolean;
}

export interface PollingLifecycleConfig {
  /**
   * Consumer-supplied fetch body. The primitive manages in-flight detection,
   * queue draining, and fetch-id invalidation; the consumer reads
   * `isInvalidated()` after every await and bails when it returns true.
   */
  fetchFn: (context: PollingLifecycleFetchContext) => Promise<void>;
  /**
   * Returns the next poll interval in ms. Called after every fetch resolves
   * via `useEffectEvent`, so the consumer can read its own refs (last error,
   * rate-limit reset, etc.) and pick a tier without re-creating the hook.
   */
  calculateNextInterval: (context: { isVisible: boolean }) => number;
  /**
   * Fires before the post-switch fetch kicks off. The consumer should reset
   * any per-project state here so the immediate refetch lands cleanly.
   */
  onProjectSwitch?: () => void;
}

export interface PollingLifecycleControl {
  scheduleNextPoll: () => void;
  refresh: (options?: { force?: boolean }) => Promise<void>;
}

interface Subscriber {
  onVisibilityVisible: () => void;
  onVisibilityHidden: () => void;
  onSidebarRefresh: () => void;
  onProjectSwitch: () => void;
}

// Module-level singleton: every consumer of `usePollingLifecycle` shares one
// `visibilitychange`, one `daintree:refresh-sidebar`, and one
// `projectClient.onSwitch` registration. Mirrors `useGlobalMinuteTicker`'s
// refcounted listener Set so a tab resume fans out to all consumers without
// each hook independently re-registering the same DOM/IPC listener.
const subscribers = new Set<Subscriber>();
let visibilityHandler: (() => void) | null = null;
let sidebarHandler: (() => void) | null = null;
let projectSwitchCleanup: (() => void) | null = null;

function fanOut(method: keyof Subscriber) {
  // Snapshot to a copy so subscribers can register/unregister inside their
  // own callbacks (defensive — current consumers don't, but the Set
  // iterator's mutation-during-iteration behaviour is undefined).
  const snapshot = Array.from(subscribers);
  for (const subscriber of snapshot) {
    try {
      subscriber[method]();
    } catch (err) {
      // Isolate per-subscriber failures so one consumer's bug can't block
      // sibling consumers from receiving the same global event. Tier 0
      // console log per CLAUDE.md — diagnostic only.
      console.warn(`usePollingLifecycle: ${method} subscriber failed`, err);
    }
  }
}

function ensureGlobalListenersInstalled() {
  if (visibilityHandler !== null) return;

  // Subscribe to the IPC channel first so a failure there doesn't leave the
  // DOM listeners installed while `projectSwitchCleanup` stays null —
  // subsequent `ensureGlobalListenersInstalled` calls would short-circuit on
  // the non-null DOM handlers and the project-switch fan-out would be
  // silently missing for the rest of the process lifetime.
  let cleanup: (() => void) | null;
  try {
    cleanup = projectClient.onSwitch(() => fanOut("onProjectSwitch"));
  } catch (err) {
    console.warn("usePollingLifecycle: failed to subscribe project switch", err);
    return;
  }

  visibilityHandler = () => {
    if (document.hidden) {
      fanOut("onVisibilityHidden");
    } else {
      fanOut("onVisibilityVisible");
    }
  };
  document.addEventListener("visibilitychange", visibilityHandler);

  sidebarHandler = () => fanOut("onSidebarRefresh");
  window.addEventListener("daintree:refresh-sidebar", sidebarHandler);

  projectSwitchCleanup = cleanup;
}

function teardownGlobalListenersIfEmpty() {
  if (subscribers.size > 0) return;
  if (visibilityHandler !== null) {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }
  if (sidebarHandler !== null) {
    window.removeEventListener("daintree:refresh-sidebar", sidebarHandler);
    sidebarHandler = null;
  }
  if (projectSwitchCleanup !== null) {
    projectSwitchCleanup();
    projectSwitchCleanup = null;
  }
}

/**
 * Test-only escape hatch — flushes the module-level subscriber Set and tears
 * down any installed global listeners. Vitest tests should call this in
 * `beforeEach` so state from a previous test (especially one that threw
 * before its `renderHook` unmounted) does not leak into the next.
 */
export function _resetPollingLifecycleForTests(): void {
  subscribers.clear();
  if (visibilityHandler !== null) {
    document.removeEventListener("visibilitychange", visibilityHandler);
    visibilityHandler = null;
  }
  if (sidebarHandler !== null) {
    window.removeEventListener("daintree:refresh-sidebar", sidebarHandler);
    sidebarHandler = null;
  }
  if (projectSwitchCleanup !== null) {
    try {
      projectSwitchCleanup();
    } catch {
      // ignore — test mocks may throw on double-cleanup
    }
    projectSwitchCleanup = null;
  }
}

/**
 * Polling lifecycle primitive shared by `useRepositoryStats` and
 * `useProjectHealth`. Owns the timer, in-flight guard, queue, and fetch-id
 * invalidation; coalesces the three global triggers
 * (`visibilitychange` / `daintree:refresh-sidebar` / project switch) into a
 * module-level fan-out so every consumer fires from one shared listener.
 *
 * Consumer keeps all state, its own `mountedRef`, and any extras (rate-limit
 * scheduling, broadcast subscriptions, disk hydration). The primitive does
 * not own state and emits zero re-renders.
 */
export function usePollingLifecycle(config: PollingLifecycleConfig): PollingLifecycleControl {
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isVisibleRef = useRef(!document.hidden);
  const inFlightRef = useRef(false);
  const queuedFetchRef = useRef<{ pending: boolean; force: boolean }>({
    pending: false,
    force: false,
  });
  const activeFetchIdRef = useRef(0);
  const invalidatedFetchIdRef = useRef<number | null>(null);
  // Per-instance alive flag — distinct from the consumer's `mountedRef`. The
  // consumer's effects clean up after the primitive's does (effects unmount
  // LIFO), so we need our own flag to prevent the post-await `scheduleNext`
  // chain from installing a fresh timer during teardown.
  const aliveRef = useRef(true);

  // Latest-config ref pattern — equivalent to `useEffectEvent` semantics but
  // with returnable identities. `useEffectEvent` cannot be assigned to a
  // variable or passed down per its lint rule, so the public `scheduleNextPoll`
  // and `refresh` use `useCallback([])` and read the live config through
  // `configRef.current` instead of capturing `config` at first render.
  const configRef = useRef<PollingLifecycleConfig>(config);
  useLayoutEffect(() => {
    configRef.current = config;
  });

  const callFetchFn = useCallback(async function callFetchFnImpl(force: boolean): Promise<void> {
    if (inFlightRef.current) {
      queuedFetchRef.current.pending = true;
      queuedFetchRef.current.force = queuedFetchRef.current.force || force;
      invalidatedFetchIdRef.current = activeFetchIdRef.current;
      return;
    }

    try {
      inFlightRef.current = true;
      activeFetchIdRef.current += 1;
      const fetchId = activeFetchIdRef.current;
      const isInvalidated = () => invalidatedFetchIdRef.current === fetchId;
      try {
        await configRef.current.fetchFn({ force, fetchId, isInvalidated });
      } catch (err) {
        // The consumer's fetchFn is responsible for surfacing its own errors
        // (setError, lastErrorRef). The primitive catches here so a throw —
        // e.g. an IPC failure on `projectClient.getCurrent()` outside the
        // consumer's inner try/catch — does not silently kill polling. Every
        // fire-and-forget call site below chains `.then(scheduleNextPoll)`
        // without a `.catch`; an uncaught rejection here would skip that
        // chain and freeze the lifecycle until the next external trigger.
        console.warn("usePollingLifecycle: fetchFn threw", err);
      }
    } finally {
      inFlightRef.current = false;
      if (aliveRef.current && queuedFetchRef.current.pending) {
        const queuedForce = queuedFetchRef.current.force;
        queuedFetchRef.current = { pending: false, force: false };
        // Named-function self-recursion — avoids referencing the outer
        // `callFetchFn` variable, which would close over a potentially
        // stale binding before useCallback returns.
        void callFetchFnImpl(queuedForce);
      }
    }
  }, []);

  const scheduleNextPoll = useCallback(
    function scheduleNextPollImpl(): void {
      if (!aliveRef.current) return;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
      const interval = configRef.current.calculateNextInterval({
        isVisible: isVisibleRef.current,
      });
      pollTimerRef.current = setTimeout(() => {
        void callFetchFn(false).then(() => {
          if (aliveRef.current) scheduleNextPollImpl();
        });
      }, interval);
    },
    [callFetchFn]
  );

  const refresh = useCallback(
    async (options?: { force?: boolean }): Promise<void> => {
      if (!aliveRef.current) return;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      await callFetchFn(options?.force ?? false);
      if (aliveRef.current) scheduleNextPoll();
    },
    [callFetchFn, scheduleNextPoll]
  );

  // Stable control object — `useCallback([])` keeps `callFetchFn` /
  // `scheduleNextPoll` / `refresh` identity-stable across renders, so a
  // single useRef-cached object captured at first render works for the
  // hook's lifetime.
  const controlRef = useRef<PollingLifecycleControl | null>(null);
  if (controlRef.current === null) {
    controlRef.current = { scheduleNextPoll, refresh };
  }

  useEffect(() => {
    aliveRef.current = true;

    const subscriber: Subscriber = {
      onVisibilityVisible: () => {
        isVisibleRef.current = true;
        if (pollTimerRef.current) {
          clearTimeout(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        void callFetchFn(false).then(() => {
          if (aliveRef.current) scheduleNextPoll();
        });
      },
      onVisibilityHidden: () => {
        isVisibleRef.current = false;
        if (pollTimerRef.current) {
          clearTimeout(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        scheduleNextPoll();
      },
      onSidebarRefresh: () => {
        void refresh({ force: true });
      },
      onProjectSwitch: () => {
        if (pollTimerRef.current) {
          clearTimeout(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        configRef.current.onProjectSwitch?.();
        void callFetchFn(false).then(() => {
          if (aliveRef.current) scheduleNextPoll();
        });
      },
    };

    subscribers.add(subscriber);
    ensureGlobalListenersInstalled();

    void callFetchFn(false).then(() => {
      if (aliveRef.current) scheduleNextPoll();
    });

    return () => {
      aliveRef.current = false;
      subscribers.delete(subscriber);
      queuedFetchRef.current = { pending: false, force: false };
      invalidatedFetchIdRef.current = null;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      teardownGlobalListenersIfEmpty();
    };
    // callFetchFn / scheduleNextPoll / refresh are identity-stable
    // (`useCallback` with stable deps), so depending on them here is a no-op
    // — they never change after first render — but listing them silences the
    // exhaustive-deps lint.
  }, [callFetchFn, refresh, scheduleNextPoll]);

  return controlRef.current;
}
