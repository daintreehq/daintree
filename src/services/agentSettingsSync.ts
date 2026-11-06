import { DEFAULT_AGENT_SETTINGS } from "@shared/types";
import { agentSettingsClient } from "@/clients/agentSettingsClient";
import { subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import { onHostResync, readSettingOnResync, type HostResync } from "@/store/hostResyncSignal";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { logWarn } from "@/utils/logger";

/**
 * Keeps this view's agent settings on what its host saved (#14700): every
 * save on the host reaches each of its views, local and remote, and a view
 * reads them again when it may have missed one: after its link to the host
 * comes back, and when a cached view returns. Without it a view launches
 * agents with the options it booted with.
 */
export function initAgentSettingsSync(): () => void {
  const bridge = typeof window === "undefined" ? undefined : window.electron?.agentSettings;
  if (!bridge || typeof bridge.onChanged !== "function") return () => {};

  let disposed = false;
  const offChange = agentSettingsClient.onChanged((settings) => {
    if (disposed || !settings || typeof settings !== "object") return;
    useAgentSettingsStore.getState().applySaved(settings);
  });

  const refetch = (resync: HostResync = {}): void => {
    if (disposed) return;
    useAgentSettingsStore
      .getState()
      .refresh(() =>
        readSettingOnResync(
          resync,
          // A host that never saved any reads as none; the store fills in defaults.
          (settings) => settings.agentSettings ?? DEFAULT_AGENT_SETTINGS,
          () => agentSettingsClient.get()
        )
      )
      .catch((error: unknown) => {
        // A remote view whose host is unreachable keeps what it had; the
        // resync after the link returns reads it again.
        logWarn("[agentSettings] Couldn't read agent settings", { error: String(error) });
      });
  };

  const offResync = onHostResync(refetch);
  const offLifecycle = subscribeProjectViewLifecycle((phase) => {
    if (phase === "active") refetch();
  });

  return () => {
    disposed = true;
    offChange();
    offResync();
    offLifecycle();
  };
}
