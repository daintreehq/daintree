import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { IssueTooltipData, PRTooltipData } from "@shared/types/github";
import { TtlCache } from "@/utils/ttlCache";
import { useGitHubConfigStore } from "@github-renderer/stores/githubConfigStore";

type TooltipState<T> = {
  data: T | null;
  loading: boolean;
  error: boolean;
};

const TOOLTIP_CACHE_MAX = 100;
const TOOLTIP_CACHE_TTL = 300_000; // 5 minutes, matching backend TTL

const issueCache = new TtlCache<string, IssueTooltipData>(TOOLTIP_CACHE_MAX, TOOLTIP_CACHE_TTL);
const prCache = new TtlCache<string, PRTooltipData>(TOOLTIP_CACHE_MAX, TOOLTIP_CACHE_TTL);

const inFlightIssues = new Map<string, Promise<IssueTooltipData | null>>();

export function useIssueTooltip(cwd: string | undefined, issueNumber: number | undefined) {
  const [state, setState] = useState<TooltipState<IssueTooltipData>>({
    data: null,
    loading: false,
    error: false,
  });
  const mountedRef = useRef(true);
  const hasToken = useGitHubConfigStore((s) => s.config?.hasToken);
  const storeInitialized = useGitHubConfigStore((s) => s.isInitialized);

  const missingToken = useMemo(() => storeInitialized && !hasToken, [storeInitialized, hasToken]);

  useEffect(() => {
    mountedRef.current = true;
    if (!storeInitialized) {
      void useGitHubConfigStore.getState().initialize();
    }
    return () => {
      mountedRef.current = false;
    };
  }, [storeInitialized]);

  const fetchTooltip = useCallback(async () => {
    if (!cwd || !issueNumber || missingToken) return;

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
      const data = await window.electron.github.getIssueTooltip(cwd, issueNumber);
      if (data) {
        issueCache.set(cacheKey, data);
      }
      return data;
    })();

    inFlightIssues.set(cacheKey, promise);
    promise.finally(() => {
      inFlightIssues.delete(cacheKey);
    });

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
  }, [cwd, issueNumber, missingToken]);

  const reset = useCallback(() => {
    setState({ data: null, loading: false, error: false });
  }, []);

  return { ...state, missingToken, fetchTooltip, reset };
}

const inFlightPRs = new Map<string, Promise<PRTooltipData | null>>();

export function usePRTooltip(cwd: string | undefined, prNumber: number | undefined) {
  const [state, setState] = useState<TooltipState<PRTooltipData>>({
    data: null,
    loading: false,
    error: false,
  });
  const mountedRef = useRef(true);
  const hasToken = useGitHubConfigStore((s) => s.config?.hasToken);
  const storeInitialized = useGitHubConfigStore((s) => s.isInitialized);

  const missingToken = useMemo(() => storeInitialized && !hasToken, [storeInitialized, hasToken]);

  useEffect(() => {
    mountedRef.current = true;
    if (!storeInitialized) {
      void useGitHubConfigStore.getState().initialize();
    }
    return () => {
      mountedRef.current = false;
    };
  }, [storeInitialized]);

  const fetchTooltip = useCallback(async () => {
    if (!cwd || !prNumber || missingToken) return;

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
      const data = await window.electron.github.getPRTooltip(cwd, prNumber);
      if (data) {
        prCache.set(cacheKey, data);
      }
      return data;
    })();

    inFlightPRs.set(cacheKey, promise);
    promise.finally(() => {
      inFlightPRs.delete(cacheKey);
    });

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
  }, [cwd, prNumber, missingToken]);

  const reset = useCallback(() => {
    setState({ data: null, loading: false, error: false });
  }, []);

  return { ...state, missingToken, fetchTooltip, reset };
}
