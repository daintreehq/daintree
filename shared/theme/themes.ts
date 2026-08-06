import type {
  AppColorScheme,
  AppColorSchemeTokens,
  AppThemeTokenKey,
  AppThemeValidationWarning,
} from "./types.js";
import type { ThemePalette, ThemeStrategy } from "./palette.js";
import type { ExtensionKey } from "./types.js";
import { getThemeContrastWarnings } from "./contrast.js";
import { BUILT_IN_THEME_SOURCES, type BuiltInThemeSource } from "./builtInThemeSources.js";

export const DEFAULT_APP_SCHEME_ID = "daintree";

// ANSI-approximate hues used as fallbacks when a plugin theme's palette omits
// the terminal sub-palette. Without these, magenta/cyan would inherit from
// `palette.accent` and `palette.activity.active`, which can be any hue and
// breaks xterm.js syntax highlighting that relies on these slots being purple
// and cyan respectively.
export const ANSI_MAGENTA_FALLBACK = "#a855f7";
export const ANSI_CYAN_FALLBACK = "#22d3ee";

const PR_STATE_DARK_TOKENS: Pick<
  AppColorSchemeTokens,
  "pr-open" | "pr-merged" | "pr-closed" | "pr-draft"
> = {
  "pr-open": "#3fb950",
  "pr-merged": "#a371f7",
  "pr-closed": "#f85149",
  "pr-draft": "#8b949e",
};

// Light pr-* defaults are darkened from the GitHub brand hues (hue preserved,
// L/C lowered) so the colored badge clears AA 4.5:1 on the brightest light-theme
// panel/elevated surfaces (E6/B1). The unaltered brand values (pr-open #1A7F37 =
// 4.30:1, pr-merged #8250DF = 4.27:1, pr-draft #8B949E = 2.61:1) failed AA on the
// near-white panels of the no-override light themes (table-mountain, hokkaido,
// atacama). pr-closed #CF222E already cleared (4.54:1) and is unchanged. Dark uses
// PR_STATE_DARK_TOKENS and is untouched.
const PR_STATE_LIGHT_TOKENS: Pick<
  AppColorSchemeTokens,
  "pr-open" | "pr-merged" | "pr-closed" | "pr-draft"
> = {
  "pr-open": "#176E31",
  "pr-merged": "#7544CC",
  "pr-closed": "#CF222E",
  "pr-draft": "#5C6571",
};

/**
 * Engine-level designability knobs sourced from `ThemeStrategy`. They feed
 * derivations that aren't part of the semantic-token contract (border ink,
 * status-surface alpha) so a theme can shape them without overriding every
 * derived token by hand.
 */
export interface DaintreeTokenOptions {
  borderInkOverride?: string;
  statusSurfaceOpacity?: number;
}

