import type { ITheme } from "@xterm/xterm";
import {
  BUILT_IN_APP_SCHEMES,
  DEFAULT_APP_SCHEME_ID,
  getTerminalThemeFromAppScheme,
  getTerminalScrollbarDefaults,
} from "@shared/theme";

const DEFAULT_APP_SCHEME =
  BUILT_IN_APP_SCHEMES.find((scheme) => scheme.id === DEFAULT_APP_SCHEME_ID) ??
  BUILT_IN_APP_SCHEMES[0];

export const DAINTREE_TERMINAL_THEME = getTerminalThemeFromAppScheme(DEFAULT_APP_SCHEME);

/**
 * Get terminal theme from CSS custom properties.
 *
 * Background colors for TUI applications are still handled dynamically by xterm.js.
 * This function only returns the base app-aligned terminal palette.
 */
export interface InputBarColors {
  // Terminal-derived (text & accent match the terminal)
  accent: string;
  foreground: string;
  background: string;
  selectionBg: string;
  chipColor: string;
  errorColor: string;
  successColor: string;
  // App-theme-derived (chrome matches the app surface/shadow system)
  shellBg: string;
  shellBorder: string;
  shellBorderHover: string;
  shellBorderFocus: string;
  shellShadow: string;
  shellFocusRing: string;
  shellHoverBg: string;
  shellFocusBg: string;
  isDark: boolean;
}

export function resolveInputBarColors(theme: ITheme): InputBarColors {
  const accent = theme.cursor ?? theme.blue ?? "#58a6ff";
  const foreground = theme.foreground ?? "#cccccc";
  const background = theme.background ?? "#1e1e1e";
  const isDark = (document?.documentElement?.dataset?.colorMode ?? "dark") === "dark";

  return {
    accent,
    foreground,
    background,
    selectionBg: theme.selectionBackground ?? theme.cursor ?? "#264f78",
    chipColor: theme.cyan ?? theme.brightCyan ?? theme.cursor ?? "#58a6ff",
    errorColor: theme.red ?? "#f44747",
    successColor: theme.green ?? "#89d185",
    shellBg: `color-mix(in oklab, ${background} ${isDark ? "98%" : "98.5%"}, ${isDark ? "black" : "black"})`,
    shellBorder: `color-mix(in oklab, ${foreground} ${isDark ? "7%" : "9%"}, transparent)`,
    shellBorderHover: `color-mix(in oklab, ${foreground} ${isDark ? "11%" : "14%"}, transparent)`,
    shellBorderFocus: `color-mix(in oklab, ${accent} 25%, ${isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.09)"})`,
    shellShadow: isDark ? "0 1px 3px rgba(0,0,0,0.15)" : "0 1px 3px rgba(0,0,0,0.05)",
    shellFocusRing: `color-mix(in oklab, ${accent} 15%, transparent)`,
    shellHoverBg: `color-mix(in oklab, ${background} ${isDark ? "95.5%" : "96.5%"}, ${isDark ? "black" : "black"})`,
    shellFocusBg: `color-mix(in oklab, ${background} ${isDark ? "94.5%" : "95.5%"}, ${isDark ? "black" : "black"})`,
    isDark,
  };
}

export function getTerminalThemeFromCSS(): typeof DAINTREE_TERMINAL_THEME {
  if (typeof document === "undefined") {
    return { ...DAINTREE_TERMINAL_THEME };
  }

  const styles = getComputedStyle(document.documentElement);
  const getVar = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return value || fallback;
  };

  return {
    background: getVar("--theme-terminal-background", DAINTREE_TERMINAL_THEME.background ?? ""),
    foreground: getVar("--theme-terminal-foreground", DAINTREE_TERMINAL_THEME.foreground ?? ""),
    cursor: getVar("--theme-accent-primary", DAINTREE_TERMINAL_THEME.cursor ?? ""),
    cursorAccent: getVar("--theme-text-inverse", DAINTREE_TERMINAL_THEME.cursorAccent ?? ""),
    selectionBackground: getVar(
      "--theme-terminal-selection",
      DAINTREE_TERMINAL_THEME.selectionBackground ?? ""
    ),
    selectionForeground: getVar(
      "--theme-terminal-foreground",
      DAINTREE_TERMINAL_THEME.selectionForeground ?? ""
    ),
    black: getVar("--theme-terminal-black", DAINTREE_TERMINAL_THEME.black ?? ""),
    red: getVar("--theme-terminal-red", DAINTREE_TERMINAL_THEME.red ?? ""),
    green: getVar("--theme-terminal-green", DAINTREE_TERMINAL_THEME.green ?? ""),
    yellow: getVar("--theme-terminal-yellow", DAINTREE_TERMINAL_THEME.yellow ?? ""),
    blue: getVar("--theme-terminal-blue", DAINTREE_TERMINAL_THEME.blue ?? ""),
    magenta: getVar("--theme-terminal-magenta", DAINTREE_TERMINAL_THEME.magenta ?? ""),
    cyan: getVar("--theme-terminal-cyan", DAINTREE_TERMINAL_THEME.cyan ?? ""),
    white: getVar("--theme-terminal-white", DAINTREE_TERMINAL_THEME.white ?? ""),
    brightBlack: getVar("--theme-terminal-bright-black", DAINTREE_TERMINAL_THEME.brightBlack ?? ""),
    brightRed: getVar("--theme-terminal-bright-red", DAINTREE_TERMINAL_THEME.brightRed ?? ""),
    brightGreen: getVar("--theme-terminal-bright-green", DAINTREE_TERMINAL_THEME.brightGreen ?? ""),
    brightYellow: getVar(
      "--theme-terminal-bright-yellow",
      DAINTREE_TERMINAL_THEME.brightYellow ?? ""
    ),
    brightBlue: getVar("--theme-terminal-bright-blue", DAINTREE_TERMINAL_THEME.brightBlue ?? ""),
    brightMagenta: getVar(
      "--theme-terminal-bright-magenta",
      DAINTREE_TERMINAL_THEME.brightMagenta ?? ""
    ),
    brightCyan: getVar("--theme-terminal-bright-cyan", DAINTREE_TERMINAL_THEME.brightCyan ?? ""),
    brightWhite: getVar("--theme-terminal-bright-white", DAINTREE_TERMINAL_THEME.brightWhite ?? ""),
    ...getTerminalScrollbarDefaults(
      (document.documentElement.dataset.colorMode as "dark" | "light") ?? "dark"
    ),
  };
}
