/**
 * Injects CSS custom properties into a WebContents so the HTML skeleton
 * in index.html renders with the correct theme and layout dimensions
 * before React mounts.
 *
 * Called from both createWindow (initial load) and ProjectViewManager
 * (project switch cold starts).
 */
import type { WebContents } from "electron";
import { store } from "../store.js";
import { resolveAppTheme, getAppThemeCssVariables } from "../../shared/theme/index.js";
import type { AppColorScheme } from "../../shared/theme/index.js";
import {
  appCustomSchemesReadSchema,
  appCustomSchemesWriteSchema,
  migrateCustomSchemes,
} from "../schemas/customSchemes.js";

export function injectSkeletonCss(wc: WebContents): void {
  const appState = store.get("appState");
  const sidebarWidth = appState?.sidebarWidth ?? 350;
  const focusMode = appState?.focusMode ?? false;

  // Resolve theme
  const themeConfig = store.get("appTheme") ?? {};
  const colorSchemeId =
    typeof themeConfig.colorSchemeId === "string" ? themeConfig.colorSchemeId : "daintree";
  // Apply lazy migration for legacy string-encoded customSchemes
  let customSchemes: AppColorScheme[] = [];
  const rawSchemes = (themeConfig as Record<string, unknown>).customSchemes;
  if (rawSchemes !== undefined) {
    const result = migrateCustomSchemes(
      rawSchemes,
      appCustomSchemesReadSchema,
      appCustomSchemesWriteSchema
    );
    customSchemes = result.schemes;
    if (result.migrated) {
      try {
        store.set("appTheme", {
          ...(themeConfig as Record<string, unknown>),
          customSchemes: result.schemes.length > 0 ? result.schemes : [],
        });
      } catch {
        // Non-fatal: config persisted but migration write failed
      }
    }
  }
  const scheme = resolveAppTheme(colorSchemeId, customSchemes);
  const themeVars = getAppThemeCssVariables(scheme);

  // Build CSS string
  const lines: string[] = [":root {"];

  // Theme tokens (--theme-surface-canvas, --theme-border-default, etc.)
  for (const [prop, value] of Object.entries(themeVars)) {
    lines.push(`  ${prop}: ${value};`);
  }

  // Layout state
  lines.push(`  --skeleton-sidebar-width: ${sidebarWidth}px;`);
  lines.push(`  --skeleton-focus-mode: ${focusMode ? "1" : "0"};`);

  lines.push("}");

  // If focus mode is active, hide the skeleton sidebar
  if (focusMode) {
    lines.push("#startup-skeleton .skeleton-sidebar { display: none; }");
  }

  void wc.insertCSS(lines.join("\n"), { cssOrigin: "user" });
}
