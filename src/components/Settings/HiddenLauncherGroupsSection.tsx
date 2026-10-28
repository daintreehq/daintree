import { useEffect, useState } from "react";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { RowFailure } from "@/components/Settings/projectPluginsShared";
import { surfacePluginFallbackName } from "@/hooks/useProjectSurfaceRefusals";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { usePluginLaunchEntriesStore } from "@/store/pluginLaunchEntriesStore";

/**
 * The plugin groups this project hid from its launcher (#13788), each with a
 * switch and a reset that bring its rows back. Listed whether or not the
 * plugin is loaded right now: the hide is remembered either way, and this is
 * the one place it can be found and undone.
 *
 * A group shown from here keeps its row until the page closes, switched on,
 * so the control the user just used is still where it was — focus has
 * somewhere to stay, and a mistaken click is one click to undo.
 */
export function HiddenLauncherGroupsSection() {
  const init = usePluginLaunchEntriesStore((s) => s.init);
  const hiddenPluginIds = usePluginLaunchEntriesStore((s) => s.hiddenPluginIds);
  const entries = usePluginLaunchEntriesStore((s) => s.entries);
  const saveError = usePluginLaunchEntriesStore((s) => s.saveError);
  const setGroupHidden = usePluginLaunchEntriesStore((s) => s.setGroupHidden);
  const plugins = useProjectPluginStore((s) => s.plugins);
  const [shownHere, setShownHere] = useState<readonly string[]>([]);

  useEffect(() => {
    init();
  }, [init]);

  const listed = [...hiddenPluginIds, ...shownHere.filter((id) => !hiddenPluginIds.includes(id))];
  if (listed.length === 0) return null;
  const nameOf = (pluginId: string) =>
    entries.find((entry) => entry.pluginId === pluginId)?.pluginName ??
    plugins.find((plugin) => plugin.instanceId === pluginId)?.displayName ??
    surfacePluginFallbackName(pluginId);
  const setShown = (pluginId: string, shown: boolean) => {
    if (shown) setShownHere((prev) => (prev.includes(pluginId) ? prev : [...prev, pluginId]));
    void setGroupHidden(pluginId, !shown);
  };

  return (
    <div data-testid="project-plugins-hidden-launch-groups">
      <SettingsSection
        title="Hidden from the launcher"
        description="Plugins whose launch entries this project's launcher and empty canvas leave out"
      >
        <SettingsGroup>
          {listed.map((pluginId) => {
            const name = nameOf(pluginId);
            const hidden = hiddenPluginIds.includes(pluginId);
            return (
              <SettingsRow
                key={pluginId}
                label={name}
                description={
                  hidden
                    ? "Its rows and empty-canvas tiles are left out of this project"
                    : "Its rows and empty-canvas tiles are back in this project"
                }
                rootAttributes={{ "data-testid": `hidden-launch-group-${pluginId}` }}
                isModified={hidden}
                onReset={() => setShown(pluginId, true)}
                resetAriaLabel={`Reset ${name}'s launch entries`}
                resetTestId={`hidden-launch-group-reset-${pluginId}`}
                error={
                  saveError === pluginId ? (
                    <RowFailure
                      summary={`Couldn't save whether ${name} shows in the launcher`}
                      onRetry={() => setShown(pluginId, hidden)}
                    />
                  ) : undefined
                }
                control={({ descriptionId }) => (
                  <SettingsSwitch
                    checked={!hidden}
                    onCheckedChange={(next) => setShown(pluginId, next)}
                    aria-label={`Show ${name} in the launcher`}
                    aria-describedby={descriptionId}
                    data-testid={`hidden-launch-group-switch-${pluginId}`}
                  />
                )}
              />
            );
          })}
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