export function createDaintreeTokens(
  type: "dark" | "light",
  tokens: Partial<AppColorSchemeTokens> &
    Pick<
      AppColorSchemeTokens,
      | "surface-canvas"
      | "surface-sidebar"
      | "surface-panel"
      | "surface-panel-elevated"
      | "surface-grid"
      | "text-primary"
      | "text-secondary"
      | "text-muted"
      | "text-inverse"
      | "border-default"
      | "accent-primary"
      | "status-success"
      | "status-warning"
      | "status-danger"
      | "status-info"
      | "activity-active"
      | "activity-idle"
      | "activity-working"
      | "activity-waiting"
      | "terminal-selection"
      | "terminal-red"
      | "terminal-green"
      | "terminal-yellow"
      | "terminal-blue"
      | "terminal-magenta"
      | "terminal-cyan"
      | "terminal-bright-red"
      | "terminal-bright-green"
      | "terminal-bright-yellow"
      | "terminal-bright-blue"
      | "terminal-bright-magenta"
      | "terminal-bright-cyan"
      | "terminal-bright-white"
      | "syntax-comment"
      | "syntax-punctuation"
      | "syntax-number"
      | "syntax-string"
      | "syntax-operator"
      | "syntax-keyword"
      | "syntax-function"
      | "syntax-link"
      | "syntax-quote"
      | "syntax-chip"
    >,
  options?: DaintreeTokenOptions
): AppColorSchemeTokens {
  const dark = type === "dark";
  const overlayTone = dark ? "#ffffff" : "#000000";
  // Light ink for borders/separators. The engine is an additive-glow model tuned
  // for dark (layering white over a low-L canvas reads as glow). On a near-white
  // canvas, pure black at dark's alphas barely registers and reads as grime, so
  // light uses a cool near-black ink (slight blue) that composites near-neutral
  // at the raised alphas below — present, but not an accent highlight.
  // A theme may swap the border ink for an on-temperature one (e.g. warm
  // charcoal) via strategy.borderInkOverride; otherwise the engine default holds.
  const borderInk = options?.borderInkOverride ?? (dark ? overlayTone : "#0f141b");
  // Per-theme dial on the status-surface wash intensity (default 1).
  const statusSurfaceAlpha = (base: number) => base * (options?.statusSurfaceOpacity ?? 1);
  // overlay-base tints the entire hover/fill ladder. Defaults to overlayTone (pure
  // white/black). Set to a hued color for themed overlays (icy blue, warm cream, etc.).
  // On light, the interactive ladder routes through overlayBase (RC-3) so the
  // per-theme tint carries hue identity now that the alphas are perceptible (RC-2).
  const overlayBase = tokens["overlay-base"] ?? overlayTone;
  const accentSoft =
    tokens["accent-soft"] ?? withAlpha(tokens["accent-primary"], dark ? 0.18 : 0.18);
  const accentMuted =
    tokens["accent-muted"] ?? withAlpha(tokens["accent-primary"], dark ? 0.3 : 0.3);
  const accentRgb = tokens["accent-primary"].startsWith("#")
    ? hexToRgbTriplet(tokens["accent-primary"])
    : "0, 0, 0";
  const tint = dark ? "#ffffff" : "#000000";
  const accentSecondary = tokens["accent-secondary"] ?? tokens["status-success"];
  const accentSecondarySoft =
    tokens["accent-secondary-soft"] ?? withAlpha(accentSecondary, dark ? 0.15 : 0.1);
  const accentSecondaryMuted =
    tokens["accent-secondary-muted"] ?? withAlpha(accentSecondary, dark ? 0.25 : 0.18);

  const prStateDefaults = dark ? PR_STATE_DARK_TOKENS : PR_STATE_LIGHT_TOKENS;

  const searchHighlightBg =
    tokens["search-highlight-background"] ?? withAlpha(tokens["accent-primary"], dark ? 0.2 : 0.12);
  const searchHighlightText = tokens["search-highlight-text"] ?? tokens["status-success"];
  const shadowAmbient =
    tokens["shadow-ambient"] ??
    (dark
      ? "0 1px 3px rgba(0, 0, 0, 0.3), 0 1px 2px rgba(0, 0, 0, 0.2)"
      : "0 2px 8px rgba(0, 0, 0, 0.06)");
  const shadowFloating =
    tokens["shadow-floating"] ??
    (dark
      ? "0 4px 12px rgba(0, 0, 0, 0.5), 0 1px 3px rgba(0, 0, 0, 0.3)"
      : "0 4px 12px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08)");
  const shadowDialog = tokens["shadow-dialog"] ?? shadowFloating;

  const categoryDefaults = dark
    ? {
        "category-blue": "oklch(0.7 0.13 250)",
        "category-purple": "oklch(0.7 0.13 310)",
        "category-cyan": "oklch(0.72 0.11 215)",
        "category-green": "oklch(0.7 0.13 145)",
        "category-amber": "oklch(0.73 0.14 75)",
        "category-orange": "oklch(0.7 0.14 45)",
        "category-teal": "oklch(0.7 0.11 185)",
        "category-indigo": "oklch(0.7 0.13 275)",
        "category-rose": "oklch(0.7 0.14 5)",
        "category-pink": "oklch(0.72 0.13 340)",
        "category-violet": "oklch(0.7 0.13 295)",
        "category-slate": "oklch(0.65 0.04 240)",
      }
    : {
        "category-blue": "oklch(0.55 0.14 242)",
        "category-purple": "oklch(0.55 0.14 318)",
        "category-cyan": "oklch(0.56 0.11 198)",
        "category-green": "oklch(0.55 0.14 155)",
        "category-amber": "oklch(0.58 0.15 65)",
        "category-orange": "oklch(0.56 0.16 38)",
        "category-teal": "oklch(0.55 0.12 178)",
        "category-indigo": "oklch(0.54 0.14 264)",
        "category-rose": "oklch(0.56 0.15 14)",
        "category-pink": "oklch(0.55 0.14 340)",
        "category-violet": "oklch(0.54 0.14 295)",
        "category-slate": "oklch(0.50 0.03 228)",
      };

  return {
    ...prStateDefaults,
    ...categoryDefaults,
    // RC-6: light borders raised and floored by contrast vs the brightest adjacent
    // surface (target ≥~1.18). When overlay/shadow depth cues collapse on a near-white
    // canvas, separation falls to borders — so the light ladder is roughly doubled and
    // driven from the cool near-black `borderInk`, which composites near-neutral.
    "border-subtle": tokens["border-subtle"] ?? withAlpha(borderInk, dark ? 0.08 : 0.09),
    "border-strong": tokens["border-strong"] ?? withAlpha(borderInk, dark ? 0.14 : 0.18),
    "border-divider": tokens["border-divider"] ?? withAlpha(borderInk, dark ? 0.05 : 0.085),
    "border-interactive": tokens["border-interactive"] ?? withAlpha(borderInk, dark ? 0.2 : 0.2),
    // Driven from `text-primary`, not `borderInk`: this is the one border that
    // must hit a fixed ratio, and `text-primary` is the only ink already floored
    // against every surface, so a fraction of it lands predictably in all 14
    // themes. Light needs the heavier alpha for the same reason the light border
    // ladder is doubled — the eye's luminance discrimination is compressed near
    // white, and the outline sits on the raised fill rather than the surface.
    // Both values are enforced at 3:1 by `getThemeContrastWarnings`; raising the
    // fill or retuning `text-primary` will trip that rather than fail silently.
    "selection-outline":
      tokens["selection-outline"] ?? withAlpha(tokens["text-primary"], dark ? 0.42 : 0.53),
    "accent-foreground": tokens["accent-foreground"] ?? tokens["text-inverse"],
    // RC-4 (engine slice): on light, brighten the accent on hover (mix toward white)
    // so it advances on interaction instead of darkening into the canvas.
    "accent-hover":
      tokens["accent-hover"] ??
      `color-mix(in oklab, ${tokens["accent-primary"]} 90%, ${dark ? "#ffffff" : "#ffffff"})`,
    "accent-soft": accentSoft,
    "accent-muted": accentMuted,
    "accent-rgb": tokens["accent-rgb"] ?? accentRgb,
    "focus-ring": tokens["focus-ring"] ?? withAlpha(overlayTone, dark ? 0.18 : 0.18),
    "overlay-base": tokens["overlay-base"] ?? overlayTone,
    "overlay-subtle": tokens["overlay-subtle"] ?? withAlpha(overlayBase, dark ? 0.02 : 0.02),
    "overlay-soft": tokens["overlay-soft"] ?? withAlpha(overlayBase, dark ? 0.03 : 0.03),
    "overlay-medium": tokens["overlay-medium"] ?? withAlpha(overlayBase, dark ? 0.04 : 0.05),
    "overlay-strong": tokens["overlay-strong"] ?? withAlpha(overlayBase, dark ? 0.06 : 0.08),
    "overlay-emphasis": tokens["overlay-emphasis"] ?? withAlpha(overlayBase, dark ? 0.1 : 0.12),
    // RC-2: the four highest-traffic interactive fills. Dark layers white over a
    // low-L canvas and reads as glow; light layers ink over near-white where the
    // eye's luminance discrimination is compressed, so the light alphas are raised
    // ~2x to a perceptual Weber target (~15-25% over surface-canvas) instead of
    // mirroring dark's alphas. RC-3: light routes these through `overlayBase` (the
    // hued tint) rather than pure tone, so the per-theme tint carries hue identity
    // now that the alphas are perceptible. Dark keeps `overlayTone` unchanged.
    "overlay-hover":
      tokens["overlay-hover"] ?? withAlpha(dark ? overlayTone : overlayBase, dark ? 0.05 : 0.065),
    "overlay-active":
      tokens["overlay-active"] ?? withAlpha(dark ? overlayTone : overlayBase, dark ? 0.08 : 0.11),
    "overlay-selected":
      tokens["overlay-selected"] ?? withAlpha(dark ? overlayTone : overlayBase, dark ? 0.04 : 0.08),
    "overlay-elevated":
      tokens["overlay-elevated"] ?? withAlpha(dark ? overlayTone : overlayBase, dark ? 0.06 : 0.1),
    // E1: the elevate-to-select primitive. On a near-white canvas, darkening a
    // surface to mark it selected reads as grime exactly where the eye's
    // luminance discrimination is most compressed; the correct light idiom is
    // the inverse — the selection lifts toward the brightest plane. So on LIGHT
    // this is the opaque `elevated` surface nudged a hair toward text (a faint
    // cool-gray highlight, macOS / VS Code style), a real upward lift over the
    // recessed sidebar/canvas/panel containers. On DARK it aliases the additive-
    // white `overlay-selected` (withAlpha(overlayTone, 0.04)) so dark is byte-for-
    // byte unchanged. `?? `-sourced so a per-theme override wins.
    "overlay-raised":
      tokens["overlay-raised"] ??
      (dark
        ? withAlpha(overlayTone, 0.04)
        : `color-mix(in oklab, ${tokens["surface-panel-elevated"]} 92%, ${tokens["text-primary"]})`),
    "filter-selected-bg-soft":
      tokens["filter-selected-bg-soft"] ?? withAlpha(dark ? tint : overlayBase, dark ? 0.08 : 0.08),
    "filter-selected-bg-strong":
      tokens["filter-selected-bg-strong"] ??
      withAlpha(dark ? tint : overlayBase, dark ? 0.12 : 0.12),
    "wash-subtle": tokens["wash-subtle"] ?? withAlpha(overlayBase, 0.02),
    "wash-medium": tokens["wash-medium"] ?? withAlpha(overlayBase, 0.04),
    "wash-strong": tokens["wash-strong"] ?? withAlpha(overlayBase, 0.08),
    // E7: on light, a 0.50-black scrim reads as a heavy slab over a near-white
    // workbench. Lower the mid scrim toward ~0.36 and hue it through `overlayBase`
    // (the per-theme tint, cool near-black) so the dimming behind a modal stays
    // on-temperature rather than a flat black wash. Dark scrims unchanged.
    "scrim-soft":
      tokens["scrim-soft"] ?? (dark ? "rgba(0, 0, 0, 0.2)" : withAlpha(overlayBase, 0.22)),
    "scrim-medium":
      tokens["scrim-medium"] ?? (dark ? "rgba(0, 0, 0, 0.45)" : withAlpha(overlayBase, 0.36)),
    "scrim-strong":
      tokens["scrim-strong"] ?? (dark ? "rgba(0, 0, 0, 0.62)" : withAlpha(overlayBase, 0.55)),
    // Defaults match the previously hardcoded backdrop-blur-md / -sm consumers.
    "scrim-blur": tokens["scrim-blur"] ?? "12px",
    "scrim-blur-palette": tokens["scrim-blur-palette"] ?? "4px",
    "shadow-color": tokens["shadow-color"] ?? (dark ? "rgba(0, 0, 0, 0.5)" : "rgba(0, 0, 0, 0.12)"),
    "shadow-ambient": shadowAmbient,
    "shadow-floating": shadowFloating,
    "shadow-dialog": shadowDialog,
    tint: tokens["tint"] ?? tint,
    "material-blur": tokens["material-blur"] ?? "0px",
    "material-saturation": tokens["material-saturation"] ?? "100%",
    "material-opacity": tokens["material-opacity"] ?? "1",
    "radius-scale": tokens["radius-scale"] ?? "1",
    "activity-completed": tokens["activity-completed"] ?? tokens["status-success"],
    "terminal-background": tokens["terminal-background"] ?? tokens["surface-canvas"],
    "terminal-foreground": tokens["terminal-foreground"] ?? tokens["text-primary"],
    "terminal-muted": tokens["terminal-muted"] ?? tokens["text-muted"],
    "terminal-cursor": tokens["terminal-cursor"] ?? tokens["accent-primary"],
    "terminal-cursor-accent":
      tokens["terminal-cursor-accent"] ?? tokens["terminal-background"] ?? tokens["surface-canvas"],
    "terminal-black":
      tokens["terminal-black"] ?? (dark ? tokens["surface-canvas"] : tokens["text-primary"]),
    "terminal-white":
      tokens["terminal-white"] ?? (dark ? tokens["text-primary"] : tokens["surface-canvas"]),
    "terminal-bright-black": tokens["terminal-bright-black"] ?? tokens["activity-idle"],
    "surface-toolbar":
      tokens["surface-toolbar"] ??
      `color-mix(in oklab, ${tokens["surface-sidebar"]} ${dark ? "67%" : "40%"}, ${tokens["surface-canvas"]})`,
    // E8: on light, an input field is an inset WELL, not the brightest object on
    // screen (the macOS / VS Code idiom). The old default put it at `surface-panel`
    // (raised). Re-derive it RECESSED — `surface-canvas` pulled a hair toward text
    // so it sits just below canvas — and consumers pair it with a 1px inset top
    // shadow. Dark keeps the raised `surface-panel-elevated` (a dark inset well
    // would vanish). Palettes that still override this to their elevated hex are
    // flagged for the palette owner.
    "surface-input":
      tokens["surface-input"] ??
      (dark
        ? tokens["surface-panel-elevated"]
        : `color-mix(in oklab, ${tokens["surface-canvas"]} 96%, ${tokens["text-primary"]})`),
    // RC-2 siblings: same failure mode as the overlay ladder. Light raised ~2x and
    // routed through `overlayBase` so the per-theme tint reaches the primary hover
    // surface. Dark keeps `overlayTone` unchanged.
    "surface-inset":
      tokens["surface-inset"] ?? withAlpha(dark ? overlayTone : overlayBase, dark ? 0.03 : 0.06),
    "surface-hover":
      tokens["surface-hover"] ?? withAlpha(dark ? overlayTone : overlayBase, dark ? 0.05 : 0.065),
    "surface-active":
      tokens["surface-active"] ?? withAlpha(dark ? overlayTone : overlayBase, dark ? 0.08 : 0.11),
    "surface-disabled":
      tokens["surface-disabled"] ??
      `color-mix(in oklab, ${tokens["surface-input"] ?? (dark ? tokens["surface-panel-elevated"] : tokens["surface-panel"])} 70%, ${tokens["surface-canvas"]})`,
    // RC-8 / E8: light placeholder raised to ~0.58 (from 0.32). On the now-RECESSED
    // surface-input the old 0.32 dropped further below the 3:1 graphical floor; at
    // 0.58 a placeholder over a near-white input clears ~3:1. Dark unchanged.
    "text-placeholder":
      tokens["text-placeholder"] ?? withAlpha(tokens["text-primary"], dark ? 0.35 : 0.58),
    "text-link": tokens["text-link"] ?? tokens["accent-primary"],
    "accent-secondary": accentSecondary,
    "accent-secondary-soft": accentSecondarySoft,
    "accent-secondary-muted": accentSecondaryMuted,
    "search-highlight-background": searchHighlightBg,
    "search-highlight-text": tokens["search-highlight-text"] ?? searchHighlightText,
    "search-selected-result-border":
      tokens["search-selected-result-border"] ?? tokens["accent-primary"],
    "search-selected-result-icon":
      tokens["search-selected-result-icon"] ?? tokens["accent-primary"],
    "search-match-badge-background": tokens["search-match-badge-background"] ?? accentSoft,
    "search-match-badge-text": tokens["search-match-badge-text"] ?? tokens["accent-primary"],
    "state-chip-bg-opacity": tokens["state-chip-bg-opacity"] ?? (dark ? "0.15" : "0.12"),
    "state-chip-border-opacity": tokens["state-chip-border-opacity"] ?? (dark ? "0.40" : "0.35"),
    "label-pill-bg-opacity": tokens["label-pill-bg-opacity"] ?? (dark ? "0.10" : "0.08"),
    "label-pill-border-opacity": tokens["label-pill-border-opacity"] ?? (dark ? "0.20" : "0.15"),
    "scrollbar-width": tokens["scrollbar-width"] ?? "6px",
    "scrollbar-thumb": tokens["scrollbar-thumb"] ?? tokens["activity-idle"],
    "scrollbar-thumb-hover":
      tokens["scrollbar-thumb-hover"] ??
      `color-mix(in oklab, ${tokens["activity-idle"]} 85%, ${tokens["text-primary"]})`,
    "scrollbar-track": tokens["scrollbar-track"] ?? withAlpha(tokens["text-primary"], 0.03),
    "panel-state-edge-width": tokens["panel-state-edge-width"] ?? (dark ? "0px" : "2px"),
    "panel-state-edge-inset-block": tokens["panel-state-edge-inset-block"] ?? "4px",
    "panel-state-edge-radius": tokens["panel-state-edge-radius"] ?? "2px",
    "focus-ring-offset": tokens["focus-ring-offset"] ?? "2px",
    "chrome-noise-texture": tokens["chrome-noise-texture"] ?? "none",
    // Defaults match the previously hardcoded .bg-noise::before declarations.
    "grain-opacity": tokens["grain-opacity"] ?? "0.02",
    "grain-blend": tokens["grain-blend"] ?? "overlay",
    "knob-base": tokens["knob-base"] ?? (dark ? "oklch(0.98 0.003 90)" : "oklch(0.18 0.01 240)"),
    "state-modified":
      tokens["state-modified"] ?? `color-mix(in oklab, ${tokens["status-info"]} 90%, ${tint})`,
    "diff-insert-background":
      tokens["diff-insert-background"] ?? withAlpha(tokens["status-success"], dark ? 0.18 : 0.1),
    "diff-insert-edit-background":
      tokens["diff-insert-edit-background"] ??
      withAlpha(tokens["status-success"], dark ? 0.28 : 0.2),
    "diff-delete-background":
      tokens["diff-delete-background"] ?? withAlpha(tokens["status-danger"], dark ? 0.18 : 0.1),
    "diff-delete-edit-background":
      tokens["diff-delete-edit-background"] ??
      withAlpha(tokens["status-danger"], dark ? 0.28 : 0.2),
    "diff-gutter-insert": tokens["diff-gutter-insert"] ?? tokens["status-success"],
    "diff-gutter-delete": tokens["diff-gutter-delete"] ?? tokens["status-danger"],
    "diff-selected-background":
      tokens["diff-selected-background"] ?? withAlpha(overlayTone, dark ? 0.06 : 0.06),
    "diff-omit-gutter-line": tokens["diff-omit-gutter-line"] ?? tokens["activity-idle"],
    // Status surfaces: pre-baked tinted washes for banners/pills. Derived via
    // withAlpha (rgba for hex) so they don't carry the color-mix(..., transparent)
    // form, which black-shifts on light backgrounds in oklab (Chromium).
    "status-danger-surface":
      tokens["status-danger-surface"] ??
      withAlpha(tokens["status-danger"], statusSurfaceAlpha(dark ? 0.1 : 0.08)),
    "status-success-surface":
      tokens["status-success-surface"] ??
      withAlpha(tokens["status-success"], statusSurfaceAlpha(dark ? 0.1 : 0.08)),
    "status-warning-surface":
      tokens["status-warning-surface"] ??
      withAlpha(tokens["status-warning"], statusSurfaceAlpha(dark ? 0.1 : 0.08)),
    "status-info-surface":
      tokens["status-info-surface"] ??
      withAlpha(tokens["status-info"], statusSurfaceAlpha(dark ? 0.1 : 0.08)),
    ...tokens,
  };
}

