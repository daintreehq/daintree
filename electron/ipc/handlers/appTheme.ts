import { dialog, BrowserWindow, nativeTheme } from "electron";
import { promises as fs } from "node:fs";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import { parseAppThemeFile } from "../../utils/appThemeImporter.js";
import {
  resolveAppTheme,
  normalizeAppColorScheme,
  normalizeAccentHex,
} from "../../../shared/theme/index.js";
import { typedHandle, typedHandleWithContext, typedSend } from "../utils.js";
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
    return config as AppThemeConfig;
  }

  const defaultSchemeId = nativeTheme.shouldUseDarkColors
    ? DEFAULT_DARK_SCHEME
    : DEFAULT_LIGHT_SCHEME;
  return {
    ...(config && typeof config === "object" && !Array.isArray(config) ? config : {}),
    colorSchemeId: defaultSchemeId,
  } as AppThemeConfig;
}

function parseCustomSchemes(config: AppThemeConfig): AppColorScheme[] {
  if (typeof config.customSchemes !== "string" || !config.customSchemes.trim()) return [];
  try {
    const parsed = JSON.parse(config.customSchemes);
    if (Array.isArray(parsed)) return parsed.map((s: AppColorScheme) => normalizeAppColorScheme(s));
  } catch {
    // Malformed custom schemes
  }
  return [];
}

export function registerAppThemeHandlers(mainWindow?: BrowserWindow): () => void {
  const handlers: Array<() => void> = [];

  handlers.push(typedHandle(CHANNELS.APP_THEME_GET, async () => getAppThemeConfig()));

  handlers.push(
    typedHandle(CHANNELS.APP_THEME_SET_COLOR_SCHEME, async (schemeId: string) => {
      if (typeof schemeId !== "string" || !schemeId.trim()) {
        console.warn("Invalid app theme colorSchemeId:", schemeId);
        return;
      }
      const current = getAppThemeConfig();
      store.set("appTheme", {
        ...current,
        colorSchemeId: schemeId.trim(),
      } satisfies AppThemeConfig);
    })
  );

  handlers.push(
    typedHandle(CHANNELS.APP_THEME_SET_CUSTOM_SCHEMES, async (schemesJson: string) => {
      if (typeof schemesJson !== "string") {
        console.warn("Invalid app custom schemes:", schemesJson);
        return;
      }
      const current = getAppThemeConfig();
      store.set("appTheme", {
        ...current,
        customSchemes: schemesJson,
      } satisfies AppThemeConfig);
    })
  );

  const VALID_COLOR_VISION_MODES = ["default", "red-green", "blue-yellow"];
  handlers.push(
    typedHandle(CHANNELS.APP_THEME_SET_COLOR_VISION_MODE, async (mode: ColorVisionMode) => {
      if (typeof mode !== "string" || !VALID_COLOR_VISION_MODES.includes(mode)) {
        console.warn("Invalid color vision mode:", mode);
        return;
      }
      const current = getAppThemeConfig();
      store.set("appTheme", {
        ...current,
        colorVisionMode: mode,
      } satisfies AppThemeConfig);
    })
  );

  handlers.push(
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
      const current = getAppThemeConfig();
      store.set("appTheme", { ...current, followSystem: enabled } satisfies AppThemeConfig);
    })
  );

  handlers.push(
    typedHandle(CHANNELS.APP_THEME_SET_PREFERRED_DARK_SCHEME, async (schemeId: string) => {
      if (typeof schemeId !== "string" || !schemeId.trim()) return;
      const current = getAppThemeConfig();
      store.set("appTheme", {
        ...current,
        preferredDarkSchemeId: schemeId.trim(),
      } satisfies AppThemeConfig);
    })
  );

  handlers.push(
    typedHandle(CHANNELS.APP_THEME_SET_PREFERRED_LIGHT_SCHEME, async (schemeId: string) => {
      if (typeof schemeId !== "string" || !schemeId.trim()) return;
      const current = getAppThemeConfig();
      store.set("appTheme", {
        ...current,
        preferredLightSchemeId: schemeId.trim(),
      } satisfies AppThemeConfig);
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
      const current = getAppThemeConfig();
      store.set("appTheme", {
        ...current,
        recentSchemeIds: sanitized,
      } satisfies AppThemeConfig);
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
      const current = getAppThemeConfig();
      store.set("appTheme", {
        ...current,
        accentColorOverride: normalized,
      } satisfies AppThemeConfig);
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

      store.set("appTheme", { ...config, colorSchemeId: schemeId } satisfies AppThemeConfig);

      const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
      if (!win || win.isDestroyed()) return;

      typedSend(win, "app-theme:system-appearance-changed", { isDark, schemeId });

      const customSchemes = parseCustomSchemes(config);
      const scheme = resolveAppTheme(schemeId, customSchemes);
      win.setBackgroundColor(scheme.tokens["surface-canvas"]);

      if (process.platform === "win32") {
        win.setTitleBarOverlay({
          color: scheme.tokens["surface-canvas"],
          symbolColor: "#a1a1aa",
          height: 36,
        });
      }
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
