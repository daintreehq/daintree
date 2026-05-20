import { useCallback, useEffect, useRef, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MESSAGE = "Couldn't load these settings. The request timed out.";
const DEFAULT_ERROR_MESSAGE = "Couldn't load these settings.";

export interface UseTabLoadOptions {
  /** Called on mount to load tab data. */
  initialize: () => Promise<unknown> | unknown;
  /** Called when the user presses Retry. Defaults to `initialize`. Pass a separate
   *  function when `initialize` is singleflight-cached (e.g. Zustand store
   *  `initialize()`) and you need a fresh round-trip on retry. */
  retry?: () => Promise<unknown> | unknown;
  /** Default 10s. */
  timeoutMs?: number;
  /** Override the default timeout message (sentence case, no trailing period). */
  timeoutMessage?: string;
  /** Override the default error fallback when the load promise rejects. */
  errorMessage?: string;
}

export interface UseTabLoadResult {
  isLoading: boolean;
  loadError: string | null;
  retryAction: () => void;
}

/**
 * Shared loading lifecycle for a settings tab.
 *
 * - Single effect for kickoff + 10s timeout (#4958 — separate effects sharing a
 *   `cancelled` flag fire in declaration order, creating invisible ordering
 *   dependencies).
 * - `loadEpoch` ref discards stale resolutions: when the user retries, any
 *   in-flight promise from a previous attempt that resolves late is ignored.
 * - `retryAction` runs `retry ?? initialize`, so store-backed tabs can pass a
 *   singleflight-bypassing `refresh()` for retries while still seeding the
 *   initial load through `initialize()`.
 */
export function useTabLoad(options: UseTabLoadOptions): UseTabLoadResult {
  const {
    initialize,
    retry,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    timeoutMessage = DEFAULT_TIMEOUT_MESSAGE,
    errorMessage = DEFAULT_ERROR_MESSAGE,
  } = options;

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const loadEpochRef = useRef(0);
  const initializeRef = useRef(initialize);
  const retryRef = useRef(retry);
  const errorMessageRef = useRef(errorMessage);
  const timeoutMessageRef = useRef(timeoutMessage);

  useEffect(() => {
    initializeRef.current = initialize;
    retryRef.current = retry;
    errorMessageRef.current = errorMessage;
    timeoutMessageRef.current = timeoutMessage;
  }, [initialize, retry, errorMessage, timeoutMessage]);

  useEffect(() => {
    const myEpoch = ++loadEpochRef.current;
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);

    const fn = retryNonce === 0 ? initializeRef.current : (retryRef.current ?? initializeRef.current);

    const timer = setTimeout(() => {
      if (cancelled || myEpoch !== loadEpochRef.current) return;
      setLoadError(timeoutMessageRef.current);
      setIsLoading(false);
    }, timeoutMs);

    Promise.resolve()
      .then(() => fn())
      .then(() => {
        if (cancelled || myEpoch !== loadEpochRef.current) return;
        clearTimeout(timer);
        setLoadError(null);
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled || myEpoch !== loadEpochRef.current) return;
        clearTimeout(timer);
        setLoadError(formatErrorMessage(err, errorMessageRef.current));
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [retryNonce, timeoutMs]);

  const retryAction = useCallback(() => {
    setRetryNonce((n) => n + 1);
  }, []);

  return { isLoading, loadError, retryAction };
}