export interface ShadowProfiles {
  ambient: string;
  floating: string;
  dialog: string;
}

/**
 * Resolve the three elevation-shadow tokens from a shadow style. Shared by
 * `compilePaletteToTokens` and `createSemanticTokens` so both code paths stay
 * in lockstep.
 *
 * RC-5: the "light" profile is the default for light themes. The dark engine is
 * an additive-glow model — atmospheric/soft shadows read as foggy depth over a
 * low-L field. On a near-white canvas, dark's hard "crisp" hairline reads as a
 * dirty edge, so the light profile uses large radii with low-but-present alpha
 * (~0.10-0.14) and a cool/hued ink (slate-blue) so the shadow reads as airy lift,
 * not grime. "crisp" stays available as an explicit per-theme opt-in.
 */
export function resolveShadowProfiles(
  shadowStyle: "none" | "crisp" | "soft" | "atmospheric" | "light"
): ShadowProfiles {
  switch (shadowStyle) {
    case "none":
      return {
        ambient: "none",
        floating: "none",
        dialog: "0 0 0 1px var(--theme-border-subtle)",
      };
    case "crisp":
      return {
        ambient: "0 1px 2px rgba(0, 0, 0, 0.2)",
        floating: "0 4px 8px rgba(0, 0, 0, 0.3)",
        dialog: "0 8px 16px rgba(0, 0, 0, 0.3)",
      };
    case "atmospheric":
      return {
        ambient: "0 4px 16px rgba(0, 0, 0, 0.15)",
        floating: "0 14px 40px rgba(0, 0, 0, 0.25)",
        dialog: "0 20px 56px rgba(0, 0, 0, 0.3)",
      };
    case "light":
      return {
        ambient: "0 8px 24px rgba(23, 33, 48, 0.1)",
        floating: "0 18px 48px rgba(23, 33, 48, 0.13)",
        dialog: "0 28px 64px rgba(23, 33, 48, 0.14)",
      };
    default:
      return {
        ambient: "0 2px 8px rgba(0, 0, 0, 0.06)",
        floating: "0 4px 12px rgba(0, 0, 0, 0.12)",
        dialog: "0 12px 32px rgba(0, 0, 0, 0.15)",
      };
  }
}

