import { useCallback, useSyncExternalStore } from "react";
import type {
  ForgeIssueProviderResolutionVia,
  ForgeProviderEntry,
  ForgeProviderResolutionVia,
} from "@shared/types/forge";
import { makeForgeProviderId } from "@shared/utils/forgeProviderIds";
import { issuesSelection } from "@shared/utils/forgeProviderRoles";
import { logError } from "@/utils/logger";
import { discardCachedResources } from "@/lib/forgeResourceCache";

export interface ResolvedForgeIssuesState {
  /** Provider serving the project's issues, or `null` when none does. */
  entry: ForgeProviderEntry | null;
  /** Canonical `{pluginId}.{contributionId}` id, or `null` when unresolved. */
  providerId: string | null;
  resolvedVia: ForgeIssueProviderResolutionVia | null;
}

export interface ResolvedForgeProviderState {
  /**
   * The code forge — PRs, CI, repository stats — or `null` when no registered
   * provider matches. Read {@link issues} for anything about issues: a project
   * can bind its issues to a different provider (#13700).
   */
  entry: ForgeProviderEntry | null;
  /** Canonical `{pluginId}.{contributionId}` id, or `null` when unresolved. */
  providerId: string | null;
  resolvedVia: ForgeProviderResolutionVia | null;
  /** The issues role. Same as the code forge unless the project binds another. */
  issues: ResolvedForgeIssuesState;
  /** False once the first resolution (cached or fresh) has landed. */
  loading: boolean;
}

const NO_ISSUES: ResolvedForgeIssuesState = { entry: null, providerId: null, resolvedVia: null };

const UNRESOLVED: ResolvedForgeProviderState = {
  entry: null,
  providerId: null,
  resolvedVia: null,
  issues: NO_ISSUES,
  loading: false,
};

const LOADING: ResolvedForgeProviderState = { ...UNRESOLVED, loading: true };

// Last-known resolution per project: what every consumer of the project reads,
// so remounts render the previous answer immediately instead of flashing
// unresolved while the round-trip is in flight. A project with consumers keeps
// its answer through an invalidation until the replacement lands; one with
// none drops it, so it can't serve a stale provider after an enable/disable
// that happened while nothing showed it.
const resolutionCache = new Map<string, ResolvedForgeProviderState>();

// Consumers per project. Every worktree card holds several (its badges, its
// details), so the state, the invalidation listeners and the response handling
// are shared per project rather than owned per hook instance (#17072).
const projectListeners = new Map<string, Set<() => void>>();

// Last issues provider each project resolved to. Unlike `resolutionCache` it
// survives invalidation — an invalidation is exactly when the binding may have
// changed, and the change is what tells cached issue rows to go.
const lastIssuesProvider = new Map<string, string | null>();

// Monotonic per-project resolve sequence: a slow older round-trip must not
// overwrite the answer written by a newer (e.g. provenance-triggered) resolve.
const resolveSeq = new Map<string, number>();

type ForgeProviderResolution = Awaited<ReturnType<typeof window.electron.forge.resolveProvider>>;

// Per-project in-flight resolution. Each resolveProvider IPC reaches
// `GitService.listRemotes` and spawns its own `git remote -v` in main (#12042),
// so a resolve that starts while another is out joins it. The map holds only
// genuinely concurrent calls: the entry is evicted on settlement
// (identity-guarded, so a late eviction can't drop a newer entry) rather than
// TTL-cached, leaving the settled-value `resolutionCache` as the only thing
// that outlives a round-trip. Invalidations drop the in-flight entry BEFORE
// re-running, so a post-invalidation caller can never join a request that
// predates the change.
const inFlightResolutions = new Map<string, Promise<ForgeProviderResolution>>();

function resolveProviderOnce(id: string): Promise<ForgeProviderResolution> {
  const existing = inFlightResolutions.get(id);
  if (existing) return existing;
  const request = window.electron.forge.resolveProvider(id);
  inFlightResolutions.set(id, request);
  void request
    .catch(() => undefined)
    .finally(() => {
      if (inFlightResolutions.get(id) === request) inFlightResolutions.delete(id);
    });
  return request;
}

