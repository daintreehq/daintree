/**
 * Color-vision-deficiency override maps extracted from the runtime applyAppTheme
 * module so they can be tested without importing DOM-coupled renderer code.
 *
 * Each map stores hardcoded hex values that replace theme tokens when a CVD mode
 * is active. The maps are hand-authored to maintain distinguishability under
 * protanopia / deuteranopia (red-green) and tritanopia (blue-yellow).
 */

export const RED_GREEN_OVERRIDES: Record<string, string> = {
  "--theme-status-success": "#009e73",
  "--theme-status-danger": "#fe6100",
  "--theme-activity-active": "#648fff",
  "--theme-activity-working": "#648fff",
  "--theme-pr-open": "#648fff",
  "--theme-pr-closed": "#fe6100",
  "--theme-terminal-selection": "#1a1f2e",
  "--theme-terminal-red": "#d55e00",
  "--theme-terminal-green": "#009e73",
  "--theme-terminal-bright-red": "#fe6100",
  "--theme-terminal-bright-green": "#48c9a0",
  "--theme-terminal-magenta": "#cc79a7",
  "--theme-terminal-bright-magenta": "#d98fc4",
  "--theme-syntax-comment": "#999999",
  "--theme-syntax-punctuation": "#555555",
  "--theme-syntax-number": "#0072B2",
  "--theme-syntax-string": "#E69F00",
  "--theme-syntax-operator": "#555555",
  "--theme-syntax-keyword": "#D55E00",
  "--theme-syntax-function": "#0072B2",
  "--theme-syntax-link": "#0072B2",
  "--theme-syntax-quote": "#009E73",
  "--theme-syntax-chip": "#CC79A7",
  "--theme-category-blue": "#0072b2",
  "--theme-category-orange": "#e69f00",
  "--theme-category-teal": "#009e73",
  "--theme-category-pink": "#cc79a7",
  "--theme-category-amber": "#d55e00",
  "--theme-category-violet": "#785ef0",
  "--theme-category-indigo": "#648fff",
  "--theme-category-cyan": "#56b4e9",
};

export const BLUE_YELLOW_OVERRIDES: Record<string, string> = {
  "--theme-status-warning": "#94a3b8",
  "--theme-activity-waiting": "#94a3b8",
  "--theme-pr-merged": "#f97316",
  "--theme-terminal-yellow": "#cc79a7",
  "--theme-terminal-blue": "#0072b2",
  "--theme-terminal-bright-yellow": "#d98fc4",
  "--theme-terminal-bright-blue": "#56b4e9",
  "--theme-status-info": "#333333",
  "--theme-syntax-comment": "#999999",
  "--theme-syntax-punctuation": "#555555",
  "--theme-syntax-number": "#CC79A7",
  "--theme-syntax-string": "#E69F00",
  "--theme-syntax-operator": "#555555",
  "--theme-syntax-keyword": "#D55E00",
  "--theme-syntax-function": "#56B4E9",
  "--theme-syntax-link": "#0072B2",
  "--theme-syntax-quote": "#F0E442",
  "--theme-syntax-chip": "#009E73",
  "--theme-category-blue": "#dc267f",
  "--theme-category-orange": "#fe6100",
  "--theme-category-teal": "#009e73",
  "--theme-category-pink": "#d55e00",
  "--theme-category-amber": "#ffb000",
  "--theme-category-violet": "#785ef0",
  "--theme-category-indigo": "#648fff",
  "--theme-category-cyan": "#228833",
};

export const ALL_CVD_TOKENS: ReadonlySet<string> = new Set([
  ...Object.keys(RED_GREEN_OVERRIDES),
  ...Object.keys(BLUE_YELLOW_OVERRIDES),
]);
