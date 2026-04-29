import { useCallback, useEffect, useRef, useState } from "react";

export interface UseSlowCallOptions {
  slowMs?: number;
  verySlowMs?: number;
}

export interface UseSlowCallReturn<T> {
  isPending: boolean;
  isSlow: boolean;
  isVerySlow: boolean;
  run: () => Promise<T | undefined>;
  cancel: () => void;
}

const DEFAULT_SLOW_MS = 3000;
const DEFAULT_VERY_SLOW_MS = 10000;

export function useSlowCall<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options?: UseSlowCallOptions
): UseSlowCallReturn<T> {
  const slowMs = options?.slowMs ?? DEFAULT_SLOW_MS;
  const verySlowMs = options?.verySlowMs ?? DEFAULT_VERY_SLOW_MS;

  const [isPending, setIsPending] = useState(false);
  const [isSlow, setIsSlow] = useState(false);
  const [isVerySlow, setIsVerySlow] = useState(false);

  const fnRef = useRef(fn);
  const slowMsRef = useRef(slowMs);
  const verySlowMsRef = useRef(verySlowMs);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const verySlowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    fnRef.current = fn;
    slowMsRef.current = slowMs;
    verySlowMsRef.current = verySlowMs;
  });

  const clearTimers = useCallback(() => {
    if (slowTimerRef.current !== null) {
      clearTimeout(slowTimerRef.current);
      slowTimerRef.current = null;
    }
    if (verySlowTimerRef.current !== null) {
      clearTimeout(verySlowTimerRef.current);
      verySlowTimerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearTimers();
    if (isMountedRef.current) {
      setIsPending(false);
      setIsSlow(false);
      setIsVerySlow(false);
    }
  }, [clearTimers]);

  const cancel = useCallback(() => {
    if (controllerRef.current !== null) {
      controllerRef.current.abort();
      controllerRef.current = null;
    }
    runIdRef.current += 1;
    reset();
  }, [reset]);

  const run = useCallback(async (): Promise<T | undefined> => {
    if (controllerRef.current !== null) {
      controllerRef.current.abort();
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    runIdRef.current += 1;
    const myRunId = runIdRef.current;

    clearTimers();
    if (isMountedRef.current) {
      setIsPending(true);
      setIsSlow(false);
      setIsVerySlow(false);
    }

    slowTimerRef.current = setTimeout(() => {
      slowTimerRef.current = null;
      if (isMountedRef.current && runIdRef.current === myRunId && !controller.signal.aborted) {
        setIsSlow(true);
      }
    }, slowMsRef.current);

    verySlowTimerRef.current = setTimeout(() => {
      verySlowTimerRef.current = null;
      if (isMountedRef.current && runIdRef.current === myRunId && !controller.signal.aborted) {
        setIsVerySlow(true);
      }
    }, verySlowMsRef.current);

    try {
      const result = await fnRef.current(controller.signal);
      if (runIdRef.current === myRunId) {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
        reset();
      }
      return result;
    } catch (error) {
      if (runIdRef.current === myRunId) {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
        }
        reset();
      }
      throw error;
    }
  }, [clearTimers, reset]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (controllerRef.current !== null) {
        controllerRef.current.abort();
        controllerRef.current = null;
      }
      if (slowTimerRef.current !== null) {
        clearTimeout(slowTimerRef.current);
        slowTimerRef.current = null;
      }
      if (verySlowTimerRef.current !== null) {
        clearTimeout(verySlowTimerRef.current);
        verySlowTimerRef.current = null;
      }
    };
  }, []);

  return { isPending, isSlow, isVerySlow, run, cancel };
}
