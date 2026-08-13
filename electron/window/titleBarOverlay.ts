import type { BrowserWindow } from "electron";
import { blendOverBackground } from "../../shared/theme/contrast.js";
import {
  BANNER_SEVERITY_TOKEN,
  BANNER_TINT_ALPHA,
  WINDOWS_CAPTION_SYMBOL_COLOR,
  WINDOWS_TITLEBAR_HEIGHT_PX,
  type BannerSeverity,
} from "../../shared/config/windowChrome.js";

/**
 * Sole owner of `setTitleBarOverlay` after window creation (#11766).
 *
 * The native caption strip is painted by the OS above every WebContentsView, so
 * an opaque `surface-canvas` strip reads as a pale rectangle punched into any
 * tinted global banner sharing that band. Keeping the strip's colour in step
 * with whatever the renderer actually paints there is the only fix available:
 * a transparent overlay is not usable on Windows, where alpha < 255 makes the
 * controls fall back to opaque defaults and breaks hover feedback
 * (electron/electron#51014, #38431, #48193).
 *
 * Two inputs drive that colour — the active theme and the active global banner
 * — and they arrive from different places at different times. Routing both
 * through this module keeps them from clobbering each other: a theme change
 * while a banner is up re-tints rather than reverting to canvas.
 *
 * State is keyed by BrowserWindow in WeakMaps, so each window resolves
 * independently and entries die with the window — no disposal wiring needed.
 */

type ThemeTokens = Record<string, string>;

const themeTokens = new WeakMap<BrowserWindow, ThemeTokens>();
const bannerSeverity = new WeakMap<BrowserWindow, BannerSeverity | null>();
const appliedColor = new WeakMap<BrowserWindow, string>();

/**
 * Custom and imported themes are persisted as `Record<string, string>` with no
 * colour validation, so a token can hold anything — `oklch(…)`, `var(…)`, junk.
 * `blendOverBackground` parses hex, and would turn those into `#NaNNaNNaN`;
 * Electron rejects an unparseable colour, which would take out whichever
 * handler triggered the write. Anything that isn't plain hex is treated as
 * unusable and falls back rather than reaching the native call.
 *
 * Alpha-bearing hex is excluded too: `blendOverBackground` drops the alpha
 * channel, which would tint the strip more strongly than the wash the renderer
 * actually composites.
 */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Colour the caption strip should take for a given theme + banner pairing.
 *
 * Mirrors `InlineStatusBanner`'s `color-mix(... BANNER_TINT_ALPHA, transparent)`
 * wash over the canvas. Both sides read the alpha from the same constant so the
 * two surfaces can't drift apart.
 */
export function resolveOverlayColor(
  tokens: ThemeTokens,
  severity: BannerSeverity | null
): string | null {
  const canvas = tokens["surface-canvas"];
  if (!canvas || !HEX_COLOR.test(canvas)) return null;
  if (!severity) return canvas;

  const token = BANNER_SEVERITY_TOKEN[severity];
  if (!token) return canvas;

  const tint = tokens[token];
  if (!tint || !HEX_COLOR.test(tint)) return canvas;

  const blended = blendOverBackground(tint, canvas, BANNER_TINT_ALPHA);
  return HEX_COLOR.test(blended) ? blended : canvas;
}

function apply(win: BrowserWindow): void {
  if (process.platform !== "win32") return;
  if (win.isDestroyed()) return;

  const tokens = themeTokens.get(win);
  if (!tokens) return;

  const color = resolveOverlayColor(tokens, bannerSeverity.get(win) ?? null);
  if (!color) return;

  // Every accepted call repaints the native non-client frame, so skip no-ops.
  if (appliedColor.get(win) === color) return;

  try {
    win.setTitleBarOverlay({
      color,
      symbolColor: WINDOWS_CAPTION_SYMBOL_COLOR,
      height: WINDOWS_TITLEBAR_HEIGHT_PX,
    });
  } catch {
    // Caching a colour the native side rejected would dedup away the retry and
    // strand the strip. Leave the cache untouched so the next attempt runs.
    return;
  }

  appliedColor.set(win, color);
}

/**
 * Seed the window's theme without repainting. Called right after creation,
 * where the constructor has already applied `color` natively — recording it as
 * applied keeps the first real change from firing a redundant repaint.
 */
export function seedTitleBarOverlay(win: BrowserWindow, tokens: ThemeTokens): void {
  themeTokens.set(win, tokens);
  const color = resolveOverlayColor(tokens, null);
  if (color) appliedColor.set(win, color);
}

/** Theme changed. Re-tints in place when a banner is currently up. */
export function setTitleBarOverlayTheme(win: BrowserWindow, tokens: ThemeTokens): void {
  themeTokens.set(win, tokens);
  apply(win);
}

/** A global banner mounted (`severity`) or unmounted (`null`). */
export function setTitleBarOverlayBannerSeverity(
  win: BrowserWindow,
  severity: BannerSeverity | null
): void {
  bannerSeverity.set(win, severity);
  apply(win);
}
