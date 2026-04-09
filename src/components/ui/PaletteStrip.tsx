import { APP_THEME_PREVIEW_KEYS } from "@shared/theme";
import type { AppColorScheme } from "@shared/types/appTheme";

export function PaletteStrip({ scheme }: { scheme: AppColorScheme }) {
  const t = scheme.tokens;
  const keys = [
    APP_THEME_PREVIEW_KEYS.accent,
    APP_THEME_PREVIEW_KEYS.success,
    APP_THEME_PREVIEW_KEYS.warning,
    APP_THEME_PREVIEW_KEYS.danger,
    APP_THEME_PREVIEW_KEYS.text,
    APP_THEME_PREVIEW_KEYS.border,
    APP_THEME_PREVIEW_KEYS.panel,
    APP_THEME_PREVIEW_KEYS.sidebar,
  ] as const;
  return (
    <div className="flex gap-0.5">
      {keys.map((key) => (
        <div
          key={key}
          className="w-3 h-3 rounded-sm shrink-0"
          style={{ backgroundColor: t[key] }}
        />
      ))}
    </div>
  );
}
