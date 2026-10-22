import { isDeepStrictEqual } from "node:util";
import { nativeTheme } from "electron";
import { store } from "../store.js";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToVisibleRenderersOrAll } from "../ipc/utils.js";
import { repaintAllWindowThemes } from "../window/projectThemeChrome.js";
import { publishProjectThemeChoice, reconcileProjectPluginThemes } from "./projectThemeStore.js";
import { getPluginTheme } from "./plugin/PluginThemeRegistry.js";
import {
  BUILT_IN_APP_SCHEMES,
  getAppThemeFallbackType,
  getBuiltInAppSchemeForType,
} from "../../shared/theme/themes.js";
import {
  isPluginThemeId,
  parsePluginThemeId,
  readPluginThemeSnapshot,
  toPluginThemeSnapshot,
} from "../../shared/theme/pluginThemes.js";
import type { AppColorScheme } from "../../shared/theme/types.js";

/**
 * Keeps the persisted theme selection honest about plugin themes (#13832).
 *
 * Selecting a plugin theme persists its source beside the id, so the boot
 * paths paint it before any plugin loads. Once the plugin catalog is
 * authoritative, a selection whose theme is no longer offered (the plugin was
 * disabled, uninstalled or blocked, or an update dropped the theme or made it
 * fail the gate) falls back to the user's preferred built-in of the same
 * polarity, and the user is told.
 */

/** The same defaults the first-run and follow-system paths use. */
const DEFAULT_SCHEME_BY_TYPE: Record<AppColorScheme["type"], string> = {
  dark: "daintree",
  light: "bondi",
};

function readThemeRecord(): Record<string, unknown> {
  const config = store.get("appTheme");
  return config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

function builtInOfType(id: unknown, type: AppColorScheme["type"]): AppColorScheme | undefined {
  if (typeof id !== "string") return undefined;
  const scheme = BUILT_IN_APP_SCHEMES.find((candidate) => candidate.id === id.trim());
  return scheme?.type === type ? scheme : undefined;
}

/** The preferred slot for `type` when it holds a built-in of that polarity, else the default. */
function resolveFallbackScheme(
  type: AppColorScheme["type"],
  config: Record<string, unknown>
): AppColorScheme {
  const preferred = type === "dark" ? config.preferredDarkSchemeId : config.preferredLightSchemeId;
  return (
    builtInOfType(preferred, type) ??
    builtInOfType(DEFAULT_SCHEME_BY_TYPE[type], type) ??
    getBuiltInAppSchemeForType(type)
  );
}

/**
 * Persist `schemeId` as the selected theme. A plugin theme must be offered
 * right now, and its source is written first so a selection is never on disk
 * without the snapshot that paints it. Any other id leaves an earlier snapshot
 * in place, where it is inert because it no longer matches the selection.
 */
export function persistColorSchemeSelection(schemeId: string): void {
  if (isPluginThemeId(schemeId)) {
    const theme = getPluginTheme(schemeId);
    if (!theme) {
      throw new Error(`No loaded plugin offers the theme "${schemeId}"`);
    }
    store.set("appTheme.pluginThemeSnapshot", toPluginThemeSnapshot(theme.source));
  }
  store.set("appTheme.colorSchemeId", schemeId);
}

function notifyFallback(lost: AppColorScheme | null, fallback: AppColorScheme): void {
  const message = lost?.plugin
    ? `"${lost.name}" from ${lost.plugin.name} isn't available anymore. Now using "${fallback.name}".`
    : `The plugin theme you chose isn't available anymore. Now using "${fallback.name}".`;
  // One machine-wide change, so one notice: cached project views would each
  // raise their own copy from their own notification state.
  broadcastToVisibleRenderersOrAll(CHANNELS.NOTIFICATION_SHOW_TOAST, {
    type: "info",
    title: "Theme switched",
    message,
    rateLimitKey: "plugin-theme-fallback",
  });
}

/**
 * Settle the selection against the plugin theme catalog. `canSettle` says
 * whether the catalog speaks for a plugin right now: not while a startup scan
 * might still load it, and not between a reload's unload and load, when its
 * theme is absent without having gone anywhere.
 *
 * A selected theme that is still offered has its snapshot refreshed, which
 * picks up an update to the plugin's palette. One that is gone is replaced.
 * Returns the id it fell back to, or null when the selection stands.
 */
export function reconcilePluginThemeSelection(
  canSettle: (pluginId: string) => boolean
): string | null {
  // Projects showing their own plugin theme settle on the same catalog (#13833).
  for (const projectId of reconcileProjectPluginThemes(canSettle)) {
    publishProjectThemeChoice(projectId);
  }

  const config = readThemeRecord();
  const selectedId = typeof config.colorSchemeId === "string" ? config.colorSchemeId.trim() : "";
  if (!isPluginThemeId(selectedId)) return null;
  // A malformed id has no owner to wait for; only a complete catalog settles it.
  if (!canSettle(parsePluginThemeId(selectedId)?.pluginId ?? "")) return null;

  const offered = getPluginTheme(selectedId);
  if (offered) {
    const snapshot = toPluginThemeSnapshot(offered.source);
    if (!isDeepStrictEqual(config.pluginThemeSnapshot, snapshot)) {
      store.set("appTheme.pluginThemeSnapshot", snapshot);
    }
    return null;
  }

  const lost = readPluginThemeSnapshot(config);
  const type =
    lost?.type ?? getAppThemeFallbackType(selectedId, config, nativeTheme.shouldUseDarkColors);
  const fallback = resolveFallbackScheme(type, config);
  store.set("appTheme.colorSchemeId", fallback.id);
  if (Array.isArray(config.recentSchemeIds)) {
    store.set(
      "appTheme.recentSchemeIds",
      config.recentSchemeIds.filter((id) => id !== selectedId)
    );
  }
  // Per window: one showing a project with its own theme keeps it.
  repaintAllWindowThemes();
  notifyFallback(lost, fallback);
  return fallback.id;
}
