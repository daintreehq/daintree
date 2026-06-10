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

    const promise = (async () => {
      const data = await forgeClient.getIssueTooltip(cwd, issueNumber);
      if (data) {
        issueCache.set(cacheKey, data);
      }
      return data;
    })();

    inFlightIssues.set(cacheKey, promise);
    promise.then(
      () => {
        inFlightIssues.delete(cacheKey);
      },
      () => {
        inFlightIssues.delete(cacheKey);
      }
    );

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

    const promise = (async () => {
      const data = await forgeClient.getPRTooltip(cwd, prNumber);
      if (data) {
        prCache.set(cacheKey, data);
      }
      return data;
    })();

    inFlightPRs.set(cacheKey, promise);
    promise.then(
      () => {
        inFlightPRs.delete(cacheKey);
      },
      () => {
        inFlightPRs.delete(cacheKey);
      }
    );

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
