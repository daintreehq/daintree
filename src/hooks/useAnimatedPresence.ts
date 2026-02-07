import { useState, useEffect, useRef, useCallback } from "react";
import { getUiAnimationDuration } from "@/lib/animationUtils";

export interface UseAnimatedPresenceOptions {
  isOpen: boolean;
  onAnimateOut?: () => void;
  animationDuration?: number;
  minimumDisplayDuration?: number;
}

export interface UseAnimatedPresenceReturn {
  isVisible: boolean;
  shouldRender: boolean;
}

export function useAnimatedPresence({
  isOpen,
  onAnimateOut,
  animationDuration,
  minimumDisplayDuration,
}: UseAnimatedPresenceOptions): UseAnimatedPresenceReturn {
  const [isVisible, setIsVisible] = useState(false);
  const [shouldRender, setShouldRender] = useState(false);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minDurationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const showStartTimeRef = useRef<number>(0);
  const pendingCloseRef = useRef(false);
  const hasOpenedRef = useRef(false);
  const onAnimateOutRef = useRef(onAnimateOut);
  const animationDurationRef = useRef(animationDuration);
  const minimumDisplayDurationRef = useRef(minimumDisplayDuration);

  onAnimateOutRef.current = onAnimateOut;
  animationDurationRef.current = animationDuration;
  minimumDisplayDurationRef.current = minimumDisplayDuration;

  const cleanup = useCallback(() => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    if (minDurationTimeoutRef.current) {
      clearTimeout(minDurationTimeoutRef.current);
      minDurationTimeoutRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      hasOpenedRef.current = true;
      pendingCloseRef.current = false;
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
      if (minDurationTimeoutRef.current) {
        clearTimeout(minDurationTimeoutRef.current);
        minDurationTimeoutRef.current = null;
      }
      setShouldRender(true);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (minimumDisplayDurationRef.current != null) {
          showStartTimeRef.current = Date.now();
        }
        setIsVisible(true);
      });
    } else if (hasOpenedRef.current) {
      const doClose = () => {
        setIsVisible(false);
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        const duration = animationDurationRef.current ?? getUiAnimationDuration();
        if (duration === 0) {
          setShouldRender(false);
          onAnimateOutRef.current?.();
        } else {
          closeTimeoutRef.current = setTimeout(() => {
            closeTimeoutRef.current = null;
            setShouldRender(false);
            onAnimateOutRef.current?.();
          }, duration);
        }
      };

      if (minimumDisplayDurationRef.current != null && showStartTimeRef.current > 0) {
        const elapsed = Date.now() - showStartTimeRef.current;
        const remaining = minimumDisplayDurationRef.current - elapsed;
        if (remaining > 0) {
          pendingCloseRef.current = true;
          minDurationTimeoutRef.current = setTimeout(() => {
            minDurationTimeoutRef.current = null;
            if (pendingCloseRef.current) {
              pendingCloseRef.current = false;
              doClose();
            }
          }, remaining);
          return cleanup;
        }
      }

      doClose();
    }

    return cleanup;
  }, [isOpen, cleanup]);

  return { isVisible, shouldRender };
}
