import { APP_THEME_PREVIEW_KEYS } from "@shared/theme";
import type { AppColorScheme } from "@shared/types/appTheme";

/**
 * `full` shows the whole preview palette. `compact` drops border/panel/sidebar:
 * in a dense list row those three land within a few percent of the surface
 * they sit on, so they read as gaps rather than colours while still costing
 * the width that the theme's name and location need.
 */
const PREVIEW_KEYS = {
  full: [
    APP_THEME_PREVIEW_KEYS.accent,
    APP_THEME_PREVIEW_KEYS.success,
    APP_THEME_PREVIEW_KEYS.warning,
    APP_THEME_PREVIEW_KEYS.danger,
    APP_THEME_PREVIEW_KEYS.text,
    APP_THEME_PREVIEW_KEYS.border,
    APP_THEME_PREVIEW_KEYS.panel,
    APP_THEME_PREVIEW_KEYS.sidebar,
  ],
  compact: [
    APP_THEME_PREVIEW_KEYS.accent,
    APP_THEME_PREVIEW_KEYS.success,
    APP_THEME_PREVIEW_KEYS.warning,
    APP_THEME_PREVIEW_KEYS.danger,
    APP_THEME_PREVIEW_KEYS.text,
  ],
} as const;

export function PaletteStrip({
  scheme,
  variant = "full",
}: {
  scheme: AppColorScheme;
  variant?: keyof typeof PREVIEW_KEYS;
}) {
  const t = scheme.tokens;
  return (
    <div className="flex gap-0.5" aria-hidden="true">
      {PREVIEW_KEYS[variant].map((key) => (
        <div
          key={key}
          className="w-3 h-3 rounded-sm shrink-0 ring-1 ring-inset ring-border-default/30"
          style={{ backgroundColor: t[key] }}
        />
      ))}
    </div>
  );
}