// Invalidations — a provenance or remote event, a manual refresh — discard the
// in-flight request once per synchronous burst: the first drops the
// pre-invalidation request, and any other in the same burst joins the fresh one
// it started. The marker clears on the microtask after the burst, so the next
// genuine invalidation discards again.
const discardedThisBurst = new Set<string>();

function discardInFlightResolution(id: string): void {
  if (discardedThisBurst.has(id)) return;
  if (discardedThisBurst.size === 0) {
    queueMicrotask(() => discardedThisBurst.clear());
  }
  discardedThisBurst.add(id);
  inFlightResolutions.delete(id);
}

function toResolvedState(resolved: ForgeProviderResolution): ResolvedForgeProviderState {
  const entry = resolved?.entry ?? null;
  const issues = resolved ? issuesSelection(resolved) : null;
  return {
    entry,
    providerId: entry ? makeForgeProviderId(entry.pluginId, entry.contribution.id) : null,
    resolvedVia: resolved?.resolvedVia ?? null,
    issues: issues?.entry
      ? {
          entry: issues.entry,
          providerId: makeForgeProviderId(issues.entry.pluginId, issues.entry.contribution.id),
          resolvedVia: issues.resolvedVia,
        }
      : NO_ISSUES,
    loading: false,
  };
}

function publish(id: string, next: ResolvedForgeProviderState): void {
  resolutionCache.set(id, next);
  const listeners = projectListeners.get(id);
  if (!listeners) return;
  for (const listener of [...listeners]) listener();
}

function resolveProject(id: string): void {
  const seq = (resolveSeq.get(id) ?? 0) + 1;
  resolveSeq.set(id, seq);
  let request: Promise<ForgeProviderResolution>;
  try {
    request = resolveProviderOnce(id);
  } catch (err) {
    request = Promise.reject(err);
  }
  request.then(
    (resolved) => {
      if (resolveSeq.get(id) !== seq) return;
      const next = toResolvedState(resolved);
      // Cached issue rows belong to whichever provider served them; once the
      // project's issues come from somewhere else they're another tracker's.
      const previousIssuesProvider = lastIssuesProvider.get(id);
      if (
        previousIssuesProvider !== undefined &&
        previousIssuesProvider !== next.issues.providerId
      ) {
        discardCachedResources("issue");
      }
      lastIssuesProvider.set(id, next.issues.providerId);
      publish(id, next);
    },
    (err: unknown) => {
      if (resolveSeq.get(id) !== seq) return;
      logError("Forge provider resolution failed", err);
      publish(id, UNRESOLVED);
    }
  );
}

// A request still out when nothing will hear what invalidates it can't be
// trusted to answer the next consumer: stop sharing it, and let its answer land
// nowhere.
function abandonRequest(id: string): void {
  inFlightResolutions.delete(id);
  const seq = resolveSeq.get(id);
  if (seq !== undefined) resolveSeq.set(id, seq + 1);
}

function forgetUnwatched(id: string): void {
  resolutionCache.delete(id);
  abandonRequest(id);
}

function handleProvenanceChanged(): void {
  for (const id of new Set([...resolutionCache.keys(), ...inFlightResolutions.keys()])) {
    if (!projectListeners.has(id)) forgetUnwatched(id);
  }
  for (const id of projectListeners.keys()) {
    // A resolution already in flight answers the pre-change registry;
    // joining it would hand every consumer a stale provider.
    discardInFlightResolution(id);
    resolveProject(id);
  }
}

// A remote was added/changed/removed on a project's repo (#11155) — `git remote
// add origin` in an already-open project used to leave the toolbar pills hidden
// until a reload, because nothing invalidated this cache. Scoped to the project
// that changed (unlike provenance, which invalidates wholesale): a sibling
// project's remote says nothing about this one's resolution.
function handleRemoteChanged(payload: { projectId: string }): void {
  const id = payload.projectId;
  if (!projectListeners.has(id)) {
    forgetUnwatched(id);
    return;
  }
  discardInFlightResolution(id);
  resolveProject(id);
}