/**
 * Material opacity for translucent chrome. Blur>0 implies a frosted-glass
 * surface that needs a hair of transparency to read as glass on dark. RC-9:
 * on light, translucent chrome over a near-white field shows nothing through
 * and only hazes the chrome, so light stays fully opaque.
 */
export function resolveMaterialOpacity(type: "dark" | "light", blur: number | undefined): string {
  if (type === "light") return "1";
  return blur && blur > 0 ? "0.9" : "1";
}

/**
 * Chrome grain texture. RC-9: the gradient ink is type-aware — white grain over
 * a dark field, a cool near-black grain over a light field (a white radial is
 * invisible on near-white and only the dark grain registers).
 */
export function resolveChromeNoiseTexture(
  type: "dark" | "light",
  noiseOpacity: number | undefined
): string {
  if (!noiseOpacity || noiseOpacity <= 0) return "none";
  const ink = type === "light" ? "15 20 28" : "255 255 255";
  return `radial-gradient(circle at 20% 20%, rgb(${ink} / ${noiseOpacity}), transparent 55%)`;
}

function grainSvgDataUri(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// Curated tiling grain textures for strategy.grainCharacter. SVG feTurbulence
// tiles (stitchTiles keeps the repeat seamless at 1x/2x DPR); coarse ≈
// granular sand/basalt/salt, paper ≈ washi/fiber mottle.
const GRAIN_CHARACTER_IMAGES = {
  coarse: grainSvgDataUri(
    "<svg xmlns='http://www.w3.org/2000/svg' width='128' height='128'><filter id='g'><feTurbulence type='turbulence' baseFrequency='0.42' numOctaves='2' seed='7' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='128' height='128' filter='url(#g)'/></svg>"
  ),
  paper: grainSvgDataUri(
    "<svg xmlns='http://www.w3.org/2000/svg' width='128' height='128'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='1' seed='11' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='128' height='128' filter='url(#g)'/></svg>"
  ),
} as const;

/**
 * Resolve strategy.grainCharacter into the conditionally-emitted `grain-image`
 * extension value. Unset/"fine" returns undefined so NO var is emitted and the
 * CSS fallback keeps the bundled noise.png — a relative url() inside a :root
 * custom property resolves against the document, not the stylesheet, so the
 * asset reference must stay in src/index.css. "none" disables the layer.
 */
export function resolveGrainImage(
  grainCharacter: ThemeStrategy["grainCharacter"]
): string | undefined {
  switch (grainCharacter) {
    case "coarse":
      return GRAIN_CHARACTER_IMAGES.coarse;
    case "paper":
      return GRAIN_CHARACTER_IMAGES.paper;
    case "none":
      return "none";
    default:
      return undefined;
  }
}

function resolveStrategyExtensions(
  palette: ThemePalette | undefined,
  explicit: Partial<Record<ExtensionKey, string>> | undefined
): Partial<Record<ExtensionKey, string>> | undefined {
  const grainImage = resolveGrainImage(palette?.strategy?.grainCharacter);
  if (grainImage === undefined) return explicit;
  // An explicitly authored grain-image extension wins over the strategy field.
  return { "grain-image": grainImage, ...explicit };
}

function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("#")) {
    return `rgba(${hexToRgbTriplet(color)}, ${alpha})`;
  }
  return `color-mix(in oklab, ${color} ${(alpha * 100).toFixed(1)}%, transparent)`;
}

