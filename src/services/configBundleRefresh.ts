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
    // Only mirrors what main has already persisted, so nothing is written
    // twice. It repaints whenever the result looks different, which includes
    // an imported theme changing how the current id resolves.
    useAppThemeStore.getState().reconcileAppThemeConfig(await appThemeClient.get());
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