// One provenance and one remote-change listener for the whole renderer, held
// while any project has a consumer. Events that land while it is detached are
// covered by the fresh resolve every project gets when its first consumer
// mounts.
let detachInvalidationListeners: (() => void) | null = null;

function attachInvalidationListeners(): void {
  if (detachInvalidationListeners) return;
  const plugin = window.electron?.plugin;
  const offProvenance =
    typeof plugin?.onProvenanceChanged === "function"
      ? plugin.onProvenanceChanged(handleProvenanceChanged)
      : null;
  const forge = window.electron?.forge;
  const offRemote =
    typeof forge?.onRemoteChanged === "function"
      ? forge.onRemoteChanged(handleRemoteChanged)
      : null;
  detachInvalidationListeners = () => {
    offProvenance?.();
    offRemote?.();
  };
}

function subscribeToProject(id: string, listener: () => void): () => void {
  let listeners = projectListeners.get(id);
  const isFirstConsumer = !listeners;
  if (!listeners) {
    listeners = new Set();
    projectListeners.set(id, listeners);
  }
  listeners.add(listener);
  attachInvalidationListeners();
  // Later consumers read the answer the first one asked for. Remounting after
  // every consumer left asks again, since events went unheard in between.
  if (isFirstConsumer) resolveProject(id);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && projectListeners.get(id) === listeners) {
      projectListeners.delete(id);
    }
    if (projectListeners.size === 0) queueMicrotask(releaseInvalidationListeners);
  };
}

// Deferred a microtask: StrictMode replays every consumer's unmount and remount
// inside one commit, and letting go in between would abandon, and so double,
// every first request.
function releaseInvalidationListeners(): void {
  if (projectListeners.size > 0 || !detachInvalidationListeners) return;
  detachInvalidationListeners();
  detachInvalidationListeners = null;
  for (const id of [...inFlightResolutions.keys()]) abandonRequest(id);
}

function noopUnsubscribe(): void {}

/**
 * Resolve the active forge providers for a project — the code forge through
 * the host's precedence chain (per-project override → global default →
 * hostname match), and the issues provider beside it, in one round-trip.
 * Re-resolves on plugin provenance changes (enable/disable/install), so the
 * answer drops to `null` live when the owning plugin is disabled. Provider-
 * agnostic by construction — consumers must key all behavior off the returned
 * entry/id, never a hardcoded provider.
 *
 * Every consumer of a project shares one answer, one in-flight request and the
 * renderer's single pair of invalidation listeners.
 */
export function useResolvedForgeProvider(
  projectId: string | null | undefined
): ResolvedForgeProviderState & { refresh: () => void } {
  const id = projectId || null;
  const subscribe = useCallback(
    (listener: () => void) => (id ? subscribeToProject(id, listener) : noopUnsubscribe),
    [id]
  );
  const getSnapshot = () => (id ? (resolutionCache.get(id) ?? LOADING) : UNRESOLVED);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refresh = useCallback(() => {
    if (!id) return;
    // Manual refresh means "ignore what we have", including a round-trip that
    // started before the user asked.
    discardInFlightResolution(id);
    resolveProject(id);
  }, [id]);

  return { ...state, refresh };
}

/** @internal Tests only. Unmount every consumer first. */
export function _resetResolvedForgeProviderForTesting(): void {
  detachInvalidationListeners?.();
  detachInvalidationListeners = null;
  projectListeners.clear();
  resolutionCache.clear();
  lastIssuesProvider.clear();
  inFlightResolutions.clear();
  discardedThisBurst.clear();
  // Bumped rather than cleared, so a response still out from before the reset
  // can never match a sequence a later resolve hands out.
  for (const [id, seq] of resolveSeq) resolveSeq.set(id, seq + 1);
}