const INTERNAL_LIGHT_FALLBACK_SOURCE: BuiltInThemeSource = {
  id: "daintree-light-base",
  name: "Daintree Light Base",
  type: "light",
  builtin: true,
  palette: {
    type: "light",
    surfaces: {
      grid: "#CDD3DB",
      sidebar: "#D8DEE6",
      canvas: "#ECF0F5",
      panel: "#F5F8FB",
      elevated: "#FCFDFE",
    },
    text: {
      primary: "#1E252E",
      secondary: "#4A5562",
      muted: "#7D8896",
      inverse: "#FCFDFE",
    },
    border: "#C0C8D1",
    accent: "#1A7258",
    status: {
      success: "#31684B",
      warning: "#9E5D1B",
      danger: "#AD4035",
      info: "#1C5478",
    },
    activity: {
      active: "#2D7A4A",
      idle: "#7D8896",
      working: "#2D7A4A",
      waiting: "#9E7A15",
    },
    terminal: {
      selection: "#2A3A4A",
      red: "#f87171",
      green: "#10b981",
      yellow: "#fbbf24",
      blue: "#38bdf8",
      magenta: "#a855f7",
      cyan: "#22d3ee",
      brightRed: "#fca5a5",
      brightGreen: "#34d399",
      brightYellow: "#fcd34d",
      brightBlue: "#7dd3fc",
      brightMagenta: "#c084fc",
      brightCyan: "#67e8f9",
      brightWhite: "#fafafa",
    },
    syntax: {
      comment: "#707b90",
      punctuation: "#c5d0f5",
      number: "#efb36b",
      string: "#95c879",
      operator: "#8acfe1",
      keyword: "#bc9cef",
      function: "#84adf8",
      link: "#72c1ea",
      quote: "#adb5bb",
      chip: "#7fd4cf",
    },
  },
};

