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
 * Width of xterm's vertical scrollbar / overview ruler, in CSS pixels.
 *
 * This is both the width handed to xterm and the gutter every pixel-to-column
 * conversion must reserve, because `FitAddon.proposeDimensions()` subtracts it
 * before dividing by the cell width. Deriving both from one constant is what
 * keeps the two calculations from drifting apart again (#11095).
 */
export const TERMINAL_SCROLLBAR_WIDTH = 15;

/** xterm's own fallback when `scrollbar.width` is unset — see `@xterm/addon-fit`. */
const XTERM_DEFAULT_SCROLLBAR_WIDTH = 14;

/**
 * CSS pixels `FitAddon` reserves for the scrollbar on a given terminal.
 *
 * Mirrors `FitAddon.proposeDimensions()` exactly, including its gating: the
 * gutter disappears when the terminal has no scrollback or the scrollbar is
 * explicitly hidden. Manual pixel-to-column math that skips this lands a couple
 * of columns wider than xterm's own fit, and `TerminalReconciliationWatchdog`
 * then re-wraps the grid seconds later — after the agent has already painted
 * (#11095). Read the live `terminal.options` rather than caching, so a terminal
 * whose scrollback or scrollbar changes mid-life stays in agreement.
 *
 * Width only: xterm never reserves the scrollbar against available height.
 */
export function getEffectiveScrollbarWidth(
  options: Pick<ITerminalOptions, "scrollback" | "scrollbar">
): number {
  const showScrollbar = options.scrollbar?.showScrollbar ?? true;
  if (options.scrollback === 0 || !showScrollbar) return 0;
  return options.scrollbar?.width ?? XTERM_DEFAULT_SCROLLBAR_WIDTH;
}

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
    scrollbar: { width: TERMINAL_SCROLLBAR_WIDTH },
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
 *
 * `widthPx` is the raw container width — every caller passes the terminal host's
 * own box — so the scrollbar gutter is reserved here, exactly as `FitAddon` does
 * when it later fits the same container. Skipping it spawns the PTY a couple of
 * columns too wide and the watchdog re-wraps the grid after the agent has
 * painted its first frame (#11095).
 *
 * This stays an estimate: {@link getTerminalMetrics} approximates the cell width
 * from the font size rather than measuring it, so it can't match `FitAddon` to
 * the column. Reserving the gutter removes the one error term that is both
 * systematic and known.
 */
export function calculateTerminalDimensions(
  widthPx: number,
  heightPx: number,
  fontSize: number
): { cols: number; rows: number } {
  const metrics = getTerminalMetrics(fontSize);
  const availableWidth = widthPx - TERMINAL_SCROLLBAR_WIDTH;
  return {
    cols: Math.max(20, Math.min(500, Math.floor(availableWidth / metrics.cellWidth))),
    rows: Math.max(10, Math.min(200, Math.floor(heightPx / metrics.cellHeight))),
  };
}
