import { useState, useCallback, useRef, useEffect } from "react";
import type { IssueTooltipData, PRTooltipData } from "@shared/types/github";

type TooltipState<T> = {
  data: T | null;
  loading: boolean;
  error: boolean;
};

const issueCache = new Map<string, IssueTooltipData>();
const prCache = new Map<string, PRTooltipData>();

export function useIssueTooltip(cwd: string | undefined, issueNumber: number | undefined) {
  const [state, setState] = useState<TooltipState<IssueTooltipData>>({
    data: null,
    loading: false,
    error: false,
  });
  const fetchingKeyRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchTooltip = useCallback(async () => {
    if (!cwd || !issueNumber) return;

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
  }, [cwd, issueNumber]);

  const reset = useCallback(() => {
    if (!fetchingKeyRef.current) {
      setState({ data: null, loading: false, error: false });
    }
  }, []);

  return { ...state, fetchTooltip, reset };
}

export function usePRTooltip(cwd: string | undefined, prNumber: number | undefined) {
  const [state, setState] = useState<TooltipState<PRTooltipData>>({
    data: null,
    loading: false,
    error: false,
  });
  const fetchingKeyRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchTooltip = useCallback(async () => {
    if (!cwd || !prNumber) return;

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
  }, [cwd, prNumber]);

  const reset = useCallback(() => {
    if (!fetchingKeyRef.current) {
      setState({ data: null, loading: false, error: false });
    }
  }, []);

  return { ...state, fetchTooltip, reset };
}
