import { useEffect } from "react";
import { isPluginThemeId } from "@shared/theme";
import { useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import { logWarn } from "@/utils/logger";

/** The selected plugin theme's id when the catalog doesn't offer it, else null. */
function lostSelection(): string | null {
  const { selectedSchemeId, pluginSchemes } = useAppThemeStore.getState();
  return isPluginThemeId(selectedSchemeId) && !pluginSchemes.some((t) => t.id === selectedSchemeId)
    ? selectedSchemeId
    : null;
}

/**
 * Mirror main's plugin theme catalog into the app theme store (#13832).
 *
 * Push is authoritative; the pull on mount is a safety net for a view that
 * missed a broadcast, and is dropped if a push beat it (see
 * {@link usePluginTours}). Main replaces a selected plugin theme that is no
 * longer offered and says so in the push that drops it. A catalog without the
 * selection and without that word — a view that subscribed after the push, or
 * a reload between its unload and load — has the persisted selection read back
 * instead, which moves the view only if main really did replace it.
 */
export function usePluginThemes(): void {
  useEffect(() => {
    const plugin = typeof window !== "undefined" ? window.electron?.plugin : undefined;
    if (!plugin?.onThemesChanged) return;

    let disposed = false;
    let pushReceived = false;

    const readBackLostSelection = async (): Promise<void> => {
      const lostId = lostSelection();
      if (lostId === null) return;
      const { colorSchemeId } = await appThemeClient.get();
      // Only while that same selection is still missing from the newest catalog.
      if (disposed || lostSelection() !== lostId) return;
      if (colorSchemeId && colorSchemeId !== lostId) {
        useAppThemeStore.getState().applyPluginThemeFallback(colorSchemeId);
      }
    };

    void plugin
      .getThemes()
      .then(async (themes) => {
        if (disposed) return;
        if (!pushReceived) useAppThemeStore.getState().setPluginSchemes(themes);
        await readBackLostSelection();
      })
      .catch((err: unknown) => {
        logWarn("[PluginThemes] Failed to fetch plugin themes", { error: err });
      });

    const cleanup = plugin.onThemesChanged(({ themes, fallbackSchemeId }) => {
      if (disposed) return;
      pushReceived = true;
      const store = useAppThemeStore.getState();
      store.setPluginSchemes(themes);
      if (fallbackSchemeId && lostSelection() !== null) {
        store.applyPluginThemeFallback(fallbackSchemeId);
        return;
      }
      readBackLostSelection().catch((err: unknown) => {
        logWarn("[PluginThemes] Failed to read back the theme selection", { error: err });
      });
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);
}
