import { useState, useCallback, useRef, useEffect } from "react";
import type { IssueTooltipData, PRTooltipData } from "@shared/types/forge";
import { TtlCache } from "@/utils/ttlCache";
import { forgeClient } from "@/clients";
import { useProjectStore } from "@/store/projectStore";
import { useResolvedForgeProvider } from "@/hooks/useResolvedForgeProvider";

type TooltipState<T> = {
  data: T | null;
  loading: boolean;
  error: boolean;
};

const TOOLTIP_CACHE_MAX = 100;
const TOOLTIP_CACHE_TTL = 300_000; // 5 minutes, matching backend TTL

const issueCache = new TtlCache<string, IssueTooltipData>(TOOLTIP_CACHE_MAX, TOOLTIP_CACHE_TTL);
const prCache = new TtlCache<string, PRTooltipData>(TOOLTIP_CACHE_MAX, TOOLTIP_CACHE_TTL);

// Bumped by invalidateForgeTooltipCaches (see bottom of file). Each fetch
// captures the generation it started in so a response that predates a refresh
// can't repopulate a cache that refresh just cleared.
let cacheGeneration = 0;

// Per-provider credential presence. Short TTL: a token saved in Settings
// becomes visible to badges within this window (the forge credential surface
// has no push event, so a bounded poll-on-mount is the trade-off).
const CREDENTIAL_STATUS_TTL = 30_000;
const credentialStatusCache = new TtlCache<string, boolean>(16, CREDENTIAL_STATUS_TTL);

/**
 * Provider-resolution + credential gate shared by the issue/PR tooltip hooks.
 * Fetching is enabled only once a forge provider resolves for the current
 * project; `missingCredential` drives the badges' "connect your forge" state
 * (the WCAG-relevant affordance the old `missingToken` flag provided).
 */
