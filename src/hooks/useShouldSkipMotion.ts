import { useReducedMotion } from "framer-motion";
import { EASE_OUT_EXPO_FM, UI_ANIMATION_DURATION } from "@/lib/animationUtils";

export interface MotionSkipSignals {
  /** OS `prefers-reduced-motion`. `null` until the media query resolves. */
  prefersReducedMotion: boolean | null;
  /** The in-app "Reduce animations" preference. */
  reduceAnimations: boolean;
  performanceMode: boolean;
}

export function shouldSkipMotion({
  prefersReducedMotion,
  reduceAnimations,
  performanceMode,
}: MotionSkipSignals): boolean {
  return prefersReducedMotion === true || reduceAnimations || performanceMode;
}

/**
 * Whether motion should resolve instantly. Framer's `MotionConfig` only knows
 * about reduced motion, so performance mode has to be read here; framer's
 * `useReducedMotion` in turn only sees the OS media query, not the in-app
 * preference. Both app-level flags live on `document.body` (set by AppLayout),
 * read at render — always fresh, because whatever animates re-renders anyway.
 */
export function useShouldSkipMotion(): boolean {
  const prefersReducedMotion = useReducedMotion();
  const dataset = typeof document === "undefined" ? undefined : document.body?.dataset;

  return shouldSkipMotion({
    prefersReducedMotion,
    reduceAnimations: dataset?.reduceAnimations === "true",
    performanceMode: dataset?.performanceMode === "true",
  });
}

/** The shared 150ms tier as a framer-motion transition, instant when motion is skipped. */
export function useUiMotionTransition(): {
  duration: number;
  ease: typeof EASE_OUT_EXPO_FM;
} {
  const skipMotion = useShouldSkipMotion();

  return {
    duration: skipMotion ? 0 : UI_ANIMATION_DURATION / 1000,
    ease: EASE_OUT_EXPO_FM,
  };
}
