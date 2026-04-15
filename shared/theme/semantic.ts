import type { ThemePalette } from "./palette.js";
import { createDaintreeTokens } from "./themes.js";
import type { AppColorSchemeTokens } from "./types.js";

export function createSemanticTokens(palette: ThemePalette): AppColorSchemeTokens {
  const strategy = palette.strategy;
  const shadowStyle = strategy?.shadowStyle ?? (palette.type === "dark" ? "soft" : "crisp");

  const shadowProfiles =
    shadowStyle === "none"
      ? {
          ambient: "none",
          floating: "none",
          dialog: "0 0 0 1px var(--theme-border-subtle)",
        }
      : shadowStyle === "crisp"
        ? {
            ambient: "0 1px 2px rgba(0, 0, 0, 0.2)",
            floating: "0 4px 8px rgba(0, 0, 0, 0.3)",
            dialog: "0 8px 16px rgba(0, 0, 0, 0.3)",
          }
        : shadowStyle === "atmospheric"
          ? {
              ambient: "0 4px 16px rgba(0, 0, 0, 0.15)",
              floating: "0 14px 40px rgba(0, 0, 0, 0.25)",
              dialog: "0 20px 56px rgba(0, 0, 0, 0.3)",
            }
          : {
              ambient: "0 2px 8px rgba(0, 0, 0, 0.06)",
              floating: "0 4px 12px rgba(0, 0, 0, 0.12)",
              dialog: "0 12px 32px rgba(0, 0, 0, 0.15)",
            };

  return createDaintreeTokens(palette.type, {
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
    "terminal-magenta": palette.terminal?.magenta ?? palette.accent,
    "terminal-cyan": palette.terminal?.cyan ?? palette.activity.active,
    "terminal-bright-red": palette.terminal?.brightRed ?? palette.status.danger,
    "terminal-bright-green": palette.terminal?.brightGreen ?? palette.status.success,
    "terminal-bright-yellow": palette.terminal?.brightYellow ?? palette.status.warning,
    "terminal-bright-blue": palette.terminal?.brightBlue ?? palette.status.info,
    "terminal-bright-magenta": palette.terminal?.brightMagenta ?? palette.accent,
    "terminal-bright-cyan": palette.terminal?.brightCyan ?? palette.activity.active,
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
    "material-opacity": strategy?.materialBlur && strategy.materialBlur > 0 ? "0.9" : "1",
    "radius-scale": String(strategy?.radiusScale ?? 1),
    "chrome-noise-texture":
      strategy?.noiseOpacity && strategy.noiseOpacity > 0
        ? `radial-gradient(circle at 20% 20%, rgb(255 255 255 / ${strategy.noiseOpacity}), transparent 55%)`
        : "none",
    "panel-state-edge-width":
      (strategy?.panelStateEdge ?? palette.type === "light") ? "2px" : "0px",
  });
}