function createThemeFromSource(source: BuiltInThemeSource): AppColorScheme {
  const compiledTokens = compilePaletteToTokens(source.palette);
  const tokens = source.tokens
    ? normalizeAppThemeTokens(source.tokens, compiledTokens)
    : compiledTokens;
  const extensions = resolveStrategyExtensions(source.palette, source.extensions);

  return {
    id: source.id,
    name: source.name,
    type: source.type,
    builtin: source.builtin,
    tokens,
    palette: source.palette,
    ...(extensions ? { extensions } : {}),
    ...(source.location ? { location: source.location } : {}),
    ...(source.heroImage ? { heroImage: source.heroImage } : {}),
  };
}

const INTERNAL_LIGHT_FALLBACK_SCHEME = createThemeFromSource(INTERNAL_LIGHT_FALLBACK_SOURCE);

export const BUILT_IN_APP_SCHEMES: AppColorScheme[] =
  BUILT_IN_THEME_SOURCES.map(createThemeFromSource);

export const APP_THEME_PREVIEW_KEYS = {
  background: "surface-canvas",
  sidebar: "surface-sidebar",
  accent: "accent-primary",
  success: "status-success",
  warning: "status-warning",
  danger: "status-danger",
  text: "text-primary",
  border: "border-default",
  panel: "surface-panel",
} as const satisfies Record<string, AppThemeTokenKey>;

export function hexToRgbTriplet(hex: string): string {
  const clean = hex.replace("#", "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : clean;
  const red = parseInt(expanded.slice(0, 2), 16);
  const green = parseInt(expanded.slice(2, 4), 16);
  const blue = parseInt(expanded.slice(4, 6), 16);
  if (Number.isNaN(red) || Number.isNaN(green) || Number.isNaN(blue)) {
    return "0, 0, 0";
  }
  return `${red}, ${green}, ${blue}`;
}

/**
 * Normalize a user-supplied accent color to canonical lowercase `#rrggbb`.
 * Accepts values with or without a leading `#`, case-insensitive, 3-digit or
 * 6-digit hex. Returns `null` for any other input. Used as the single source of
 * truth for accent override validation on both sides of the IPC boundary.
 */
export function normalizeAccentHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const clean = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(clean)) return null;
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : clean;
  return `#${expanded.toLowerCase()}`;
}

/**
 * Derive the six accent tokens from a single user-picked hex color. Mirrors
 * the formulas in `createDaintreeTokens` so the override is indistinguishable
 * from a theme's native accent.
 *
 * - `accent-primary`: the hex itself
 * - `accent-hover`: `color-mix(in oklab, hex 90%, #fff)` (brightened — advances on hover for both polarities)
 * - `accent-soft`: `rgba(triplet, 0.18)`
 * - `accent-muted`: `rgba(triplet, 0.30)`
 * - `accent-rgb`: `R, G, B` triplet for use inside `rgba(var(--theme-accent-rgb), a)`
 * - `accent-foreground`: best WCAG contrast from the scheme's own text-inverse / text-primary + white/black
 */
export function computeAccentOverrideTokens(
  accentHex: string,
  baseScheme: Pick<AppColorScheme, "type" | "tokens">
): Pick<
  AppColorSchemeTokens,
  | "accent-primary"
  | "accent-hover"
  | "accent-foreground"
  | "accent-soft"
  | "accent-muted"
  | "accent-rgb"
> {
  const normalized = normalizeAccentHex(accentHex);
  if (!normalized) {
    throw new Error(`computeAccentOverrideTokens: invalid accent hex "${accentHex}"`);
  }
  const dark = baseScheme.type === "dark";
  return {
    "accent-primary": normalized,
    "accent-hover": `color-mix(in oklab, ${normalized} 90%, #ffffff)`,
    "accent-soft": withAlpha(normalized, dark ? 0.18 : 0.18),
    "accent-muted": withAlpha(normalized, dark ? 0.3 : 0.3),
    "accent-rgb": hexToRgbTriplet(normalized),
    "accent-foreground": pickReadableForeground(normalized, [
      baseScheme.tokens["text-inverse"],
      baseScheme.tokens["text-primary"],
      "#ffffff",
      "#000000",
    ]),
  };
}

/**
 * Return a new scheme with accent tokens patched from the override hex, or the
 * same scheme reference when no (valid) override is active. Safe to pass an
 * invalid hex — the input is silently returned unchanged, matching the
 * no-override branch so callers can call unconditionally.
 */
export function applyAccentOverrideToScheme(
  scheme: AppColorScheme,
  accentHex: string | null | undefined
): AppColorScheme {
  const normalized = normalizeAccentHex(accentHex);
  if (!normalized) return scheme;
  return {
    ...scheme,
    tokens: {
      ...scheme.tokens,
      ...computeAccentOverrideTokens(normalized, scheme),
    },
  };
}

export function getAppThemeById(
  id: string,
  customSchemes: AppColorScheme[] = []
): AppColorScheme | undefined {
  return (
    BUILT_IN_APP_SCHEMES.find((scheme) => scheme.id === id) ??
    customSchemes.find((scheme) => scheme.id === id)
  );
}

