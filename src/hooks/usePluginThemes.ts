import { useEffect } from "react";
import { isPluginThemeId, type AppColorScheme } from "@shared/theme";
import { useAppThemeStore } from "@/store/appThemeStore";
import { appThemeClient } from "@/clients/appThemeClient";
import { logWarn } from "@/utils/logger";

/** Whether the selection is a plugin theme the catalog no longer offers. */
function selectionLost(themes: readonly AppColorScheme[]): boolean {
  const { selectedSchemeId } = useAppThemeStore.getState();
  return isPluginThemeId(selectedSchemeId) && !themes.some((t) => t.id === selectedSchemeId);
}

/**
 * Mirror main's plugin theme catalog into the app theme store (#13832).
 *
 * Push is authoritative; the pull on mount is a safety net for a view that
 * missed a broadcast, and is dropped if a push beat it (see
 * {@link usePluginTours}). Main replaces a selected plugin theme that is no
 * longer offered and says so in the push. A view that subscribed after that
 * push learns it from the pull instead: the catalog lacks the theme, so the
 * persisted selection is read back.
 */
export function usePluginThemes(): void {
  useEffect(() => {
    const plugin = typeof window !== "undefined" ? window.electron?.plugin : undefined;
    if (!plugin?.onThemesChanged) return;

    let disposed = false;
    let pushReceived = false;

    void plugin
      .getThemes()
      .then(async (themes) => {
        if (disposed || pushReceived) return;
        useAppThemeStore.getState().setPluginSchemes(themes);
        if (!selectionLost(themes)) return;
        const { colorSchemeId } = await appThemeClient.get();
        if (disposed || pushReceived || !selectionLost(themes)) return;
        if (colorSchemeId && colorSchemeId !== useAppThemeStore.getState().selectedSchemeId) {
          useAppThemeStore.getState().applyPluginThemeFallback(colorSchemeId);
        }
      })
      .catch((err: unknown) => {
        logWarn("[PluginThemes] Failed to fetch plugin themes", { error: err });
      });

    const cleanup = plugin.onThemesChanged(({ themes, fallbackSchemeId }) => {
      if (disposed) return;
      pushReceived = true;
      const lost = selectionLost(themes);
      const store = useAppThemeStore.getState();
      store.setPluginSchemes(themes);
      if (fallbackSchemeId && lost) store.applyPluginThemeFallback(fallbackSchemeId);
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);
}
