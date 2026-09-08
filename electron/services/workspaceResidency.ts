/**
 * Workspace residency: the user's "keep this one loaded" grant, the record of
 * views eviction has taken, and the authoritative read a bound MCP session uses
 * to find out which of those happened to it (#12313).
 *
 * A workspace-bound session routes every call through the one view its binding
 * resolves to (`getWorkspaceWebContents`), so an eviction pass taking that view
 * leaves the session `SESSION_BINDING_GONE` on everything — including the
 * surfaces it would use to ask what went wrong. The two halves here are the two
 * answers to that: a grant the *user* spends to make eviction less likely, and a
 * read that is honest about it either way.
 *
 * Deliberately NOT a floor. #11790 refused an automatic one because a client
 * could hold it just by staying connected; this is the same refusal from the
 * other side — the client cannot grant itself residency, and the grant it does
 * get still yields to memory pressure. What changes is that losing the view
 * stops being silent.
 *
 * Reachable from both `electron/window/` (eviction, view registration) and
 * `electron/services/mcp-server/` (the resource), which is why it imports only
 * the store and the view registry — both already reached directly from each
 * side, so this adds no edge either graph did not have.
 */

import { store } from "../store.js";
import { getWebContentsForProject } from "../window/webContentsRegistry.js";

/** Why a workspace's last live view went away, as eviction itself classified it. */
export type WorkspaceEvictionReason =
  "lru" | "limit-change" | "pressure" | "memory-eviction" | "crash";

/**
 * What a workspace-bound MCP session can learn about its own binding without
 * reaching a renderer.
 *
 * `routeState` mirrors `getWorkspaceWebContents`'s zero/one/many rule exactly,
 * so this resource cannot disagree with what routing would actually do — the
 * point is an authoritative read, and a second opinion would be worse than
 * none. `keepResident` reports the grant, not a promise: it says what the user
 * chose, not that a slot is reserved this instant.
 */
export interface McpWorkspaceBindingState {
  /** The bound workspace, or null for a session that binds to nothing. */
  workspaceId: string | null;
  /**
   * `unbound` — this session routes to the focused view, so there is no binding
   * to lose. `available` — exactly one live view, the route resolves.
   * `not-found` — no live view; every routed call refuses. `ambiguous` — more
   * than one live view, so the bound target is undecidable and calls refuse for
   * that reason instead.
   */
  routeState: "unbound" | "available" | "not-found" | "ambiguous";
  liveViewCount: number;
  keepResident: boolean;
  /**
   * When eviction took this workspace's last live view, or null.
   *
   * Present only while there is no live view, which is what makes it safe: it
   * is the difference between "this workspace was here and got taken" and "no
   * view of it has been open this run", the distinction a bound client could
   * not draw before and the reason a bare notification was not enough.
   */
  evictedAt: number | null;
  evictionReason: WorkspaceEvictionReason | null;
  observedAt: number;
}

interface EvictionRecord {
  at: number;
  reason: WorkspaceEvictionReason;
}

/**
 * App-lifetime, cross-window ledger of workspaces eviction has taken.
 *
 * `ProjectViewManager.evictionTimestamps` cannot serve this: it is per-window
 * and read by the switch controller for its own telemetry, so a workspace
 * evicted in one window is invisible from another, and nothing about it is
 * reachable once the view is gone. This is keyed by workspace id, which
 * outlives every view.
 *
 * At most one record per workspace, cleared the moment a view registers again.
 */
const evictions = new Map<string, EvictionRecord>();

type ResidencyListener = () => void;
const listeners = new Map<string, Set<ResidencyListener>>();

function emitResidencyChanged(workspaceId: string): void {
  const bucket = listeners.get(workspaceId);
  if (!bucket) return;
  // Copied before iterating: a listener that unsubscribes itself while being
  // notified would otherwise mutate the set mid-iteration.
  for (const listener of [...bucket]) {
    try {
      listener();
    } catch (err) {
      console.error("[residency] listener threw:", err);
    }
  }
}

/**
 * Whether the user granted `workspaceId` residency.
 *
 * Only an exact `true` counts. The record is keyed by workspace id and nothing
 * prunes it when a project is deleted, so a stale entry has to be inert — and
 * it is, twice over: eviction only ever applies this to a view that actually
 * exists, and this read refuses anything that is not the literal value written.
 */
export function isWorkspaceKeepResident(workspaceId: string): boolean {
  return (store.get("workspaceKeepResident") ?? {})[workspaceId] === true;
}

