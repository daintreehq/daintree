import { events } from "../events.js";
import { getProjectPresenceTracker } from "../ProjectPresenceTracker.js";
import {
  PLUGIN_EVENT_ROUTE_COALESCE_MS,
  PLUGIN_EVENT_ROUTE_MAX_PENDING,
  PLUGIN_EVENT_ROUTE_MAX_WORKTREE_PROJECTS,
  PLUGIN_EVENT_ROUTE_MIN_INTERVAL_MS,
  PLUGIN_SUBSCRIPTION_DEFAULT_DEBOUNCE_MS,
} from "../../../shared/config/pluginBudgets.js";
import type { AgentStateChangePayload } from "../../../shared/utils/pluginAgentSnapshot.js";
import type {
  PluginEventRoute,
  PluginEventRouteWake,
  PluginHostBinding,
  PluginWorktreeSnapshot,
  PluginWorktreesChange,
} from "../../../shared/types/plugin.js";
import {
  createPluginEventScope,
  type PluginEventScopeDeps,
  type PluginWorktreeEventPayload,
} from "./pluginEventScope.js";
import {
  createSubscriptionCoalescer,
  WorktreeChangeTracker,
} from "./pluginSubscriptionCoalescing.js";

/** Builds a wake when its turn comes, or says there is nothing left to deliver. */
type TakeWake = () => PluginEventRouteWake | null;

export interface RouteWakeScheduler {
  /** Hold a wake under `key`, replacing any not yet delivered under the same key. */
  offer(key: string, take: TakeWake): void;
  /** Drop the wake waiting under `key`, if any. */
  cancel(key: string): void;
  /** Whether a wake is waiting under `key` (one already running is not). */
  has(key: string): boolean;
  dispose(): void;
}

export interface RouteWakeSchedulerOptions {
  /** Runs one wake. Wakes run one at a time; a rejection is the caller's to have logged. */
  run: (wake: PluginEventRouteWake) => Promise<void>;
  /** While true, nothing is held or run: what was waiting is dropped, not replayed. */
  suspended: () => boolean;
  coalesceMs?: number;
  minIntervalMs?: number;
  maxPending?: number;
}

/**
 * One plugin instance's wake queue: latest value per key, one wake running at
 * a time, starts spaced by a minimum interval. Bounded by key count rather
 * than event count, so a sustained stream costs a slot per terminal or project
 * and never grows a backlog.
 */
