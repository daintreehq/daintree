import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { PluginSettingsForm } from "@/components/Settings/PluginSettingsForm";
import {
  PLUGIN_SETTINGS_HOME_ID,
  PluginIdentityDescription,
  RowFailure,
  hasPluginSettings,
  isInstanceOn,
  useStoreFailure,
  type PaneSettingsFocus,
} from "@/components/Settings/projectPluginsShared";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { useProjectPluginUnsavedGuard } from "@/components/Plugin/useProjectPluginUnsavedGuard";
import { ProjectPluginUnsavedDialog } from "@/components/Plugin/ProjectPluginUnsavedDialog";
import { actionService } from "@/services/ActionService";
import type { LoadedPluginInfo } from "@shared/types/plugin";

/**
 * Detail for an installed package that runs one instance per project. Its switch
 * starts or stops this project's own copy; the visibility overlay doesn't apply,
 * since a project that hasn't turned it on has nothing of it to show or hide.
 */
export function ProjectInstancePackagePane({
  plugin,
  instance,
  settingsFocus,
}: {
  plugin: LoadedPluginInfo;
  /** This project's running instance, which owns the settings the package declares. */
  instance: LoadedPluginInfo | undefined;
  settingsFocus: PaneSettingsFocus;
}) {
  const pluginId = plugin.instanceId;
  const on = useProjectPluginStore((s) =>
    isInstanceOn(plugin, s.instanceEnabled, s.viewProjectId ?? s.projectId)
  );
  const toggling = useProjectPluginStore((s) => s.instanceToggling.has(pluginId));
  // Turning it off unloads this project's copy, so that asks first when one of
  // its panels holds unsaved work (#17215). Turning it on goes straight through.
  const guard = useProjectPluginUnsavedGuard();
  const failure = useStoreFailure("instanceEnabled", pluginId);
  const name = plugin.manifest.displayName ?? pluginId;
  const setInstanceEnabled = (enabled: boolean) =>
    void guard.setInstanceEnabled(pluginId, enabled, name);

  const badges = (
    <>
      <Badge size="xs">Per project</Badge>
      {plugin.manifest.version && <Badge size="xs">v{plugin.manifest.version}</Badge>}
    </>
  );

  return (
    <div className="space-y-8" data-testid="installed-plugin-detail">
      <SettingsSection
        title={name}
        description={
          <PluginIdentityDescription
            description={plugin.manifest.description}
            id={pluginId}
            title={name}
          />
        }
      >
        <SettingsGroup>
          {plugin.disabled || plugin.blocklisted ? (
            // Main refuses a per-project switch for a package that can't run anywhere,
            // so the row says why and where that's decided instead.
            <SettingsRow
              label={plugin.blocklisted ? "Blocked everywhere" : "Turned off everywhere"}
              accessory={badges}
              description={
                plugin.blocklisted
                  ? (plugin.blocklistReason ?? "It can't run in any project")
                  : "It can't run in any project until it's turned back on"
              }
              control={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void actionService.dispatch("app.pluginManager", undefined, { source: "user" })
                  }
                >
                  Open plugin manager
                </Button>
              }
            />
          ) : (
            <SettingsRow
              label="Run in this project"
              accessory={badges}
              description="Starts a copy of it for this project only. Other projects keep their own answer."
              error={
                failure ? (
                  <RowFailure
                    summary={
                      failure.source.enabled
                        ? `Couldn't turn on ${name} in this project`
                        : `Couldn't turn off ${name} in this project`
                    }
                    detail={failure.detail}
                    onRetry={() => setInstanceEnabled(failure.source.enabled)}
                  />
                ) : undefined
              }
              control={({ descriptionId, disabled }) => (
                <SettingsSwitch
                  checked={on}
                  disabled={disabled || toggling}
                  onCheckedChange={setInstanceEnabled}
                  aria-label={`Run ${name} in this project`}
                  aria-describedby={descriptionId}
                  data-testid="installed-plugin-instance-switch"
                />
              )}
            />
          )}
        </SettingsGroup>
      </SettingsSection>

      {/* Only while it runs here: a stale list can still carry an instance this
          switch just stopped, and its fields would write to nothing. */}
      {on && !plugin.disabled && !plugin.blocklisted && hasPluginSettings(instance) && (
        <SettingsSection title="Settings" id={PLUGIN_SETTINGS_HOME_ID}>
          <PluginSettingsForm
            plugin={instance}
            viewScope="project"
            focusRequest={settingsFocus.request}
            onFocusHandled={settingsFocus.onHandled}
          />
        </SettingsSection>
      )}
      <ProjectPluginUnsavedDialog guard={guard} />
    </div>
  );
}
