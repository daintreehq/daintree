import type { ThemePalette } from "./palette.js";
import {
  ANSI_CYAN_FALLBACK,
  ANSI_MAGENTA_FALLBACK,
  createDaintreeTokens,
  resolveChromeNoiseTexture,
  resolveMaterialOpacity,
  resolveShadowProfiles,
} from "./themes.js";
import type { AppColorSchemeTokens } from "./types.js";

export function createSemanticTokens(palette: ThemePalette): AppColorSchemeTokens {
  const strategy = palette.strategy;
  // RC-5: light themes default to the large-radius, low-alpha, cool-ink "light"
  // shadow profile instead of the dirty "crisp" hairline. "crisp" stays an opt-in.
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