export function createRouteWakeScheduler(options: RouteWakeSchedulerOptions): RouteWakeScheduler {
  const coalesceMs = options.coalesceMs ?? PLUGIN_EVENT_ROUTE_COALESCE_MS;
  const minIntervalMs = options.minIntervalMs ?? PLUGIN_EVENT_ROUTE_MIN_INTERVAL_MS;
  const maxPending = options.maxPending ?? PLUGIN_EVENT_ROUTE_MAX_PENDING;
  // Insertion-ordered, and `set` on an existing key keeps its place: a key
  // whose value keeps changing is not pushed behind keys that arrived later.
  const pending = new Map<string, TakeWake>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let lastStart = Number.NEGATIVE_INFINITY;
  let disposed = false;

  const drop = (): void => {
    pending.clear();
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const arm = (): void => {
    if (disposed || running || timer || pending.size === 0) return;
    // Monotonic: a wall-clock rollback must not push a wake out.
    const now = performance.now();
    const at = Math.max(now + coalesceMs, lastStart + minIntervalMs);
    timer = setTimeout(fire, at - now);
  };

  const fire = (): void => {
    timer = null;
    if (disposed) return;
    if (options.suspended()) {
      drop();
      return;
    }
    for (const [key, take] of pending) {
      pending.delete(key);
      let wake: PluginEventRouteWake | null;
      try {
        wake = take();
      } catch (err) {
        console.error("[PluginEventRoutes] Building a wake failed:", err);
        continue;
      }
      // Nothing left to say for this key: it costs no interval.
      if (wake === null) continue;
      running = true;
      lastStart = performance.now();
      void options
        .run(wake)
        .catch((err: unknown) => {
          console.error("[PluginEventRoutes] Running a wake failed:", err);
        })
        .finally(() => {
          running = false;
          arm();
        });
      return;
    }
  };

  return {
    offer: (key, take) => {
      if (disposed) return;
      if (options.suspended()) {
        drop();
        return;
      }
      if (!pending.has(key) && pending.size >= maxPending) {
        const oldest = pending.keys().next();
        if (!oldest.done) pending.delete(oldest.value);
      }
      pending.set(key, take);
      arm();
    },
    cancel: (key) => {
      pending.delete(key);
    },
    has: (key) => pending.has(key),
    dispose: () => {
      disposed = true;
      drop();
    },
  };
}

/** A worktree route's change across the reads since its wake was offered. */
interface GatheredWorktreeChange {
  added: Set<string>;
  removed: Set<string>;
  changed: Set<string>;
}

function emptyGatheredChange(): GatheredWorktreeChange {
  return { added: new Set(), removed: new Set(), changed: new Set() };
}

/**
 * Fold one read's diff into a gathered change so it stays the net change
 * across both: added then removed is nothing, removed then added is a change.
 */
function gatherWorktreeChange(into: GatheredWorktreeChange, diff: PluginWorktreesChange): void {
  for (const id of diff.added) {
    if (into.removed.delete(id)) into.changed.add(id);
    else into.added.add(id);
  }
  for (const id of diff.removed) {
    into.changed.delete(id);
    if (!into.added.delete(id)) into.removed.add(id);
  }
  for (const id of diff.changed) {
    if (!into.added.has(id)) into.changed.add(id);
  }
}

export interface PluginEventRouteDeps extends PluginEventScopeDeps {
  /**
   * Listen for a raw worktree event WITHOUT recording it as one of the
   * plugin's live subscriptions: those keep a worker from being disposed while
   * idle, and a route must not.
   */
  attachWorktreeEvent: (
    event: "worktree-update" | "worktree-removed",
    handler: (payload?: PluginWorktreeEventPayload) => void
  ) => () => void;
  /** Whether this instance's worker has failed (a crash loop included). */
  isWorkerFailed: (pluginId: string) => boolean;
  /** Run the routed command for one wake. */
  dispatch: (actionId: string, wake: PluginEventRouteWake) => Promise<void>;
}

export interface PluginEventRoutes {
  dispose(): void;
}

type WorktreeRouteEvent = "worktreeAdded" | "worktreeRemoved";

/**
 * Listen, on the host side, for the events a plugin's manifest routes and run
 * the routed command when one happens (#13816). Nothing here touches the
 * plugin's worker or counts as one of its live subscriptions, so a plugin that
 * reacts only through routes stays eligible for idle disposal; the dispatch
 * activates it again on the next wake.
 *
 * Each event goes through the same scope as its live subscription — the same
 * binding filter, capability check and payload projection — and fires on the
 * transition only: nothing is replayed when the routes are created.
 */
export function createPluginEventRoutes(
  deps: PluginEventRouteDeps,
  pluginId: string,
  binding: PluginHostBinding,
  routes: readonly PluginEventRoute[]
): PluginEventRoutes {
  const scope = createPluginEventScope(deps, pluginId, binding);
  const commandFor = new Map(routes.map((route) => [route.event, `${pluginId}.${route.command}`]));
  const disposers: Array<() => void> = [];
  let disposed = false;

  const suspended = (): boolean => disposed || !scope.isBound() || deps.isWorkerFailed(pluginId);
  const scheduler = createRouteWakeScheduler({
    suspended,
    run: async (wake) => {
      const actionId = commandFor.get(wake.event);
      if (actionId === undefined || disposed || !scope.isBound()) return;
      await deps.dispatch(actionId, wake);
    },
  });
  disposers.push(() => scheduler.dispose());

  if (commandFor.has("agentWaiting")) {
    const onAgentState = (payload: AgentStateChangePayload): void => {
      if (disposed || !scope.isBound()) return;
      // Re-read per event, like the subscription's gate at registration: the
      // capability set is the plugin's declared one, not a snapshot.
      if (!scope.canObserveAgents()) return;
      const transition = scope.projectAgentTransition(payload);
      if (transition === null) return;
      const { snapshot, key } = transition;
      const slot = `agentWaiting:${key}`;
      if (snapshot.state !== "waiting") {
        // Stopped waiting before the wake ran: there is nothing to answer.
        scheduler.cancel(slot);
        return;
      }
      if (snapshot.previousState === "waiting") return;
      scheduler.offer(slot, () =>
        Object.freeze({ event: "agentWaiting" as const, agent: snapshot })
      );
    };
    // The bus is a plain EventEmitter: a throw here would stop every listener
    // registered after this one from hearing the transition.
    const handler = (payload: AgentStateChangePayload): void => {
      try {
        onAgentState(payload);
      } catch (err) {
        console.error(`[PluginEventRoutes] agentWaiting route for "${pluginId}" failed:`, err);
      }
    };
    disposers.push(events.on("agent:state-changed", handler));
  }

  if (commandFor.has("projectForeground")) {
    const unsubscribe = getProjectPresenceTracker().subscribe((changes) => {
      if (disposed || !scope.isBound()) return;
      for (const presence of changes) {
        if (!scope.seesProjectPresence(presence.projectId)) continue;
        const slot = `projectForeground:${presence.projectId}`;
        // The tracker reports transitions only, so "foreground" here is an
        // arrival; anything else means it left before the wake ran.
        if (presence.state !== "foreground") {
          scheduler.cancel(slot);
          continue;
        }
        scheduler.offer(slot, () =>
          Object.freeze({ event: "projectForeground" as const, presence })
        );
      }
    });
    disposers.push(unsubscribe);
  }

  const worktreeEvents = (["worktreeAdded", "worktreeRemoved"] as const).filter((event) =>
    commandFor.has(event)
  );
  if (worktreeEvents.length > 0) {
    disposers.push(watchWorktrees(worktreeEvents));
  }

  /**
   * The worktree routes. Every read is the live subscription's own read and
   * projection, diffed against the previous read of the same project, so each
   * add and each removal is seen as it happens however far apart they are. A
   * route's `change` gathers those diffs while its wake waits, which is how an
   * add removed again before the wake runs cancels it; a route with nothing
   * waiting starts again from the current read, so a change whose wake was
   * dropped (the worker failed, the interval was full) is never replayed later.
   *
   * A project's first successful read only sets its base: a plugin loading, the
   * workspace host restarting, or an installed plugin's focus moving to a
   * project it has not seen must not read as worktrees appearing.
   */
  function watchWorktrees(routed: readonly WorktreeRouteEvent[]): () => void {
    // The last set read per project, most recently seen last.
    const observed = new Map<string, WorktreeChangeTracker>();
    // Each route's gathered change for the project in `latest`, kept only
    // while a wake for it waits in the scheduler.
    const gathered = new Map<WorktreeRouteEvent, GatheredWorktreeChange>();
    let latest: { projectId: string; worktrees: readonly PluginWorktreeSnapshot[] } | null = null;
    let chain: Promise<void> = Promise.resolve();
    // An event arrived while wakes were suspended. The read it leads to must
    // still move the baseline on, but may not wake the plugin even if the
    // worker recovered before that read ran.
    let heardWhileSuspended = false;

    const observe = (
      projectId: string,
      worktrees: readonly PluginWorktreeSnapshot[]
    ): PluginWorktreesChange | null => {
      const existing = observed.get(projectId);
      if (existing) {
        observed.delete(projectId);
        observed.set(projectId, existing);
        return existing.next(worktrees);
      }
      const tracker = new WorktreeChangeTracker();
      tracker.next(worktrees);
      observed.set(projectId, tracker);
      if (observed.size > PLUGIN_EVENT_ROUTE_MAX_WORKTREE_PROJECTS) {
        const oldest = observed.keys().next();
        if (!oldest.done) observed.delete(oldest.value);
      }
      return null;
    };

    const relevant = (event: WorktreeRouteEvent, change: GatheredWorktreeChange): boolean =>
      (event === "worktreeAdded" ? change.added : change.removed).size > 0;

    const takeFor =
      (event: WorktreeRouteEvent): TakeWake =>
      () => {
        // Built from the newest read, so a wake held back by the interval
        // reports where things ended up, not where they were when it queued.
        const current = latest;
        const change = gathered.get(event);
        gathered.delete(event);
        if (current === null || change === undefined || !relevant(event, change)) return null;
        return Object.freeze({
          event,
          worktrees: current.worktrees,
          change: Object.freeze({
            added: Object.freeze([...change.added]),
            removed: Object.freeze([...change.removed]),
            changed: Object.freeze([...change.changed]),
          }),
        });
      };

    const reconcile = async (): Promise<void> => {
      if (disposed || !scope.isBound()) return;
      const missed = heardWhileSuspended;
      heardWhileSuspended = false;
      const result = await scope.fetchWorktreeSnapshotsResult();
      if (disposed || !scope.isBound()) return;
      // An unavailable read says nothing about which worktrees exist; treating
      // it as an empty set would report every worktree removed.
      if (result.status !== "ok") return;
      const worktrees = Object.freeze(result.snapshots.map(scope.pluginProjectionFor(result)));
      const switched = latest !== null && latest.projectId !== result.projectId;
      latest = { projectId: result.projectId, worktrees };
      const diff = observe(result.projectId, worktrees);
      if (missed || suspended()) {
        for (const event of routed) {
          gathered.delete(event);
          scheduler.cancel(event);
        }
        return;
      }
      for (const event of routed) {
        // Start over from this read when no wake is waiting (one that was
        // dropped must not come back), when this read only seeded a project,
        // or when focus moved: a change gathered for the project it left
        // would describe a set the plugin can no longer read.
        if (diff === null || switched || !scheduler.has(event)) gathered.delete(event);
        if (diff === null) {
          scheduler.cancel(event);
          continue;
        }
        const change = gathered.get(event) ?? emptyGatheredChange();
        gatherWorktreeChange(change, diff);
        if (relevant(event, change)) {
          gathered.set(event, change);
          scheduler.offer(event, takeFor(event));
        } else {
          gathered.delete(event);
          scheduler.cancel(event);
        }
      }
    };

    // Serialised like the subscription's reads, so a slow read can never land
    // after a newer one and leave the routes on the older set.
    const enqueue = (): void => {
      chain = chain.then(reconcile).catch((err: unknown) => {
        console.error(`[PluginEventRoutes] Worktree read for "${pluginId}" failed:`, err);
      });
    };
    const coalescer = createSubscriptionCoalescer(PLUGIN_SUBSCRIPTION_DEFAULT_DEBOUNCE_MS, enqueue);
    const onEvent = (payload?: PluginWorktreeEventPayload): void => {
      if (disposed || !scope.isEventForBoundProject(payload)) return;
      if (suspended()) heardWhileSuspended = true;
      coalescer.push();
    };
    const detachUpdate = deps.attachWorktreeEvent("worktree-update", onEvent);
    const detachRemove = deps.attachWorktreeEvent("worktree-removed", onEvent);
    // Attached before the first read, so a change between the two is not lost.
    enqueue();
    return () => {
      coalescer.dispose();
      detachUpdate();
      detachRemove();
      observed.clear();
      gathered.clear();
      latest = null;
    };
  }

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch (err) {
          console.error(`[PluginEventRoutes] Disposing routes for "${pluginId}" failed:`, err);
        }
      }
    },
  };
}