export function getBuiltInAppSchemeForType(type: "dark" | "light"): AppColorScheme {
  return (
    BUILT_IN_APP_SCHEMES.find((scheme) => scheme.type === type) ??
    (type === "light" ? INTERNAL_LIGHT_FALLBACK_SCHEME : BUILT_IN_APP_SCHEMES[0]!)
  );
}

export function resolveAppTheme(id: string, customSchemes: AppColorScheme[] = []): AppColorScheme {
  return getAppThemeById(id, customSchemes) ?? BUILT_IN_APP_SCHEMES[0]!;
}

export function getAppThemeCssVariables(scheme: AppColorScheme): Record<string, string> {
  const entries = Object.entries(scheme.tokens).map(([token, value]) => [
    `--theme-${token}`,
    value,
  ]);
  const variables = Object.fromEntries(entries);
  variables["--theme-color-mode"] = scheme.type;
  if (scheme.extensions) {
    for (const [extensionName, extensionValue] of Object.entries(scheme.extensions)) {
      if (typeof extensionValue === "string" && extensionValue.trim()) {
        variables[`--${extensionName}`] = extensionValue;
      }
    }
  }
  return variables;
}

export function normalizeAppThemeTokens(
  maybeTokens: Record<string, unknown>,
  fallback: AppColorSchemeTokens = BUILT_IN_APP_SCHEMES[0]!.tokens
): AppColorSchemeTokens {
  const normalized = { ...fallback };
  for (const token of Object.keys(fallback) as AppThemeTokenKey[]) {
    const value = maybeTokens[token];
    if (typeof value === "string" && value.trim()) {
      normalized[token] = value;
    }
  }
  return normalized;
}

function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}

