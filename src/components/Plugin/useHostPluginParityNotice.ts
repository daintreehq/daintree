import { useEffect } from "react";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { hostPluginsSettingsTarget } from "@/components/Settings/Hosts/hostPluginRequests";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { logWarn } from "@/utils/logger";
import { pluginViewHostId } from "./remotePluginView";
import "./pluginPanelRemoval";

/** Whether the host's newest inbox row, read, done or not, already names this difference. */
function alreadyInInbox(key: string, difference: string): boolean {
  const latest = useNotificationHistoryStore
    .getState()
    .entries.find((entry) => entry.supersedeKey === key);
  return latest?.correlationId === difference;
}

/**
 * Once per switch to a host, say how many of this machine's plugins that host
 * doesn't have, with a way to review them. Only a window attached to another
 * machine asks; main decides whether this switch was already announced, so a
 * second project view on the same host stays quiet. The inbox keeps one row
 * per host: a difference it already holds isn't posted again, across switches
 * and relaunches, and a changed one replaces it.
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
        const missing = rows
          .filter((row) => row.group === "only-here")
          .map((row) => row.pluginId)
          .sort();
        if (cancelled || missing.length === 0) return;
        // Claimed even for a difference the inbox already holds: main follows
        // the window's host through these claims, and a skipped one would leave
        // it on the last host announced, refusing that host's next change.
        if (!(await window.electron.pluginParity.claimSwitchNotice({ hostId }))) return;
        const key = `plugin-parity:${hostId}`;
        // The plugins themselves, not their count: two different sets can be
        // the same size.
        const difference = `${key}:${JSON.stringify(missing)}`;
        if (alreadyInInbox(key, difference)) return;
        const host = useHostConnectionStore.getState().hostName ?? hostId;
        // Settings → Hosts on that host's plugins, and nothing else.
        const review = hostPluginsSettingsTarget(hostId);
        notify({
          type: "info",
          message:
            missing.length === 1
              ? `1 of your plugins isn't installed on ${host}`
              : `${missing.length} of your plugins aren't installed on ${host}`,
          replaceKey: key,
          correlationId: difference,
          rateLimitKey: key,
          context: { eventKind: "connectivity" },
          action: {
            label: "Review",
            // The inbox keeps an action's id and args, never its callback.
            actionId: "app.settings.openTab",
            actionArgs: review,
            onClick: () => {
              void actionService.dispatch("app.settings.openTab", review, { source: "user" });
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
