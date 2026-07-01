/**
 * Shared xterm.js configuration module.
 *
 * This module provides a single source of truth for xterm terminal options,
 * ensuring consistency between:
 * - XtermAdapter (live terminal rendering)
 * - terminalRegistrySlice (prewarm options)
 * - TerminalRegistryController (prewarm options)
 *
 * Previously, these files each had their own copy of the terminal options,
 * which led to "must match exactly" comments and subtle inconsistencies.
 */

import type { ITerminalOptions, ITheme } from "@xterm/xterm";
import { getTerminalThemeFromCSS } from "@/utils/terminalTheme";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";

/**
 * Configuration for terminal appearance.
 */
export interface TerminalAppearanceConfig {
  fontSize: number;
  fontFamily: string;
  performanceMode: boolean;
  scrollback: number;
  theme?: ITheme;
  screenReaderMode?: boolean;
}

/**
 * Base terminal options that apply to all terminals.
 * These are the common options shared across all xterm instances.
 */
export const BASE_TERMINAL_OPTIONS = {
  cursorBlink: true,
  cursorStyle: "block" as const,
  cursorInactiveStyle: "block" as const,
  // Exactly 1.0 — a fractional line height makes xterm's DOM renderer leave
  // vertical sub-pixel gaps between stacked box-drawing characters, breaking
  // the box borders that agent TUIs draw. (The WebGL renderer hid this by
  // custom-drawing those glyphs to the cell; the DOM renderer cannot.)
  lineHeight: 1.0,
  letterSpacing: 0,
  fontWeight: "normal" as const,
  fontWeightBold: "700" as const,
  allowProposedApi: true,
  macOptionIsMeta: true,
  macOptionClickForcesSelection: true,
  scrollOnUserInput: false,
  fastScrollSensitivity: 5,
  scrollSensitivity: 1.5,
} satisfies Partial<ITerminalOptions>;

/**
 * Get complete xterm options for a terminal instance.
 * This function returns all options needed to create a consistent terminal.
 *
 * @param config - Appearance configuration
 * @returns Complete ITerminalOptions for xterm
 */
export function getXtermOptions(config: TerminalAppearanceConfig): ITerminalOptions {
  const theme = config.theme ?? getTerminalThemeFromCSS();

  return {
    ...BASE_TERMINAL_OPTIONS,
    fontSize: config.fontSize,
    fontFamily: config.fontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
    theme,
    scrollback: config.scrollback,
    screenReaderMode: config.screenReaderMode ?? false,
    smoothScrollDuration: 0,
    // xterm 6.1 folds the overview ruler into the scrollbar options: setting
    // `scrollbar.width` enables the ruler (search match markers) at that
    // CSS-pixel width.
    scrollbar: { width: 15 },
  };
}

/**
 * Get terminal options with minimal configuration.
 * Useful when only font settings are available.
 */
export function getXtermOptionsSimple(
  fontSize: number,
  fontFamily: string,
  scrollback: number,
  performanceMode: boolean = false
): ITerminalOptions {
  return getXtermOptions({
    fontSize,
    fontFamily,
    scrollback,
    performanceMode,
  });
}

/**
 * Create xterm options suitable for readonly/snapshot display.
 * Disables cursor and input-related options.
 */
export function getXtermOptionsForSnapshot(config: TerminalAppearanceConfig): ITerminalOptions {
  return {
    ...getXtermOptions(config),
    cursorBlink: false,
    cursorStyle: "bar",
    disableStdin: true,
  };
}

/**
 * Extract terminal metrics for calculating cell dimensions.
 * These values should be consistent across all terminal instances.
 */
export function getTerminalMetrics(fontSize: number): {
  cellWidth: number;
  cellHeight: number;
} {
  // These ratios are based on typical monospace font rendering and must match
  // the `lineHeight` setting in BASE_TERMINAL_OPTIONS (1.0).
  return {
    cellWidth: Math.max(6, Math.floor(fontSize * 0.6)),
    cellHeight: Math.max(10, Math.floor(fontSize)),
  };
}

/**
 * Calculate terminal dimensions in columns/rows from pixel dimensions.
 */
export function calculateTerminalDimensions(
  widthPx: number,
  heightPx: number,
  fontSize: number
): { cols: number; rows: number } {
  const metrics = getTerminalMetrics(fontSize);
  return {
    cols: Math.max(20, Math.min(500, Math.floor(widthPx / metrics.cellWidth))),
    rows: Math.max(10, Math.min(200, Math.floor(heightPx / metrics.cellHeight))),
  };
}
