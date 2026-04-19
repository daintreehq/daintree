import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { IssueTooltipData, PRTooltipData } from "@shared/types/github";
import { TtlCache } from "@/utils/ttlCache";
import { useGitHubConfigStore } from "@/store/githubConfigStore";

type TooltipState<T> = {
  data: T | null;
  loading: boolean;
  error: boolean;
};

const TOOLTIP_CACHE_MAX = 100;
const TOOLTIP_CACHE_TTL = 300_000; // 5 minutes, matching backend TTL

const issueCache = new TtlCache<string, IssueTooltipData>(TOOLTIP_CACHE_MAX, TOOLTIP_CACHE_TTL);
const prCache = new TtlCache<string, PRTooltipData>(TOOLTIP_CACHE_MAX, TOOLTIP_CACHE_TTL);

export function useIssueTooltip(cwd: string | undefined, issueNumber: number | undefined) {
  const [state, setState] = useState<TooltipState<IssueTooltipData>>({
    data: null,
    loading: false,
    error: false,
  });
  const fetchingKeyRef = useRef<string | null>(null);
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

    if (fetchingKeyRef.current === cacheKey) return;

    fetchingKeyRef.current = cacheKey;
    setState((prev) => ({ ...prev, loading: true, error: false }));

    try {
      const data = await window.electron.github.getIssueTooltip(cwd, issueNumber);
      if (!mountedRef.current || fetchingKeyRef.current !== cacheKey) return;

      if (data) {
        issueCache.set(cacheKey, data);
        setState({ data, loading: false, error: false });
      } else {
        setState({ data: null, loading: false, error: true });
      }
    } catch {
      if (!mountedRef.current || fetchingKeyRef.current !== cacheKey) return;
      setState({ data: null, loading: false, error: true });
    } finally {
      if (fetchingKeyRef.current === cacheKey) {
        fetchingKeyRef.current = null;
      }
    }
  }, [cwd, issueNumber, missingToken]);

  const reset = useCallback(() => {
    if (!fetchingKeyRef.current) {
      setState({ data: null, loading: false, error: false });
    }
  }, []);

  return { ...state, missingToken, fetchTooltip, reset };
}

export function usePRTooltip(cwd: string | undefined, prNumber: number | undefined) {
  const [state, setState] = useState<TooltipState<PRTooltipData>>({
    data: null,
    loading: false,
    error: false,
  });
  const fetchingKeyRef = useRef<string | null>(null);
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

    if (fetchingKeyRef.current === cacheKey) return;

    fetchingKeyRef.current = cacheKey;
    setState((prev) => ({ ...prev, loading: true, error: false }));

    try {
      const data = await window.electron.github.getPRTooltip(cwd, prNumber);
      if (!mountedRef.current || fetchingKeyRef.current !== cacheKey) return;

      if (data) {
        prCache.set(cacheKey, data);
        setState({ data, loading: false, error: false });
      } else {
        setState({ data: null, loading: false, error: true });
      }
    } catch {
      if (!mountedRef.current || fetchingKeyRef.current !== cacheKey) return;
      setState({ data: null, loading: false, error: true });
    } finally {
      if (fetchingKeyRef.current === cacheKey) {
        fetchingKeyRef.current = null;
      }
    }
  }, [cwd, prNumber, missingToken]);

  const reset = useCallback(() => {
    if (!fetchingKeyRef.current) {
      setState({ data: null, loading: false, error: false });
    }
  }, []);

  return { ...state, missingToken, fetchTooltip, reset };
}
