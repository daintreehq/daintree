import type { ITheme } from "@xterm/xterm";
import type { AppColorScheme, AppColorSchemeTokens } from "./types.js";

export const TERMINAL_SCROLLBAR_DEFAULTS = {
  scrollbarSliderBackground: "rgba(82, 82, 91, 0.4)",
  scrollbarSliderHoverBackground: "rgba(82, 82, 91, 0.6)",
  scrollbarSliderActiveBackground: "rgba(82, 82, 91, 0.8)",
} as const;

export function getTerminalThemeFromAppTokens(tokens: AppColorSchemeTokens): ITheme {
  return {
    background: tokens["surface-canvas"],
    foreground: tokens["text-primary"],
    cursor: tokens["accent-primary"],
    cursorAccent: tokens["text-inverse"],
    selectionBackground: tokens["terminal-selection"],
    selectionForeground: tokens["text-primary"],
    black: tokens["terminal-black"],
    red: tokens["terminal-red"],
    green: tokens["terminal-green"],
    yellow: tokens["terminal-yellow"],
    blue: tokens["terminal-blue"],
    magenta: tokens["terminal-magenta"],
    cyan: tokens["terminal-cyan"],
    white: tokens["terminal-white"],
    brightBlack: tokens["terminal-bright-black"],
    brightRed: tokens["terminal-bright-red"],
    brightGreen: tokens["terminal-bright-green"],
    brightYellow: tokens["terminal-bright-yellow"],
    brightBlue: tokens["terminal-bright-blue"],
    brightMagenta: tokens["terminal-bright-magenta"],
    brightCyan: tokens["terminal-bright-cyan"],
    brightWhite: tokens["terminal-bright-white"],
    ...TERMINAL_SCROLLBAR_DEFAULTS,
  };
}

export function getTerminalThemeFromAppScheme(scheme: AppColorScheme): ITheme {
  return getTerminalThemeFromAppTokens(scheme.tokens);
}