/** Set or clear the user's residency grant for `workspaceId`. */
export function setWorkspaceKeepResident(workspaceId: string, keepResident: boolean): void {
  const current = store.get("workspaceKeepResident") ?? {};
  if ((current[workspaceId] === true) === keepResident) return;
  const next = { ...current };
  if (keepResident) {
    next[workspaceId] = true;
  } else {
    // Deleted rather than stored as `false`: absence is the only "off" this key
    // has, so keeping a falsy entry would grow the record for every workspace
    // the toggle was ever flipped on and back off.
    delete next[workspaceId];
  }
  store.set("workspaceKeepResident", next);
  emitResidencyChanged(workspaceId);
}

/**
 * Record that eviction took the last live view of `workspaceId`.
 *
 * Call it *after* the view is torn down, so the liveness check below sees the
 * settled state. A second window's view of the same workspace is not affected
 * by this pass — the route still resolves there — so an eviction that leaves
 * one standing is not this workspace's eviction and is not recorded as one.
 *
 * {@link readWorkspaceBindingState} suppresses the record whenever a live view
 * exists regardless, so the read stays correct without depending on this check
 * winning any particular race; this one keeps the ledger itself from carrying a
 * reason that never applied.
 */
export function recordWorkspaceEviction(
  workspaceId: string,
  reason: WorkspaceEvictionReason
): void {
  if (getWebContentsForProject(workspaceId).length > 0) {
    // Still reachable, but the view set changed — tell subscribers to re-read.
    emitResidencyChanged(workspaceId);
    return;
  }
  evictions.set(workspaceId, { at: Date.now(), reason });
  emitResidencyChanged(workspaceId);
}

/**
 * Forget any eviction recorded for `workspaceId` — the view is back.
 *
 * Called from view registration, not from the eviction side. A subscriber that
 * reads on notification has to see the reopen, not the eviction that preceded
 * it (lesson #10821): a ledger written on the way out and never cleared would
 * let a subscribe-then-read client settle on a state the workspace has already
 * left.
 */
export function clearWorkspaceEviction(workspaceId: string): void {
  evictions.delete(workspaceId);
  emitResidencyChanged(workspaceId);
}

/**
 * Notify that `workspaceId`'s live views changed without the ledger changing —
 * an ordinary close, a window teardown, a second view opening or closing.
 *
 * Separate from the two ledger writes because those cases are not evictions and
 * must not be reported as any: the read recomputes liveness itself, so the
 * subscriber gets the truth either way.
 */
export function notifyWorkspaceViewsChanged(workspaceId: string): void {
  emitResidencyChanged(workspaceId);
}

/** Subscribe to residency changes for one workspace. Returns its unsubscribe. */
export function onWorkspaceResidencyChanged(
  workspaceId: string,
  listener: ResidencyListener
): () => void {
  let bucket = listeners.get(workspaceId);
  if (!bucket) {
    bucket = new Set();
    listeners.set(workspaceId, bucket);
  }
  bucket.add(listener);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = listeners.get(workspaceId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(workspaceId);
  };
}

/**
 * The authoritative answer for a session's own binding.
 *
 * Resolved fresh on every call — never cached, never another session's or
 * window's state (#7003). The live-view count comes from the same registry
 * routing consults, so "this read says available" and "a call would route" are
 * the same fact rather than two that can drift.
 */
export function readWorkspaceBindingState(
  boundWorkspaceId: string | null
): McpWorkspaceBindingState {
  const observedAt = Date.now();
  if (boundWorkspaceId === null) {
    return {
      workspaceId: null,
      routeState: "unbound",
      liveViewCount: 0,
      keepResident: false,
      evictedAt: null,
      evictionReason: null,
      observedAt,
    };
  }

  const liveViewCount = getWebContentsForProject(boundWorkspaceId).length;
  // A live view means the workspace is here now, whatever took an earlier one:
  // reporting a stale eviction beside it would describe a loss that has already
  // been recovered, and in a second window's case one that never applied to
  // this route at all.
  const record = liveViewCount === 0 ? (evictions.get(boundWorkspaceId) ?? null) : null;

  return {
    workspaceId: boundWorkspaceId,
    routeState: liveViewCount === 0 ? "not-found" : liveViewCount === 1 ? "available" : "ambiguous",
    liveViewCount,
    keepResident: isWorkspaceKeepResident(boundWorkspaceId),
    evictedAt: record?.at ?? null,
    evictionReason: record?.reason ?? null,
    observedAt,
  };
}

/** Test seam — drops the ledger and every subscription. */
export function __resetWorkspaceResidencyForTests(): void {
  evictions.clear();
  listeners.clear();
}
