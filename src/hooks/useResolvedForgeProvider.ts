import { useCallback, useEffect, useState } from "react";
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
// flight. Invalidated wholesale on plugin provenance changes.
const resolutionCache = new Map<string, ResolvedForgeProviderState>();

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
    projectId
      ? (resolutionCache.get(projectId) ?? { ...UNRESOLVED, loading: true })
      : UNRESOLVED
  );

  const resolve = useCallback(async (id: string) => {
    try {
      const resolved = await window.electron.forge.resolveProvider(id);
      const entry = resolved?.entry ?? null;
      const next: ResolvedForgeProviderState = {
        entry,
        providerId: entry ? makeForgeProviderId(entry.pluginId, entry.contribution.id) : null,
        resolvedVia: resolved?.resolvedVia ?? null,
        loading: false,
      };
      resolutionCache.set(id, next);
      return next;
    } catch (err) {
      logError("Forge provider resolution failed", err);
      const next = { ...UNRESOLVED };
      resolutionCache.set(id, next);
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
        if (!cancelled) setState(next);
      });
    };
    run();

    const plugin = window.electron?.plugin;
    const unsubscribe =
      typeof plugin?.onProvenanceChanged === "function"
        ? plugin.onProvenanceChanged(() => {
            resolutionCache.delete(projectId);
            run();
          })
        : null;

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [projectId, resolve]);

  const refresh = useCallback(() => {
    if (!projectId) return;
    resolutionCache.delete(projectId);
    void resolve(projectId).then(setState);
  }, [projectId, resolve]);

  return { ...state, refresh };
}
