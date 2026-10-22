import { useState, useCallback, useRef, useEffect } from "react";
import type { IssueTooltipData, PRTooltipData } from "@shared/types/forge";
import type { IssueLinkTarget } from "@shared/types/ipc/forge";
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
 *
 * `namedProviderId` is the provider an issue link names (#13744), which may be
 * neither of the project's current bindings; its credential is the one that
 * matters, and main reports it unavailable if it's gone.
 */
function useForgeTooltipGate(role: "issues" | "code", namedProviderId?: string) {
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const resolved = useResolvedForgeProvider(projectId);
  // Issue badges ask the issues provider, which a project may bind apart from
  // the code forge (#13700) — and it has its own credential.
  const binding = role === "issues" ? resolved.issues : resolved;
  const providerResolved = namedProviderId !== undefined || binding.entry !== null;
  const providerId = namedProviderId ?? binding.providerId;
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

  // A "no token" answer is what sends the user to Settings, so it can't be
  // trusted until the TTL lapses: once they've saved a token and come back, the
  // next open must see it. Called only while the cached answer is negative, so
  // a connected forge pays nothing.
  const recheckCredential = useCallback(async (): Promise<boolean> => {
    if (!providerId) return false;
    try {
      const status = await window.electron.forge.getCredentialStatus(providerId);
      credentialStatusCache.set(providerId, status.hasCredential);
      setHasCredential(status.hasCredential);
      return status.hasCredential;
    } catch {
      return false;
    }
  }, [providerId]);

  return {
    providerResolved,
    providerId,
    missingCredential: providerResolved && hasCredential === false,
    recheckCredential,
  };
}

const inFlightIssues = new Map<string, Promise<IssueTooltipData | null>>();

type IssueTooltipState = TooltipState<IssueTooltipData> & { key: string | null };
const IDLE_ISSUE_TOOLTIP: IssueTooltipState = {
  data: null,
  loading: false,
  error: false,
  key: null,
};

/**
 * `target` says whose number this is (#13744) — see {@link IssueLinkTarget}.
 * Omitted, the number is read from the project's issues provider.
 */
export function useIssueTooltip(
  cwd: string | undefined,
  issueNumber: number | undefined,
  target?: IssueLinkTarget
) {
  // State remembers which issue it describes, so a response for a link the
  // badge no longer shows is never painted under it (#13744).
  const [state, setState] = useState<IssueTooltipState>(IDLE_ISSUE_TOOLTIP);
  const mountedRef = useRef(true);
  const targetRole = target?.role;
  const issueProviderId = target?.issueProviderId;
  const issueId = target?.issueId;
  const issueKey = target?.issueKey;
  const { providerResolved, providerId, missingCredential, recheckCredential } =
    useForgeTooltipGate(targetRole === "code" ? "code" : "issues", issueProviderId);
  // The provider and the issue's own identity, never the number alone: two
  // trackers can both have an issue 42, and a renumbered issue keeps its id.
  // Tagged by kind so a stable id of "7" never meets issue #7.
  const cacheKey =
    cwd && issueNumber
      ? `${providerId ?? ""}:${cwd}:${issueId ? `id:${issueId}` : issueKey ? `key:${issueKey}` : `#${issueNumber}`}`
      : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchTooltip = useCallback(async () => {
    if (!cwd || !issueNumber || !cacheKey || !providerResolved) return;
    if (missingCredential && !(await recheckCredential())) return;

    const toSettled = (result: IssueTooltipData | null): IssueTooltipState => ({
      data: result,
      loading: false,
      error: result === null,
      key: cacheKey,
    });
    const toLoading = (prev: IssueTooltipState): IssueTooltipState =>
      prev.key === cacheKey
        ? { ...prev, loading: true, error: false }
        : { data: null, loading: true, error: false, key: cacheKey };

    const cached = issueCache.get(cacheKey);
    if (cached) {
      setState(toSettled(cached));
      return;
    }

    const inFlight = inFlightIssues.get(cacheKey);
    if (inFlight) {
      const joinedGeneration = cacheGeneration;
      setState(toLoading);
      try {
        const result = await inFlight;
        if (!mountedRef.current || joinedGeneration !== cacheGeneration) return;
        setState(toSettled(result));
      } catch {
        if (!mountedRef.current || joinedGeneration !== cacheGeneration) return;
        setState(toSettled(null));
      }
      return;
    }

    setState(toLoading);

    const generation = cacheGeneration;
    const promise = (async () => {
      const fetched = await forgeClient.getIssueTooltip(
        cwd,
        issueNumber,
        targetRole || issueProviderId
          ? {
              ...(targetRole ? { role: targetRole } : {}),
              ...(issueProviderId ? { issueProviderId } : {}),
              ...(issueId ? { issueId } : {}),
              ...(issueKey ? { issueKey } : {}),
            }
          : undefined
      );
      // A sidebar refresh landed while this was in flight: the response predates
      // the invalidation, so writing it back would re-poison the cache the
      // refresh just cleared and the next hover would serve pre-refresh data.
      if (fetched && generation === cacheGeneration) {
        issueCache.set(cacheKey, fetched);
      }
      return fetched;
    })();

    inFlightIssues.set(cacheKey, promise);
    // Identity-checked so a settled pre-refresh promise can't evict the newer
    // request that replaced it under the same key.
    const clearInFlight = () => {
      if (inFlightIssues.get(cacheKey) === promise) inFlightIssues.delete(cacheKey);
    };
    promise.then(clearInFlight, clearInFlight);

    try {
      const result = await promise;
      // Same fence as the cache write: a response from before the refresh must
      // not paint pre-refresh detail into an open tooltip, and must not
      // overwrite a newer request that already resolved. The tooltip re-fetches
      // on its next open rather than committing data the refresh invalidated.
      if (!mountedRef.current || generation !== cacheGeneration) return;
      setState(toSettled(result));
    } catch {
      if (!mountedRef.current || generation !== cacheGeneration) return;
      setState(toSettled(null));
    }
  }, [
    cwd,
    issueNumber,
    cacheKey,
    targetRole,
    issueProviderId,
    issueId,
    issueKey,
    providerResolved,
    missingCredential,
    recheckCredential,
  ]);

  const reset = useCallback(() => {
    setState(IDLE_ISSUE_TOOLTIP);
  }, []);

  const { data, loading, error } = state.key === cacheKey ? state : IDLE_ISSUE_TOOLTIP;
  return { data, loading, error, missingCredential, providerId, fetchTooltip, reset };
}

const inFlightPRs = new Map<string, Promise<PRTooltipData | null>>();

export function usePRTooltip(cwd: string | undefined, prNumber: number | undefined) {
  const [state, setState] = useState<TooltipState<PRTooltipData>>({
    data: null,
    loading: false,
    error: false,
  });
  const mountedRef = useRef(true);
  const { providerResolved, providerId, missingCredential, recheckCredential } =
    useForgeTooltipGate("code");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchTooltip = useCallback(async () => {
    if (!cwd || !prNumber || !providerResolved) return;
    if (missingCredential && !(await recheckCredential())) return;

    const cacheKey = `${cwd}:${prNumber}`;
    const cached = prCache.get(cacheKey);
    if (cached) {
      setState({ data: cached, loading: false, error: false });
      return;
    }

    const inFlight = inFlightPRs.get(cacheKey);
    if (inFlight) {
      const joinedGeneration = cacheGeneration;
      setState((prev) => ({ ...prev, loading: true, error: false }));
      try {
        const data = await inFlight;
        if (!mountedRef.current || joinedGeneration !== cacheGeneration) return;
        if (data) {
          setState({ data, loading: false, error: false });
        } else {
          setState({ data: null, loading: false, error: true });
        }
      } catch {
        if (!mountedRef.current || joinedGeneration !== cacheGeneration) return;
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
      // See useIssueTooltip: a pre-refresh response neither paints nor
      // overwrites a newer one.
      if (!mountedRef.current || generation !== cacheGeneration) return;
      if (data) {
        setState({ data, loading: false, error: false });
      } else {
        setState({ data: null, loading: false, error: true });
      }
    } catch {
      if (!mountedRef.current || generation !== cacheGeneration) return;
      setState({ data: null, loading: false, error: true });
    }
  }, [cwd, prNumber, providerResolved, missingCredential, recheckCredential]);

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
