import { useEffect, useState, useSyncExternalStore } from "react";
import {
  getPanelKindRegistrySnapshot,
  subscribeToPanelKindRegistry,
} from "@shared/config/panelKindRegistry";
import {
  pluginManifestIdFromInstanceKey,
  type PluginRequiredSettingsStatus,
} from "@shared/types/plugin";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { actionService } from "@/services/ActionService";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { useProjectStore } from "@/store/projectStore";
import { logError } from "@/utils/logger";

/**
 * "<Plugin> needs setup", above a plugin surface whose plugin declares a
 * `required` setting that is still unset.
 *
 * It sits ABOVE the content, in flow, never inside the plugin's box — the same
 * placement the project surface strip uses, and for the same reason: plugins
 * draw their own toolbars along the top edge, and a host control floated into
 * that region gets painted over or pushes the plugin's own layout around. Every
 * plugin surface gets it: a view panel, a PTY-backed panel and a project
 * surface all draw it the same way.
 *
 * Neutral on purpose. A missing credential is a standing state the user can
 * see and fix, not a failure, and the surface is usually still useful to look
 * at — so no warning wash and no accent, just the one way forward. It goes away
 * by itself: main announces every settings write, and the strip re-reads which
 * required keys are still missing whenever it does.
 *
 * Only ids and labels cross the bridge, never a value. A required key whose
 * stored file couldn't be read is said as what it is — "Couldn't read <label>"
 * — rather than as missing, which would be a guess, or as nothing, which would
 * leave the panel silent while `host.settings.missingRequired()` tells the
 * plugin the same key is unusable. An unset key takes precedence: the setup
 * prompt is the one the user can act on directly.
 */
export function PluginSetupStrip({ pluginId }: { pluginId: string }) {
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const displayName = usePluginRuntimeStore(
    (s) => s.pluginMetaById.get(pluginId)?.displayName ?? pluginManifestIdFromInstanceKey(pluginId)
  );
  const initPluginRuntime = usePluginRuntimeStore((s) => s.init);
  useEffect(() => initPluginRuntime(), [initPluginRuntime]);
  const [status, setStatus] = useState<PluginRequiredSettingsStatus>(EMPTY_STATUS);

  useEffect(() => {
    const bridge = window.electron?.plugin;
    if (typeof bridge?.getRequiredSettingsStatus !== "function") return;
    let cancelled = false;
    // Sequenced so a slow read can never overwrite a newer one.
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      bridge
        .getRequiredSettingsStatus(pluginId, projectId)
        .then((next) => {
          if (!cancelled && current === generation) setStatus(next);
        })
        .catch((err: unknown) => {
          // A refused request (a foreign project, a malformed id) says nothing
          // about the settings themselves, so it shows nothing.
          if (!cancelled && current === generation) setStatus(EMPTY_STATUS);
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

  const firstMissing = status.missing[0];
  const firstUnreadable = status.unreadable[0];
  const target = firstMissing ?? firstUnreadable;
  if (target === undefined) return null;

  const title =
    firstMissing !== undefined
      ? `${displayName} needs setup`
      : status.unreadable.length === 1
        ? `Couldn't read ${status.labels[target] ?? target}`
        : `Couldn't read ${status.unreadable.length} of ${displayName}'s settings`;

  return (
    <div className="shrink-0" data-testid="plugin-setup-strip">
      <InlineStatusBanner
        title={title}
        severity={firstMissing !== undefined ? "neutral" : "warning"}
        role="status"
        layout="inline"
        action={{
          id: "configure",
          label: "Open plugin settings",
          variant: "primary",
          onClick: () => {
            void actionService.dispatch(
              "plugin.openSettings",
              { pluginId, key: target },
              { source: "user" }
            );
          },
        }}
      />
    </div>
  );
}

const EMPTY_STATUS: PluginRequiredSettingsStatus = { missing: [], unreadable: [], labels: {} };

/**
 * The strip for a surface identified by its panel kind — a PTY-backed plugin
 * panel or a project surface — read reactively off the kind registry, so a
 * plugin reload that adds or drops a required setting takes effect at once.
 * Renders nothing for a built-in kind or a plugin with nothing required.
 */
export function PluginKindSetupStrip({ kind }: { kind: string }) {
  const registry = useSyncExternalStore(
    subscribeToPanelKindRegistry,
    getPanelKindRegistrySnapshot,
    getPanelKindRegistrySnapshot
  );
  const config = registry[kind];
  if (config?.hasRequiredSettings !== true || !config.extensionId) return null;
  return <PluginSetupStrip pluginId={config.extensionId} />;
}
