import { useEffect } from "react";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { requestHostPlugins } from "@/components/Settings/Hosts/hostPluginRequests";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { logWarn } from "@/utils/logger";
import { pluginViewHostId } from "./remotePluginView";
import "./pluginPanelRemoval";

/**
 * Once per switch to a host, say how many of this machine's plugins that host
 * doesn't have, with a way to review them. Only a window attached to another
 * machine asks; main decides whether this switch was already announced, so a
 * second project view on the same host stays quiet.
 */
export function useHostPluginParityNotice(): void {
  const hostId = pluginViewHostId();
  const connected = useHostConnectionStore((s) => s.connection?.status === "connected");

  useEffect(() => {
    if (hostId === null || !connected) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await window.electron.pluginParity.diff({ hostId });
        const missing = rows.filter((row) => row.group === "only-here").length;
        if (cancelled || missing === 0) return;
        if (!(await window.electron.pluginParity.claimSwitchNotice({ hostId }))) return;
        const host = useHostConnectionStore.getState().hostName ?? hostId;
        notify({
          type: "info",
          message:
            missing === 1
              ? `1 of your plugins isn't installed on ${host}`
              : `${missing} of your plugins aren't installed on ${host}`,
          rateLimitKey: `plugin-parity:${hostId}`,
          context: { eventKind: "connectivity" },
          action: {
            label: "Review",
            onClick: () => {
              requestHostPlugins(hostId);
              void actionService.dispatch("host.add", undefined, { source: "user" });
            },
          },
        });
      } catch (error) {
        logWarn("Comparing plugins with the window's host failed", { error });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hostId, connected]);
}
