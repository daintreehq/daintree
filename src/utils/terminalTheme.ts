const CANOPY_TERMINAL_THEME_FALLBACK = {
  background: "#18181b",
  foreground: "#e4e4e7",
  cursor: "#10b981",
  cursorAccent: "#18181b",
  selectionBackground: "#064e3b",
  selectionForeground: "#e4e4e7",
  black: "#18181b",
  red: "#f87171",
  green: "#10b981",
  yellow: "#fbbf24",
  blue: "#38bdf8",
  magenta: "#a855f7",
  cyan: "#22d3ee",
  white: "#e4e4e7",
  brightBlack: "#52525b",
  brightRed: "#fca5a5",
  brightGreen: "#34d399",
  brightYellow: "#fcd34d",
  brightBlue: "#7dd3fc",
  brightMagenta: "#c084fc",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
};

export const CANOPY_TERMINAL_THEME = CANOPY_TERMINAL_THEME_FALLBACK;

export interface TerminalThemeOptions {
  backgroundColor?: string;
}

export function getTerminalThemeFromCSS(
  options?: TerminalThemeOptions
): typeof CANOPY_TERMINAL_THEME_FALLBACK {
  if (typeof document === "undefined") return CANOPY_TERMINAL_THEME_FALLBACK;

  const styles = getComputedStyle(document.documentElement);
  const getVar = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return value || fallback;
  };

  const background =
    options?.backgroundColor ??
    getVar("--color-canopy-bg", CANOPY_TERMINAL_THEME_FALLBACK.background);

  return {
    background,
    foreground: getVar("--color-canopy-text", CANOPY_TERMINAL_THEME_FALLBACK.foreground),
    cursor: getVar("--color-canopy-accent", CANOPY_TERMINAL_THEME_FALLBACK.cursor),
    cursorAccent: getVar("--color-canopy-bg", CANOPY_TERMINAL_THEME_FALLBACK.cursorAccent),
    selectionBackground: getVar(
      "--color-terminal-selection",
      CANOPY_TERMINAL_THEME_FALLBACK.selectionBackground
    ),
    selectionForeground: getVar(
      "--color-canopy-text",
      CANOPY_TERMINAL_THEME_FALLBACK.selectionForeground
    ),
    black: getVar("--color-canopy-bg", CANOPY_TERMINAL_THEME_FALLBACK.black),
    red: getVar("--color-status-error", CANOPY_TERMINAL_THEME_FALLBACK.red),
    green: getVar("--color-canopy-accent", CANOPY_TERMINAL_THEME_FALLBACK.green),
    yellow: getVar("--color-status-warning", CANOPY_TERMINAL_THEME_FALLBACK.yellow),
    blue: getVar("--color-status-info", CANOPY_TERMINAL_THEME_FALLBACK.blue),
    magenta: "#a855f7",
    cyan: "#22d3ee",
    white: getVar("--color-canopy-text", CANOPY_TERMINAL_THEME_FALLBACK.white),
    brightBlack: getVar("--color-state-idle", CANOPY_TERMINAL_THEME_FALLBACK.brightBlack),
    brightRed: "#fca5a5",
    brightGreen: getVar("--color-canopy-success", CANOPY_TERMINAL_THEME_FALLBACK.brightGreen),
    brightYellow: "#fcd34d",
    brightBlue: "#7dd3fc",
    brightMagenta: "#c084fc",
    brightCyan: "#67e8f9",
    brightWhite: "#fafafa",
  };
}
