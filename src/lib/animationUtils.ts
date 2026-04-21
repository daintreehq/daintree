/* Motion token scale — mirrors the CSS custom properties in src/index.css so
 * React components using `motion` props and JS timers stay in sync with CSS
 * keyframes and Tailwind utilities. See @theme block at the top of index.css.
 */
export const DURATION_75 = 75;
export const DURATION_100 = 100;
export const DURATION_150 = 150;
export const DURATION_200 = 200;
export const DURATION_250 = 250;
export const DURATION_300 = 300;

export const EASE_SNAPPY = "cubic-bezier(0.2, 0, 0, 1)";
export const EASE_SPRING_CRITICAL =
  "linear(0, 0.007, 0.029 2.2%, 0.118 4.7%, 0.625 14.4%, 0.826 19%, 0.902 24%, 0.962 29.8%, 0.984 33.3%, 1.004 37.8%, 1.01 42.4%, 1.011 52.2%, 1.001)";
export const EASE_OUT_EXPO = "cubic-bezier(0.16, 1, 0.3, 1)";

export const TERMINAL_ANIMATION_DURATION = DURATION_150;
export const UI_ANIMATION_DURATION = DURATION_150;

export function getTerminalAnimationDuration(): number {
  return TERMINAL_ANIMATION_DURATION;
}

export function getUiAnimationDuration(): number {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return UI_ANIMATION_DURATION;
  }

  // Performance mode skips timers entirely — callers use duration === 0 as a
  // signal to complete synchronously. Reduced-motion no longer short-circuits
  // here: CSS owns reduced-motion presentation (transform removed, opacity
  // kept) so JS durations stay intact.
  const performanceMode = document.body.dataset.performanceMode === "true";
  return performanceMode ? 0 : UI_ANIMATION_DURATION;
}

export const UI_ENTER_DURATION = DURATION_200;
export const UI_EXIT_DURATION = 120;

export const UI_PALETTE_ENTER_DURATION = DURATION_150;
export const UI_PALETTE_EXIT_DURATION = DURATION_100;

export const UI_ENTER_EASING = EASE_SPRING_CRITICAL;
export const UI_EXIT_EASING = "cubic-bezier(0.2, 0, 0.7, 0)";

export function getUiTransitionDuration(direction: "enter" | "exit"): number {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return direction === "enter" ? UI_ENTER_DURATION : UI_EXIT_DURATION;
  }

  const performanceMode = document.body.dataset.performanceMode === "true";
  if (performanceMode) return 0;

  return direction === "enter" ? UI_ENTER_DURATION : UI_EXIT_DURATION;
}

export const PANEL_MINIMIZE_DURATION = 120;
export const PANEL_RESTORE_DURATION = DURATION_200;

export const PANEL_MINIMIZE_EASING = "cubic-bezier(0.3, 0, 0.8, 0.15)";
export const PANEL_RESTORE_EASING = EASE_OUT_EXPO;

export function getPanelTransitionDuration(direction: "minimize" | "restore"): number {
  return direction === "minimize" ? PANEL_MINIMIZE_DURATION : PANEL_RESTORE_DURATION;
}
