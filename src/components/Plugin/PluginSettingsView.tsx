import { useEffect } from "react";
import type { LoadedPluginInfo, PluginSettingsViewContext } from "@shared/types/plugin";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { PluginHostedView } from "@/components/Plugin/PluginHostedView";
import { pluginDeclaresSettingsView } from "@/services/plugin/pluginSettingsHome";
import { selectPluginHostedView, usePluginHostedViewsStore } from "@/store/pluginHostedViewsStore";

/**
 * A plugin's custom settings section (`contributes.views` with `location:
 * "settings"`), mounted in its settings home below the declared fields.
 *
 * The host owns the chrome: the section heading is the home's own, and the
 * view renders its rows inside this one `SettingsGroup` surface, so a custom
 * section reads as more rows of the same settings rather than a panel pasted
 * into a page. The view itself mounts through the shared hosted-view path
 * (`PluginHostedView`) with `hostContext: "settings"` — the same activation,
 * error boundary and "Try again" a panel gets, contained so it can't paint over
 * the page around it. There is no dialog-level Save: the view applies its own
 * changes as they are made, like every other settings row.
 *
 * Its module URL comes from the hosted-view snapshot main pushes to this
 * project, so a plugin reload swaps the open section onto the new module, and a
 * plugin that stops or is hidden in this project withdraws it.
 *
 * A plugin that declares a section but can't show it here still gets the
 * section, as one row saying what it needs, rather than leaving the user to
 * guess where it went.
 */
export function PluginSettingsView({
  plugin,
  context,
  running = true,
}: {
  plugin: LoadedPluginInfo;
  context: PluginSettingsViewContext;
  /** False while the home knows the plugin is stopped, even if its list is stale. */
  running?: boolean;
}) {
  const initHostedViews = usePluginHostedViewsStore((s) => s.init);
  useEffect(() => {
    initHostedViews();
  }, [initHostedViews]);
  const snapshotLoaded = usePluginHostedViewsStore((s) => s.views !== null);
  const view = usePluginHostedViewsStore((s) =>
    selectPluginHostedView(s.views, plugin.instanceId, "settings")
  );

  if (!pluginDeclaresSettingsView(plugin)) return null;
  if (running && view !== undefined) {
    return (
      <SettingsGroup>
        <PluginHostedView
          source={{ from: "hosted", view }}
          host="settings"
          // Keyed by home: the manager and the project page each hold their own
          // mount, and a view's per-mount state belongs to one of them.
          mountId={`settings:${plugin.instanceId}:${context.scope}`}
          settingsContext={context}
          testId="plugin-settings-view"
        />
      </SettingsGroup>
    );
  }
  // The first snapshot is one round trip away; a running plugin's section
  // waits for it rather than flashing a row that says it isn't available.
  if (running && !plugin.disabled && !snapshotLoaded) return null;
  return (
    <SettingsGroup>
      <SettingsRow label="More settings" description={unavailableReason(plugin, running)} />
    </SettingsGroup>
  );
}

function unavailableReason(plugin: LoadedPluginInfo, running: boolean): string {
  if (plugin.disabled) return "Available when the plugin is enabled";
  if (!running || plugin.blocklisted) return "Available while the plugin is running";
  // Running, yet main serves this project no section for it: an installed
  // plugin this project hides.
  return "Available in projects that show this plugin";
}
