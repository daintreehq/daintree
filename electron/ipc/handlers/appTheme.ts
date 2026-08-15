// eager-import-allow: reads the persisted theme via store.get synchronously so the IPC reply is immediate
import { dialog, BrowserWindow, nativeTheme } from "electron";
import { promises as fs } from "node:fs";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { parseAppThemeFile } from "../../utils/appThemeImporter.js";
import { resolveAppTheme, normalizeAccentHex } from "../../../shared/theme/index.js";
import { typedHandle, typedHandleWithContext, typedSend } from "../utils.js";
import { setTitleBarOverlayTheme } from "../../window/titleBarOverlay.js";
import {
  appCustomSchemesReadSchema,
  appCustomSchemesWriteSchema,
  migrateCustomSchemes,
} from "../../schemas/customSchemes.js";
import type {
  AppThemeConfig,
  AppColorScheme,
  ColorVisionMode,
} from "../../../shared/types/appTheme.js";

const DEFAULT_DARK_SCHEME = "daintree";
const DEFAULT_LIGHT_SCHEME = "bondi";

function getAppThemeConfig(): AppThemeConfig {
  const config = store.get("appTheme");
  const hasStoredScheme =
    config &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    "colorSchemeId" in config &&
    typeof config.colorSchemeId === "string" &&
    config.colorSchemeId;

  if (hasStoredScheme) {
    const cfg = config as AppThemeConfig;
    // Lazy migration: parse legacy string into native AppColorScheme[]
    if (typeof cfg.customSchemes === "string" || Array.isArray(cfg.customSchemes)) {
      const result = migrateCustomSchemes(
        cfg.customSchemes,
        appCustomSchemesReadSchema,
        appCustomSchemesWriteSchema
      );
      if (result.migrated) {
        try {
          store.set(
            "appTheme.customSchemes",
            result.schemes.length > 0 ? (result.schemes as AppColorScheme[]) : []
          );
        } catch {
          // Non-fatal: config parsed but migration write failed
        }
      }
      if (result.errors.length > 0) {
        console.warn("[appTheme] customSchemes migration warnings:", result.errors.join("; "));
      }
      return { ...cfg, customSchemes: result.schemes as AppColorScheme[] };
    }
    return cfg;
  }

  // First-run default: always the dark Daintree scheme, regardless of OS
  // color-scheme preference. Users who want light or system-following
  // behavior opt in via Settings → Appearance (the auto-switch listener
  // below honors `followSystem` once it's enabled).
  return {
    ...(config && typeof config === "object" && !Array.isArray(config) ? config : {}),
    colorSchemeId:
      process.env.DAINTREE_SCREENSHOT_SCALE || nativeTheme.shouldUseDarkColors
        ? DEFAULT_DARK_SCHEME
        : DEFAULT_LIGHT_SCHEME,
    customSchemes: [],
  } as AppThemeConfig;
}