function inferThemeTypeFromHex(hex: string): "dark" | "light" {
  const clean = hex.replace("#", "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : clean;
  const red = parseInt(expanded.slice(0, 2), 16);
  const green = parseInt(expanded.slice(2, 4), 16);
  const blue = parseInt(expanded.slice(4, 6), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance < 0.5 ? "dark" : "light";
}

export function inferAppThemeTypeFromTokens(
  maybeTokens: Record<string, unknown>
): "dark" | "light" | undefined {
  const surfaceToken = maybeTokens["surface-canvas"];
  if (typeof surfaceToken === "string" && isHexColor(surfaceToken.trim())) {
    return inferThemeTypeFromHex(surfaceToken.trim());
  }
  return undefined;
}

function hexToLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : clean;
  const red = hexToLinear(parseInt(expanded.slice(0, 2), 16));
  const green = hexToLinear(parseInt(expanded.slice(2, 4), 16));
  const blue = hexToLinear(parseInt(expanded.slice(4, 6), 16));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const l1 = relativeLuminance(foreground);
  const l2 = relativeLuminance(background);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function pickReadableForeground(background: string, candidates: string[]): string {
  const validCandidates = candidates.filter(isHexColor);
  if (!isHexColor(background) || validCandidates.length === 0) {
    return "#000000";
  }
  let bestCandidate = validCandidates[0]!;
  let bestContrast = contrastRatio(bestCandidate, background);
  for (const candidate of validCandidates.slice(1)) {
    const candidateContrast = contrastRatio(candidate, background);
    if (candidateContrast > bestContrast) {
      bestCandidate = candidate;
      bestContrast = candidateContrast;
    }
  }
  return bestCandidate;
}

export function getAppThemeWarnings(scheme: AppColorScheme): AppThemeValidationWarning[] {
  const warnings = getThemeContrastWarnings(scheme);
  const accentPrimary = scheme.tokens["accent-primary"];
  const accentRgb = scheme.tokens["accent-rgb"];
  if (
    typeof accentPrimary === "string" &&
    !accentPrimary.startsWith("#") &&
    accentRgb === "0, 0, 0"
  ) {
    warnings.push({
      kind: "accent-rgb-fallback",
      message:
        'accent-rgb falls back to "0, 0, 0" because accent-primary is non-hex and no explicit accent-rgb override was provided. Components using rgba(var(--theme-accent-rgb), …) will render black tints.',
    });
  }
  return warnings;
}

function compilePaletteToTokens(palette: ThemePalette): AppColorSchemeTokens {
  const strategy = palette.strategy;
  const shadowStyle = strategy?.shadowStyle ?? (palette.type === "dark" ? "soft" : "light");
  const shadowProfiles = resolveShadowProfiles(shadowStyle);

  return createDaintreeTokens(
    palette.type,
    {
      "surface-grid": palette.surfaces.grid,
      "surface-sidebar": palette.surfaces.sidebar,
      "surface-canvas": palette.surfaces.canvas,
      "surface-panel": palette.surfaces.panel,
      "surface-panel-elevated": palette.surfaces.elevated,
      "text-primary": palette.text.primary,
      "text-secondary": palette.text.secondary,
      "text-muted": palette.text.muted,
      "text-inverse": palette.text.inverse,
      "border-default": palette.border,
      "accent-primary": palette.accent,
      ...(palette.accentSecondary ? { "accent-secondary": palette.accentSecondary } : {}),
      "status-success": palette.status.success,
      "status-warning": palette.status.warning,
      "status-danger": palette.status.danger,
      "status-info": palette.status.info,
      "activity-active": palette.activity.active,
      "activity-idle": palette.activity.idle,
      "activity-working": palette.activity.working,
      "activity-waiting": palette.activity.waiting,
      ...(palette.overlayTint ? { "overlay-base": palette.overlayTint } : {}),
      "terminal-background": palette.terminal?.background ?? palette.surfaces.canvas,
      "terminal-foreground": palette.terminal?.foreground ?? palette.text.primary,
      "terminal-muted": palette.terminal?.muted ?? palette.text.muted,
      "terminal-cursor": palette.terminal?.cursor ?? palette.accent,
      "terminal-selection": palette.terminal?.selection ?? palette.accent,
      "terminal-red": palette.terminal?.red ?? palette.status.danger,
      "terminal-green": palette.terminal?.green ?? palette.status.success,
      "terminal-yellow": palette.terminal?.yellow ?? palette.status.warning,
      "terminal-blue": palette.terminal?.blue ?? palette.status.info,
      "terminal-magenta": palette.terminal?.magenta ?? ANSI_MAGENTA_FALLBACK,
      "terminal-cyan": palette.terminal?.cyan ?? ANSI_CYAN_FALLBACK,
      "terminal-bright-red": palette.terminal?.brightRed ?? palette.status.danger,
      "terminal-bright-green": palette.terminal?.brightGreen ?? palette.status.success,
      "terminal-bright-yellow": palette.terminal?.brightYellow ?? palette.status.warning,
      "terminal-bright-blue": palette.terminal?.brightBlue ?? palette.status.info,
      "terminal-bright-magenta": palette.terminal?.brightMagenta ?? ANSI_MAGENTA_FALLBACK,
      "terminal-bright-cyan": palette.terminal?.brightCyan ?? ANSI_CYAN_FALLBACK,
      "terminal-bright-white": palette.terminal?.brightWhite ?? palette.text.primary,
      "syntax-comment": palette.syntax.comment,
      "syntax-punctuation": palette.syntax.punctuation,
      "syntax-number": palette.syntax.number,
      "syntax-string": palette.syntax.string,
      "syntax-operator": palette.syntax.operator,
      "syntax-keyword": palette.syntax.keyword,
      "syntax-function": palette.syntax.function,
      "syntax-link": palette.syntax.link,
      "syntax-quote": palette.syntax.quote,
      "syntax-chip": palette.syntax.chip,
      "shadow-ambient": shadowProfiles.ambient,
      "shadow-floating": shadowProfiles.floating,
      "shadow-dialog": shadowProfiles.dialog,
      "material-blur": `${strategy?.materialBlur ?? 0}px`,
      "material-saturation": `${strategy?.materialSaturation ?? 100}%`,
      "material-opacity": resolveMaterialOpacity(palette.type, strategy?.materialBlur),
      "radius-scale": String(strategy?.radiusScale ?? 1),
      "chrome-noise-texture": resolveChromeNoiseTexture(palette.type, strategy?.noiseOpacity),
      "panel-state-edge-width":
        (strategy?.panelStateEdge ?? palette.type === "light") ? "2px" : "0px",
    },
    {
      borderInkOverride: strategy?.borderInkOverride,
      statusSurfaceOpacity: strategy?.statusSurfaceOpacity,
    }
  );
}

export function normalizeAppColorScheme(
  maybeScheme: Partial<Omit<AppColorScheme, "tokens">> & { tokens?: Record<string, unknown> },
  fallback: AppColorScheme = BUILT_IN_APP_SCHEMES[0]!
): AppColorScheme {
  const palette = maybeScheme.palette;
  const explicitType =
    maybeScheme.type === "light"
      ? "light"
      : maybeScheme.type === "dark"
        ? "dark"
        : palette?.type === "light"
          ? "light"
          : palette?.type === "dark"
            ? "dark"
            : inferAppThemeTypeFromTokens(
                (maybeScheme.tokens as Record<string, unknown> | undefined) ?? {}
              );
  const resolvedType = explicitType ?? fallback.type;
  const baseScheme =
    fallback.type === resolvedType ? fallback : getBuiltInAppSchemeForType(resolvedType);
  const tint = resolvedType === "dark" ? "#ffffff" : "#000000";
  const rawTokens = (palette ? compilePaletteToTokens(palette) : maybeScheme.tokens) as
    Record<string, unknown> | undefined;
  const tokenOverrides = (maybeScheme.tokens as Record<string, unknown> | undefined) ?? {};
  const normalizedTokens = normalizeAppThemeTokens(rawTokens ?? {}, baseScheme.tokens);
  Object.assign(normalizedTokens, normalizeAppThemeTokens(tokenOverrides, normalizedTokens));
  if (
    typeof tokenOverrides["accent-foreground"] !== "string" &&
    typeof normalizedTokens["accent-primary"] === "string"
  ) {
    normalizedTokens["accent-foreground"] = pickReadableForeground(
      normalizedTokens["accent-primary"],
      [normalizedTokens["text-inverse"], normalizedTokens["text-primary"], "#ffffff", "#000000"]
    );
  }

  if (!palette && typeof rawTokens === "object") {
    const statusSurfaceAlpha = resolvedType === "dark" ? 0.1 : 0.08;
    for (const status of ["danger", "success", "warning", "info"] as const) {
      const surfaceKey = `status-${status}-surface` as const;
      const baseKey = `status-${status}` as const;
      // normalizedTokens is seeded from the fallback scheme, so its surface key
      // is always a string — guarding on it would never fire. Re-derive only
      // when the plugin set a custom base color but no matching surface, else
      // the fallback scheme's (differently-hued) surface would leak through.
      if (
        typeof tokenOverrides[surfaceKey] !== "string" &&
        typeof tokenOverrides[baseKey] === "string" &&
        typeof normalizedTokens[baseKey] === "string"
      ) {
        normalizedTokens[surfaceKey] = withAlpha(normalizedTokens[baseKey], statusSurfaceAlpha);
      }
    }
    if (
      typeof normalizedTokens["state-modified"] !== "string" &&
      typeof normalizedTokens["status-info"] === "string"
    ) {
      normalizedTokens["state-modified"] =
        `color-mix(in oklab, ${normalizedTokens["status-info"]} 90%, ${tint})`;
    }
  }
  const normalizedExtensions = resolveStrategyExtensions(palette, maybeScheme.extensions);
  const result: AppColorScheme = {
    id:
      typeof maybeScheme.id === "string" && maybeScheme.id.trim() ? maybeScheme.id : baseScheme.id,
    name:
      typeof maybeScheme.name === "string" && maybeScheme.name.trim()
        ? maybeScheme.name
        : baseScheme.name,
    type: resolvedType,
    builtin: false,
    tokens: normalizedTokens,
    ...(palette ? { palette } : {}),
    ...(normalizedExtensions ? { extensions: normalizedExtensions } : {}),
  };
  if (typeof maybeScheme.location === "string") result.location = maybeScheme.location;
  if (typeof maybeScheme.heroImage === "string") result.heroImage = maybeScheme.heroImage;
  return result;
}
