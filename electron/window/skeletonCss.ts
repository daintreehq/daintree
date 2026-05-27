// eager-import-allow: reads theme tokens via store.get synchronously to inline first-paint skeleton CSS
/**
 * Injects CSS custom properties into a WebContents so the HTML skeleton
 * in index.html renders with the correct theme and layout dimensions
 * before React mounts.
 *
 * Called from both createWindow (initial load) and ProjectViewManager
 * (project switch cold starts).
 */
import { nativeTheme, type WebContents } from "electron";
import { store } from "../store.js";
import { resolveAppTheme, getAppThemeCssVariables } from "../../shared/theme/index.js";
import type { AppColorScheme } from "../../shared/theme/index.js";
import {
  appCustomSchemesReadSchema,
  appCustomSchemesWriteSchema,
  migrateCustomSchemes,
} from "../schemas/customSchemes.js";

/**
 * Command-line argument carrying the persisted color scheme id from the main
 * process into each renderer context. Read synchronously in preload.cts from
 * `process.argv` (available even under `sandbox: true`) and exposed to the
 * renderer as `window.__DAINTREE_INITIAL_THEME__` so first paint applies the
 * saved theme instead of a `prefers-color-scheme` default (#9169).
 */
export const INITIAL_COLOR_SCHEME_ARG = "--daintree-initial-color-scheme-id";

/**
 * Resolves the color scheme id to seed the renderer with on cold start.
 * Mirrors the fallback logic in createWindow and getAppThemeConfig: the raw
 * persisted id when present (without resolving `followSystem` — that happens
 * post-mount), else Daintree's dark default, or Bondi when the OS prefers a
 * light appearance.
 */
export function resolveInitialColorSchemeId(): string {
  const themeConfig = store.get("appTheme");
  if (
    themeConfig &&
    typeof themeConfig === "object" &&
    !Array.isArray(themeConfig) &&
    "colorSchemeId" in themeConfig &&
    typeof themeConfig.colorSchemeId === "string" &&
    themeConfig.colorSchemeId.trim()
  ) {
    return themeConfig.colorSchemeId.trim();
  }
  return process.env.DAINTREE_SCREENSHOT_SCALE || nativeTheme.shouldUseDarkColors
    ? "daintree"
    : "bondi";
}

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

  // Reserve space for Windows native caption buttons in the pre-React skeleton
  // (consumed by index.html's .skeleton-toolbar-right). The live Toolbar reads
  // env(titlebar-area-width) directly via the Window Controls Overlay API, so
  // this variable only covers the brief skeleton phase before WCO env vars are
  // wired up in the renderer. 138px ≈ 3 × 46px backplates on Windows 11 @ 96 DPI.
  // See issues #7951 and #8167.
  if (process.platform === "win32") {
    lines.push("  --win-caption-width: 138px;");
  }

  lines.push("}");

  // If focus mode is active, hide the skeleton sidebar
  if (focusMode) {
    lines.push("#startup-skeleton .skeleton-sidebar { display: none; }");
  }

  void wc.insertCSS(lines.join("\n"), { cssOrigin: "user" });
}
