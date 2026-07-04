import { useEffect, useRef } from "react";
import { logError } from "@/utils/logger";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { PluginBackgroundUpdateCheckResult } from "@shared/types/plugin";

const SUPERSEDE_KEY = "plugin-updates-available";

function showPluginUpdatesNotification(result: PluginBackgroundUpdateCheckResult): void {
  const count = result.updates.length;
  if (count === 0) return;
  // eslint-disable-next-line no-restricted-syntax -- notify-event-kind: ok — a background "updates available" nudge has no fitting EVENT_POLICY kind; mirrors useStoreUpdateListener.
  notify({
    type: "info",
    // priority:"low" routes inbox-only — no toast, no OS notification. A
    // background heads-up about optional plugin updates belongs in history, not
    // competing with active work (#10893).
    priority: "low",
    // supersedeKey collapses repeated daily passes that surface the same set
    // into a single inbox row rather than stacking duplicates.
    supersedeKey: SUPERSEDE_KEY,
    title: "Plugin updates available",
    message:
      count === 1
        ? "1 plugin update is available. Open the plugin manager to review it."
        : `${count} plugin updates are available. Open the plugin manager to review them.`,
    duration: 0,
    // actionId drives the button on the inbox-history path (a bare onClick is
    // dropped there — see useStoreUpdateListener); onClick is the toast-path
    // fallback in case priority routing changes.
    action: {
      label: "Open plugin manager",
      actionId: "app.pluginManager",
      onClick: () => {
        safeFireAndForget(
          actionService.dispatch("app.pluginManager", undefined, { source: "user" }),
          { context: "Open plugin manager from update notification" }
        );
      },
    },
  });
}

/**
 * Surfaces the opt-in background plugin update check (#10893) as a single
 * low-priority inbox notification. Hydrates from the main-process cache on mount
 * (so an update found during the launch window still surfaces) and subscribes to
 * live results. Deduped in-session by the result `signature` so re-checks that
 * find the same set don't re-notify.
 */
export function usePluginUpdateCheckListener(): void {
  const lastSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    const plugin = window.electron?.plugin;
    if (!plugin?.onBackgroundUpdateAvailable) return;

    const surface = (result: PluginBackgroundUpdateCheckResult) => {
      if (result.updates.length === 0) return;
      if (lastSignatureRef.current === result.signature) return;
      lastSignatureRef.current = result.signature;
      showPluginUpdatesNotification(result);
    };

    plugin
      .getLatestBackgroundUpdateCheck?.()
      ?.then((result) => {
        if (result) surface(result);
      })
      .catch((err) => logError("[usePluginUpdateCheckListener] getLatest failed", err));

    const cleanup = plugin.onBackgroundUpdateAvailable(surface);
    return () => {
      cleanup();
    };
  }, []);
}
