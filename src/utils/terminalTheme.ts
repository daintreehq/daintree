import {
  BUILT_IN_APP_SCHEMES,
  DEFAULT_APP_SCHEME_ID,
  getTerminalThemeFromAppScheme,
  TERMINAL_SCROLLBAR_DEFAULTS,
} from "@shared/theme";

const DEFAULT_APP_SCHEME =
  BUILT_IN_APP_SCHEMES.find((scheme) => scheme.id === DEFAULT_APP_SCHEME_ID) ??
  BUILT_IN_APP_SCHEMES[0];

export const CANOPY_TERMINAL_THEME = getTerminalThemeFromAppScheme(DEFAULT_APP_SCHEME);

/**
 * Get terminal theme from CSS custom properties.
 *
 * Background colors for TUI applications are still handled dynamically by xterm.js.
 * This function only returns the base app-aligned terminal palette.
 */
export function getTerminalThemeFromCSS(): typeof CANOPY_TERMINAL_THEME {
  if (typeof document === "undefined") {
    return { ...CANOPY_TERMINAL_THEME };
  }

  const styles = getComputedStyle(document.documentElement);
  const getVar = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return value || fallback;
  };

  return {
    background: getVar("--theme-surface-canvas", CANOPY_TERMINAL_THEME.background ?? ""),
    foreground: getVar("--theme-text-primary", CANOPY_TERMINAL_THEME.foreground ?? ""),
    cursor: getVar("--theme-accent-primary", CANOPY_TERMINAL_THEME.cursor ?? ""),
    cursorAccent: getVar("--theme-text-inverse", CANOPY_TERMINAL_THEME.cursorAccent ?? ""),
    selectionBackground: getVar(
      "--theme-terminal-selection",
      CANOPY_TERMINAL_THEME.selectionBackground ?? ""
    ),
    selectionForeground: getVar(
      "--theme-text-primary",
      CANOPY_TERMINAL_THEME.selectionForeground ?? ""
    ),
    black: getVar("--theme-terminal-black", CANOPY_TERMINAL_THEME.black ?? ""),
    red: getVar("--theme-terminal-red", CANOPY_TERMINAL_THEME.red ?? ""),
    green: getVar("--theme-terminal-green", CANOPY_TERMINAL_THEME.green ?? ""),
    yellow: getVar("--theme-terminal-yellow", CANOPY_TERMINAL_THEME.yellow ?? ""),
    blue: getVar("--theme-terminal-blue", CANOPY_TERMINAL_THEME.blue ?? ""),
    magenta: getVar("--theme-terminal-magenta", CANOPY_TERMINAL_THEME.magenta ?? ""),
    cyan: getVar("--theme-terminal-cyan", CANOPY_TERMINAL_THEME.cyan ?? ""),
    white: getVar("--theme-terminal-white", CANOPY_TERMINAL_THEME.white ?? ""),
    brightBlack: getVar("--theme-terminal-bright-black", CANOPY_TERMINAL_THEME.brightBlack ?? ""),
    brightRed: getVar("--theme-terminal-bright-red", CANOPY_TERMINAL_THEME.brightRed ?? ""),
    brightGreen: getVar("--theme-terminal-bright-green", CANOPY_TERMINAL_THEME.brightGreen ?? ""),
    brightYellow: getVar(
      "--theme-terminal-bright-yellow",
      CANOPY_TERMINAL_THEME.brightYellow ?? ""
    ),
    brightBlue: getVar("--theme-terminal-bright-blue", CANOPY_TERMINAL_THEME.brightBlue ?? ""),
    brightMagenta: getVar(
      "--theme-terminal-bright-magenta",
      CANOPY_TERMINAL_THEME.brightMagenta ?? ""
    ),
    brightCyan: getVar("--theme-terminal-bright-cyan", CANOPY_TERMINAL_THEME.brightCyan ?? ""),
    brightWhite: getVar("--theme-terminal-bright-white", CANOPY_TERMINAL_THEME.brightWhite ?? ""),
    ...TERMINAL_SCROLLBAR_DEFAULTS,
  };
}