function useForgeTooltipGate() {
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const { entry, providerId } = useResolvedForgeProvider(projectId);
  const [hasCredential, setHasCredential] = useState<boolean | null>(() =>
    providerId ? (credentialStatusCache.get(providerId) ?? null) : null
  );

  useEffect(() => {
    if (!providerId) {
      setHasCredential(null);
      return;
    }
    const cached = credentialStatusCache.get(providerId);
    if (cached !== undefined) {
      setHasCredential(cached);
      return;
    }
    let cancelled = false;
    window.electron.forge
      .getCredentialStatus(providerId)
      .then((status) => {
        credentialStatusCache.set(providerId, status.hasCredential);
        if (!cancelled) setHasCredential(status.hasCredential);
      })
      .catch(() => {
        // Unknown status — don't block fetches; failures surface as the
        // tooltip's generic error state instead.
        if (!cancelled) setHasCredential(null);
      });
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  return {
    providerResolved: entry !== null,
    providerId,
    missingCredential: entry !== null && hasCredential === false,
  };
}

const inFlightIssues = new Map<string, Promise<IssueTooltipData | null>>();

export function useIssueTooltip(cwd: string | undefined, issueNumber: number | undefined) {
  const [state, setState] = useState<TooltipState<IssueTooltipData>>({
    data: null,
    loading: false,
    error: false,
  });
  const mountedRef = useRef(true);
  const { providerResolved, providerId, missingCredential } = useForgeTooltipGate();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchTooltip = useCallback(async () => {
    if (!cwd || !issueNumber || !providerResolved || missingCredential) return;

    const cacheKey = `${cwd}:${issueNumber}`;
    const cached = issueCache.get(cacheKey);
    if (cached) {
      setState({ data: cached, loading: false, error: false });
      return;
    }

    const inFlight = inFlightIssues.get(cacheKey);
    if (inFlight) {
      setState((prev) => ({ ...prev, loading: true, error: false }));
      try {
        const data = await inFlight;
        if (!mountedRef.current) return;
        if (data) {
          setState({ data, loading: false, error: false });
        } else {
          setState({ data: null, loading: false, error: true });
        }
      } catch {
        if (!mountedRef.current) return;
        setState({ data: null, loading: false, error: true });
      }
      return;
    }

    setState((prev) => ({ ...prev, loading: true, error: false }));

    const generation = cacheGeneration;
    const promise = (async () => {
      const data = await forgeClient.getIssueTooltip(cwd, issueNumber);
      // A sidebar refresh landed while this was in flight: the response predates
      // the invalidation, so writing it back would re-poison the cache the
      // refresh just cleared and the next hover would serve pre-refresh data.
      if (data && generation === cacheGeneration) {
        issueCache.set(cacheKey, data);
      }
      return data;
    })();

    inFlightIssues.set(cacheKey, promise);
    // Identity-checked so a settled pre-refresh promise can't evict the newer
    // request that replaced it under the same key.
    const clearInFlight = () => {
      if (inFlightIssues.get(cacheKey) === promise) inFlightIssues.delete(cacheKey);
    };
    promise.then(clearInFlight, clearInFlight);

    try {
      const data = await promise;
      if (!mountedRef.current) return;
      if (data) {
        setState({ data, loading: false, error: false });
      } else {
        setState({ data: null, loading: false, error: true });
      }
    } catch {
      if (!mountedRef.current) return;
      setState({ data: null, loading: false, error: true });
    }
  }, [cwd, issueNumber, providerResolved, missingCredential]);

  const reset = useCallback(() => {
    setState({ data: null, loading: false, error: false });
  }, []);

  return { ...state, missingCredential, providerId, fetchTooltip, reset };
}

const inFlightPRs = new Map<string, Promise<PRTooltipData | null>>();

export function usePRTooltip(cwd: string | undefined, prNumber: number | undefined) {
  const [state, setState] = useState<TooltipState<PRTooltipData>>({
    data: null,
    loading: false,
    error: false,
  });
  const mountedRef = useRef(true);
  const { providerResolved, providerId, missingCredential } = useForgeTooltipGate();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchTooltip = useCallback(async () => {
    if (!cwd || !prNumber || !providerResolved || missingCredential) return;

    const cacheKey = `${cwd}:${prNumber}`;
    const cached = prCache.get(cacheKey);
    if (cached) {
      setState({ data: cached, loading: false, error: false });
      return;
    }

    const inFlight = inFlightPRs.get(cacheKey);
    if (inFlight) {
      setState((prev) => ({ ...prev, loading: true, error: false }));
      try {
        const data = await inFlight;
        if (!mountedRef.current) return;
        if (data) {
          setState({ data, loading: false, error: false });
        } else {
          setState({ data: null, loading: false, error: true });
        }
      } catch {
        if (!mountedRef.current) return;
        setState({ data: null, loading: false, error: true });
      }
      return;
    }

    setState((prev) => ({ ...prev, loading: true, error: false }));

    const generation = cacheGeneration;
    const promise = (async () => {
      const data = await forgeClient.getPRTooltip(cwd, prNumber);
      // See useIssueTooltip: a response that predates a refresh must not
      // repopulate the cache the refresh cleared.
      if (data && generation === cacheGeneration) {
        prCache.set(cacheKey, data);
      }
      return data;
    })();

    inFlightPRs.set(cacheKey, promise);
    const clearInFlight = () => {
      if (inFlightPRs.get(cacheKey) === promise) inFlightPRs.delete(cacheKey);
    };
    promise.then(clearInFlight, clearInFlight);

    try {
      const data = await promise;
      if (!mountedRef.current) return;
      if (data) {
        setState({ data, loading: false, error: false });
      } else {
        setState({ data: null, loading: false, error: true });
      }
    } catch {
      if (!mountedRef.current) return;
      setState({ data: null, loading: false, error: true });
    }
  }, [cwd, prNumber, providerResolved, missingCredential]);

  const reset = useCallback(() => {
    setState({ data: null, loading: false, error: false });
  }, []);

  return { ...state, missingCredential, providerId, fetchTooltip, reset };
}

/**
 * Drop the hover-detail caches so a manual sidebar refresh re-reads PR and issue
 * metadata from the provider instead of serving pre-refresh data until the 5min
 * TTL lapses. Registered once at module scope because the caches themselves are
 * module-level: clearing has to happen even when no badge is mounted, which is
 * the common case (the user clicks refresh first, then hovers).
 *
 * The credential cache is deliberately left alone — a refresh is not a
 * credential change, and its 30s TTL already re-reads promptly.
 */
export function invalidateForgeTooltipCaches(): void {
  cacheGeneration += 1;
  issueCache.clear();
  prCache.clear();
  // In-flight entries resolve into the previous generation and are fenced out of
  // the caches, so leaving them mapped would make the next hover await a promise
  // whose result is already discarded.
  inFlightIssues.clear();
  inFlightPRs.clear();
}

if (typeof window !== "undefined") {
  window.addEventListener("daintree:refresh-sidebar", invalidateForgeTooltipCaches);
  import.meta.hot?.dispose(() => {
    window.removeEventListener("daintree:refresh-sidebar", invalidateForgeTooltipCaches);
  });
}
