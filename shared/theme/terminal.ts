import type { ITheme } from "@xterm/xterm";
import type { AppColorScheme, AppColorSchemeTokens } from "./types.js";
import { hexToRgbTriplet } from "./themes.js";

export function getTerminalScrollbarDefaults(type: "dark" | "light") {
  const ch = type === "dark" ? "255, 255, 255" : "0, 0, 0";
  return {
    scrollbarSliderBackground: `rgba(${ch}, 0.20)`,
    scrollbarSliderHoverBackground: `rgba(${ch}, 0.40)`,
    scrollbarSliderActiveBackground: `rgba(${ch}, 0.50)`,
  };
}

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
    // Defaults to dark — this function receives bare tokens without type info.
    // Callers with a full AppColorScheme should use getTerminalThemeFromAppScheme instead.
    ...getTerminalScrollbarDefaults("dark"),
  };
}

export function getTerminalThemeFromAppScheme(scheme: AppColorScheme): ITheme {
  const idle = scheme.tokens["activity-idle"];
  const scrollbar = idle.startsWith("#")
    ? getTerminalScrollbarFromHex(idle)
    : getTerminalScrollbarDefaults(scheme.type);

  // Light themes use surface-panel (white) for a crisp document feel.
  // Dark themes use surface-canvas (the darkest layer) for maximum contrast.
  const background =
    scheme.type === "light" ? scheme.tokens["surface-panel"] : scheme.tokens["surface-canvas"];

  return {
    ...getTerminalThemeFromAppTokens(scheme.tokens),
    background,
    ...scrollbar,
  };
}

function getTerminalScrollbarFromHex(hex: string) {
  const rgb = hexToRgbTriplet(hex);
  return {
    scrollbarSliderBackground: `rgba(${rgb}, 0.4)`,
    scrollbarSliderHoverBackground: `rgba(${rgb}, 0.6)`,
    scrollbarSliderActiveBackground: `rgba(${rgb}, 0.8)`,
  };
}
