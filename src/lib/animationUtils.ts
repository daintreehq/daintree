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

export const PANEL_MINIMIZE_DURATION = 120;
export const PANEL_RESTORE_DURATION = 200;

export const PANEL_MINIMIZE_EASING = "cubic-bezier(0.3, 0, 0.8, 0.15)";
export const PANEL_RESTORE_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";

export function getPanelTransitionDuration(direction: "minimize" | "restore"): number {
  if (typeof window === "undefined")
    return direction === "minimize" ? PANEL_MINIMIZE_DURATION : PANEL_RESTORE_DURATION;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reducedMotion) return 0;

  return direction === "minimize" ? PANEL_MINIMIZE_DURATION : PANEL_RESTORE_DURATION;
}