export function registerAppThemeHandlers(mainWindow?: BrowserWindow): () => void {
  const handlers: Array<() => void> = [];

  /**
   * Push the freshly-persisted scheme at every window's caption strip.
   * Picking a theme in settings only writes the store — without this the
   * native strip keeps the previous theme's colours until an OS appearance
   * change happens to reapply them (#11766).
   */
  const refreshTitleBarOverlayTheme = () => {
    if (process.platform !== "win32") return;
    const config = getAppThemeConfig();
    const scheme = resolveAppTheme(config.colorSchemeId, config.customSchemes ?? []);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) setTitleBarOverlayTheme(win, scheme.tokens);
    }
  };

  handlers.push(typedHandle(CHANNELS.APP_THEME_GET, async () => getAppThemeConfig()));

  handlers.push(
    typedHandle(CHANNELS.APP_THEME_SET_COLOR_SCHEME, async (schemeId: string) => {
      if (typeof schemeId !== "string" || !schemeId.trim()) {
        console.warn("Invalid app theme colorSchemeId:", schemeId);
        return;
      }
      store.set("appTheme.colorSchemeId", schemeId.trim());
      refreshTitleBarOverlayTheme();
    })
  );

  handlers.push(
    typedHandle(CHANNELS.APP_THEME_SET_CUSTOM_SCHEMES, async (schemes: unknown) => {
      const result = appCustomSchemesWriteSchema.safeParse(schemes);
      if (!result.success) {
        console.warn("Invalid app custom schemes:", result.error.message);
        return;
      }
      store.set("appTheme.customSchemes", result.data as AppColorScheme[]);
      refreshTitleBarOverlayTheme();
    })
  );

  const VALID_COLOR_VISION_MODES = ["default", "red-green", "blue-yellow"];
  handlers.push(
    typedHandle(CHANNELS.APP_THEME_SET_COLOR_VISION_MODE, async (mode: ColorVisionMode) => {
      if (typeof mode !== "string" || !VALID_COLOR_VISION_MODES.includes(mode)) {
        console.warn("Invalid color vision mode:", mode);
        return;
      }
      store.set("appTheme.colorVisionMode", mode);
    })
  );

  handlers.push(
    // @ts-expect-error: handler returns AppThemeImportResult containing {success} — pending migration to throw AppError. See #6020.
    typedHandleWithContext(CHANNELS.APP_THEME_IMPORT, async (ctx) => {
      const win = ctx.senderWindow ?? BrowserWindow.getFocusedWindow();
      const dialogOptions = {
        title: "Import App Theme",
        filters: [
          { name: "Theme Files", extensions: ["json"] },
          { name: "All Files", extensions: ["*"] },
        ],
        properties: ["openFile" as const],
      };
      const result = win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, errors: ["Import cancelled"] };
      }

      return parseAppThemeFile(result.filePaths[0]);
    })
  );

  handlers.push(
    typedHandleWithContext(
      CHANNELS.APP_THEME_EXPORT,
      async (ctx, scheme: AppColorScheme): Promise<boolean> => {
        if (!scheme || typeof scheme.id !== "string" || typeof scheme.name !== "string") {
          return false;
        }

        const safeName =
          scheme.name
            .replace(/[\\/:*?"<>|]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200) || "theme";

        const win = ctx.senderWindow ?? BrowserWindow.getFocusedWindow();
        const dialogOptions = {
          title: "Export App Theme",
          defaultPath: `${safeName}.json`,
          filters: [
            { name: "Theme Files", extensions: ["json"] },
            { name: "All Files", extensions: ["*"] },
          ],
        };

        const { filePath, canceled } = win
          ? await dialog.showSaveDialog(win, dialogOptions)
          : await dialog.showSaveDialog(dialogOptions);

        if (canceled || !filePath) return false;

        const { location: _loc, builtin: _builtin, ...exportData } = scheme;
        await fs.writeFile(filePath, JSON.stringify(exportData, null, 2), "utf-8");
        return true;
      }
    )
  );

  handlers.push(
    typedHandle(CHANNELS.APP_THEME_SET_FOLLOW_SYSTEM, async (enabled: boolean) => {
      if (typeof enabled !== "boolean") return;
      store.set("appTheme.followSystem", enabled);
    })
  );

  handlers.push(
    typedHandle(CHANNELS.APP_THEME_SET_PREFERRED_DARK_SCHEME, async (schemeId: string) => {
      if (typeof schemeId !== "string" || !schemeId.trim()) return;
      store.set("appTheme.preferredDarkSchemeId", schemeId.trim());
    })
  );

  handlers.push(
    typedHandle(CHANNELS.APP_THEME_SET_PREFERRED_LIGHT_SCHEME, async (schemeId: string) => {
      if (typeof schemeId !== "string" || !schemeId.trim()) return;
      store.set("appTheme.preferredLightSchemeId", schemeId.trim());
    })
  );

  handlers.push(
    typedHandle(CHANNELS.APP_THEME_SET_RECENT_SCHEME_IDS, async (ids: unknown) => {
      if (!Array.isArray(ids)) {
        console.warn("Invalid app theme recentSchemeIds:", ids);
        return;
      }
      const trimmed = ids
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .map((id) => id.trim());
      const sanitized = Array.from(new Set(trimmed)).slice(0, 5);
      store.set("appTheme.recentSchemeIds", sanitized);
    })
  );

  handlers.push(
    typedHandle(CHANNELS.APP_THEME_SET_ACCENT_COLOR_OVERRIDE, async (color: unknown) => {
      let normalized: string | null = null;
      if (color !== null && color !== undefined) {
        normalized = normalizeAccentHex(color);
        if (normalized === null) {
          console.warn("Invalid accent color override:", color);
          return;
        }
      }
      store.set("appTheme.accentColorOverride", normalized);
    })
  );

  // nativeTheme listener for auto-switching
  let appearanceTimer: ReturnType<typeof setTimeout> | null = null;

  const handleNativeThemeUpdated = () => {
    if (appearanceTimer !== null) clearTimeout(appearanceTimer);
    appearanceTimer = setTimeout(() => {
      appearanceTimer = null;

      const config = getAppThemeConfig();
      if (!config.followSystem) return;

      const isDark = nativeTheme.shouldUseDarkColors;
      const schemeId = isDark
        ? (config.preferredDarkSchemeId ?? DEFAULT_DARK_SCHEME)
        : (config.preferredLightSchemeId ?? DEFAULT_LIGHT_SCHEME);

      store.set("appTheme.colorSchemeId", schemeId);

      const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
      if (!win || win.isDestroyed()) return;

      typedSend(win, "app-theme:system-appearance-changed", { isDark, schemeId });

      const customSchemes = config.customSchemes ?? [];
      const scheme = resolveAppTheme(schemeId, customSchemes);
      win.setBackgroundColor(scheme.tokens["surface-canvas"]);

      // Hand the new tokens to the overlay owner rather than writing the native
      // strip here: it re-tints in place when a global banner currently holds
      // the caption band, instead of reverting it to bare canvas (#11766).
      setTitleBarOverlayTheme(win, scheme.tokens);
    }, 300);
  };

  nativeTheme.on("updated", handleNativeThemeUpdated);
  handlers.push(() => {
    nativeTheme.removeListener("updated", handleNativeThemeUpdated);
    if (appearanceTimer !== null) {
      clearTimeout(appearanceTimer);
      appearanceTimer = null;
    }
  });

  return () => handlers.forEach((cleanup) => cleanup());
}
