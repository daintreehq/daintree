import { useEffect } from "react";
import { setPluginCustomIcons } from "@/components/icons/pluginCustomIconStore";
import { logWarn } from "@/utils/logger";

/**
 * Mirror main's plugin custom-icon snapshot into this view (#13143).
 * Pull-on-mount is a safety net for a view that missed a broadcast; push is
 * authoritative, so a pull resolving after a push is dropped (see
 * {@link usePluginTours}).
 */
export function usePluginIcons(): void {
  useEffect(() => {
    const electron = typeof window !== "undefined" ? window.electron : undefined;
    if (!electron?.plugin) return;

    let disposed = false;
    let pushReceived = false;

    void electron.plugin
      .getIcons()
      .then((icons) => {
        if (!disposed && !pushReceived) setPluginCustomIcons(icons);
      })
      .catch((err: unknown) => {
        logWarn("[PluginIcons] Failed to fetch initial plugin icons", { error: err });
      });

    const cleanup = electron.plugin.onIconsChanged((payload) => {
      pushReceived = true;
      if (!disposed) setPluginCustomIcons(payload.icons);
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);
}
