export const TERMINAL_ANIMATION_DURATION = 150;
export const UI_ANIMATION_DURATION = 150;

export function getTerminalAnimationDuration(): number {
  if (typeof window === "undefined") return TERMINAL_ANIMATION_DURATION;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reducedMotion ? 0 : TERMINAL_ANIMATION_DURATION;
}

export function getUiAnimationDuration(): number {
  if (typeof window === "undefined") return UI_ANIMATION_DURATION;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const performanceMode = document.body.dataset.performanceMode === "true";

  return reducedMotion || performanceMode ? 0 : UI_ANIMATION_DURATION;
}
