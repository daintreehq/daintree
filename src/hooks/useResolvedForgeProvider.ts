import { useCallback, useEffect, useRef, useState } from "react";
import type { ForgeProviderEntry, ForgeProviderResolutionVia } from "@shared/types/forge";
import { makeForgeProviderId } from "@shared/utils/forgeProviderIds";
import { logError } from "@/utils/logger";

export interface ResolvedForgeProviderState {
  /** Resolved provider entry, or `null` when no registered provider matches. */
  entry: ForgeProviderEntry | null;
  /** Canonical `{pluginId}.{contributionId}` id, or `null` when unresolved. */
  providerId: string | null;
  resolvedVia: ForgeProviderResolutionVia | null;
  /** False once the first resolution (cached or fresh) has landed. */
  loading: boolean;
}

const UNRESOLVED: ResolvedForgeProviderState = {
  entry: null,
  providerId: null,
  resolvedVia: null,
  loading: false,
};

// Last-known resolution per project so remounts render the previous answer
// immediately instead of flashing unresolved while the round-trip is in
// flight. Invalidated wholesale on plugin provenance changes — including
// entries for projects with no mounted hook, which would otherwise serve a
// stale provider after an enable/disable while that project was unmounted.
const resolutionCache = new Map<string, ResolvedForgeProviderState>();

// Monotonic per-project resolve sequence: a slow older round-trip must not
// overwrite the CACHE entry written by a newer (e.g. provenance-triggered)
// resolve. This guard is shared across hook instances, so it must only gate
// the shared cache — never an instance's own setState. Several instances
// resolve the same project concurrently on every provenance event (Toolbar,
// ForgeStatsToolbarButton, SidebarContent, useRepositoryStats); if the shared
// seq gated setState, every instance except the last to increment would
// discard its response and keep a stale entry — a live plugin disable left
// the stats pill mounted while only the stats instance saw the change.
const resolveSeq = new Map<string, number>();

/**
 * Resolve the active forge provider for a project through the host's
 * precedence chain (per-project override → global default → hostname match).
 * Re-resolves on plugin provenance changes (enable/disable/install), so the
 * answer drops to `null` live when the owning plugin is disabled. Provider-
 * agnostic by construction — consumers must key all behavior off the returned
 * entry/id, never a hardcoded provider.
 */
export function useResolvedForgeProvider(
  projectId: string | null | undefined
): ResolvedForgeProviderState & { refresh: () => void } {
  const [state, setState] = useState<ResolvedForgeProviderState>(() =>
    projectId ? (resolutionCache.get(projectId) ?? { ...UNRESOLVED, loading: true }) : UNRESOLVED
  );

  // This instance's latest resolve call. Gates setState: only a response to
  // an older call from the SAME instance is stale for that instance. The
  // shared resolveSeq cannot serve this purpose (see its doc comment).
  const instanceSeqRef = useRef(0);

  const resolve = useCallback(async (id: string) => {
    const seq = (resolveSeq.get(id) ?? 0) + 1;
    resolveSeq.set(id, seq);
    instanceSeqRef.current = seq;
    try {
      const resolved = await window.electron.forge.resolveProvider(id);
      const entry = resolved?.entry ?? null;
      const next: ResolvedForgeProviderState = {
        entry,
        providerId: entry ? makeForgeProviderId(entry.pluginId, entry.contribution.id) : null,
        resolvedVia: resolved?.resolvedVia ?? null,
        loading: false,
      };
      if (resolveSeq.get(id) === seq) resolutionCache.set(id, next);
      if (instanceSeqRef.current !== seq) return null;
      return next;
    } catch (err) {
      if (instanceSeqRef.current !== seq) return null;
      logError("Forge provider resolution failed", err);
      const next = { ...UNRESOLVED };
      if (resolveSeq.get(id) === seq) resolutionCache.set(id, next);
      return next;
    }
  }, []);

  useEffect(() => {
    if (!projectId) {
      setState(UNRESOLVED);
      return;
    }
    let cancelled = false;
    const cached = resolutionCache.get(projectId);
    setState(cached ?? { ...UNRESOLVED, loading: true });

    const run = () => {
      void resolve(projectId).then((next) => {
        if (!cancelled && next) setState(next);
      });
    };
    run();

    const plugin = window.electron?.plugin;
    const unsubscribeProvenance =
      typeof plugin?.onProvenanceChanged === "function"
        ? plugin.onProvenanceChanged(() => {
            resolutionCache.clear();
            run();
          })
        : null;

    // A remote was added/changed/removed on this project's repo (#11155) —
    // `git remote add origin` in an already-open project used to leave the
    // toolbar pills hidden until a reload, because nothing invalidated this
    // cache. Scoped to the project that changed (unlike provenance, which
    // invalidates wholesale): a sibling project's remote says nothing about
    // this one's resolution.
    const forge = window.electron?.forge;
    const unsubscribeRemote =
      typeof forge?.onRemoteChanged === "function"
        ? forge.onRemoteChanged((payload) => {
            if (payload.projectId !== projectId) return;
            resolutionCache.delete(projectId);
            run();
          })
        : null;

    return () => {
      cancelled = true;
      unsubscribeProvenance?.();
      unsubscribeRemote?.();
    };
  }, [projectId, resolve]);

  const refresh = useCallback(() => {
    if (!projectId) return;
    resolutionCache.delete(projectId);
    void resolve(projectId).then((next) => {
      if (next) setState(next);
    });
  }, [projectId, resolve]);

  return { ...state, refresh };
}
