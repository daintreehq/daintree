import { useEffect } from "react";
import { setPluginAgentRegistry } from "@shared/config/pluginAgentRegistry";
import { logWarn } from "@/utils/logger";

/**
 * Mirror the main process's plugin-agent registry into the renderer's own
 * (separate V8 context) copy so `getEffectiveAgentConfig` resolves plugin
 * agents for icon/name/color display and launch (#9560).
 *
 * Pull-on-mount is a safety net for cached `WebContentsView`s that may have
 * missed a broadcast; push-on-change is authoritative — once a push arrives,
 * any later-resolving mount-time pull is dropped to avoid rolling back state
 * (mirrors {@link usePluginPanelKinds}). The broadcast always carries the full
 * plugin-agent snapshot, so the renderer replaces wholesale rather than
 * reconciling per-plugin.
 */
export function usePluginAgents(): void {
  useEffect(() => {
    let disposed = false;
    let pushReceived = false;

    const electron = typeof window !== "undefined" ? window.electron : undefined;
    if (!electron?.plugin) return;

    void electron.plugin
      .getAgents()
      .then((agents) => {
        if (disposed || pushReceived) return;
        setPluginAgentRegistry(agents);
      })
      .catch((err: unknown) => {
        logWarn("[PluginAgents] Failed to fetch initial plugin agents", { error: err });
      });

    const cleanup = electron.plugin.onAgentsChanged((payload) => {
      if (disposed) return;
      pushReceived = true;
      setPluginAgentRegistry(payload.agents);
    });

    return () => {
      disposed = true;
      cleanup();
      setPluginAgentRegistry({});
    };
  }, []);
}
