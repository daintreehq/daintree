/**
 * Windows caption-strip geometry, shared by the main process (which configures
 * the native `titleBarOverlay`) and the renderer (which reserves space for it).
 *
 * The renderer cannot measure this strip. `env(titlebar-area-*)` and
 * `navigator.windowControlsOverlay` are scoped to the BrowserWindow's own
 * webContents, and Daintree's React app runs in a child WebContentsView — so
 * those never resolve here and silently fall back (electron/electron#34947,
 * open through Electron 42; see also #7951). A constant is the honest
 * representation: the env-var expression that used to live at the call sites
 * could only ever evaluate to its fallback.
 *
 * The width is CSS px (DIPs), which is why one constant holds across 100/125/
 * 150/175% display scaling and in both maximized and restored states:
 * 138px ≈ 3 × 46px backplates for the Windows 11 caption cluster.
 */
export const WINDOWS_CAPTION_WIDTH_PX = 138;

/** Height of the native caption strip, and of the toolbar it sits over. */
export const WINDOWS_TITLEBAR_HEIGHT_PX = 48;

/** Glyph colour for the native minimize/maximize/close symbols. */
export const WINDOWS_CAPTION_SYMBOL_COLOR = "#a1a1aa";

/**
 * Opacity of a status banner's severity wash over the surface behind it.
 * `InlineStatusBanner` mixes its background at this alpha, and the main
 * process blends the same alpha to pick a matching native overlay colour —
 * keeping both ends of the band one surface. Changing this in one place only
 * would make the caption strip visibly disagree with the banner.
 */
export const BANNER_TINT_ALPHA = 0.1;

/** Severity scale shared by `InlineStatusBanner` and the native overlay tint. */
export const BANNER_SEVERITIES = ["error", "warning", "info", "success", "neutral"] as const;

export type BannerSeverity = (typeof BANNER_SEVERITIES)[number];

/**
 * Theme token each severity tints with. `neutral` maps to nothing: its wash is
 * `overlay-subtle` rather than a status colour, and leaving the caption strip
 * at the plain canvas is closer than guessing at that overlay.
 */
export const BANNER_SEVERITY_TOKEN: Record<BannerSeverity, string | null> = {
  error: "status-danger",
  warning: "status-warning",
  info: "status-info",
  success: "status-success",
  neutral: null,
};
