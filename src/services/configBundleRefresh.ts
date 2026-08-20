import { appThemeClient } from "@/clients/appThemeClient";
import { useAppThemeStore } from "@/store/appThemeStore";
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { logError } from "@/utils/logger";

/**
 * Bring the renderer's mirrors back in line after a configuration bundle was
 * written by the main process (#11889).
 *
 * `app.reloadConfig` is NOT a general reconciliation path — it refreshes the
 * user agent registry, agent settings, keybinding overrides, and CLI
 * availability, and nothing else. Theme never applied through it, and
 * `notificationSettingsStore.hydrate()` early-returns once hydrated, so that
 * mirror would silently keep the pre-import values. Both are refreshed here
 * explicitly.
 *
 * The worktree path pattern and global recipes are read on demand and reconcile
 * on their own, so neither needs a refresh.
 */
export async function refreshImportedConfig(): Promise<void> {
  // Covers the agent registry, agent settings, keybindings, CLI availability,
  // and the application menu.
  await window.electron.app.reloadConfig();

  await Promise.all([refreshTheme(), refreshNotificationSettings()]);
}

async function refreshTheme(): Promise<void> {
  try {
    const config = await appThemeClient.get();
    const store = useAppThemeStore.getState();

    // Custom schemes first: a selected id pointing at an imported scheme can
    // only resolve once that scheme is in the store.
    useAppThemeStore.setState({
      customSchemes: config.customSchemes ?? [],
      followSystem: config.followSystem ?? false,
      preferredDarkSchemeId: config.preferredDarkSchemeId ?? store.preferredDarkSchemeId,
      preferredLightSchemeId: config.preferredLightSchemeId ?? store.preferredLightSchemeId,
      accentColorOverride: config.accentColorOverride ?? null,
    });

    // These setters only touch store state and the DOM — main has already
    // persisted the imported values, so nothing is written twice.
    const next = useAppThemeStore.getState();
    if (config.colorSchemeId) next.setSelectedSchemeIdSilent(config.colorSchemeId);
    next.setColorVisionMode(config.colorVisionMode ?? "default");
  } catch (error) {
    logError("[importConfig] Failed to refresh theme after import", error);
  }
}

async function refreshNotificationSettings(): Promise<void> {
  try {
    await useNotificationSettingsStore.getState().rehydrate();
  } catch (error) {
    logError("[importConfig] Failed to refresh notification settings after import", error);
  }
}
