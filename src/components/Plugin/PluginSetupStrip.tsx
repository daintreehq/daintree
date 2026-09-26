import { useEffect, useState } from "react";
import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { actionService } from "@/services/ActionService";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { useProjectStore } from "@/store/projectStore";
import { logError } from "@/utils/logger";

/**
 * "<Plugin> needs setup", above a plugin panel whose plugin declares a
 * `required` setting that is still unset.
 *
 * It sits ABOVE the view, in flow, never inside the plugin's box — the same
 * placement the project surface strip uses, and for the same reason: plugins
 * draw their own toolbars along the top edge, and a host control floated into
 * that region gets painted over or pushes the plugin's own layout around.
 *
 * Neutral on purpose. A missing credential is a standing state the user can
 * see and fix, not a failure, and the panel is usually still useful to look
 * at — so no warning wash and no accent, just the one way forward. It goes
 * away by itself: main announces every settings write, and the strip re-reads
 * which required keys are still missing whenever it does.
 *
 * Only the ids of the missing settings cross the bridge, never a value.
 */
export function PluginSetupStrip({ pluginId }: { pluginId: string }) {
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const displayName = usePluginRuntimeStore(
    (s) => s.pluginMetaById.get(pluginId)?.displayName ?? pluginManifestIdFromInstanceKey(pluginId)
  );
  const initPluginRuntime = usePluginRuntimeStore((s) => s.init);
  useEffect(() => initPluginRuntime(), [initPluginRuntime]);
  const [missing, setMissing] = useState<readonly string[]>([]);

  useEffect(() => {
    const bridge = window.electron?.plugin;
    if (typeof bridge?.getMissingRequiredSettings !== "function") return;
    let cancelled = false;
    // Sequenced so a slow read can never overwrite a newer one.
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      bridge
        .getMissingRequiredSettings(pluginId, projectId)
        .then((ids) => {
          if (!cancelled && current === generation) setMissing(ids);
        })
        .catch((err: unknown) => {
          // Unknown is not "missing": a failed read shows nothing rather than a
          // setup prompt for settings that may well be set.
          if (!cancelled && current === generation) setMissing([]);
          logError(`Failed to read required settings for ${pluginId}`, err);
        });
    };
    refresh();
    const unsubscribe = bridge.onSettingsChanged?.((payload) => {
      if (payload.pluginId === pluginId) refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [pluginId, projectId]);

  const firstMissing = missing[0];
  if (firstMissing === undefined) return null;

  return (
    <div className="shrink-0" data-testid="plugin-setup-strip">
      <InlineStatusBanner
        title={`${displayName} needs setup`}
        severity="neutral"
        role="status"
        layout="inline"
        action={{
          id: "configure",
          label: "Configure…",
          variant: "primary",
          onClick: () => {
            void actionService.dispatch(
              "plugin.openSettings",
              { pluginId, key: firstMissing },
              { source: "user" }
            );
          },
        }}
      />
    </div>
  );
}
