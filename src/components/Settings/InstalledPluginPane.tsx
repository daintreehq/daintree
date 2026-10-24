import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SETTINGS_CONTROL_WIDTH,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { PluginSettingsForm } from "@/components/Settings/PluginSettingsForm";
import { SearchProvidersSection } from "@/components/Settings/SearchProvidersSection";
import {
  PLUGIN_SETTINGS_HOME_ID,
  PluginIdentityDescription,
  RowFailure,
  hasPluginSettings,
  useStoreFailure,
  type PaneSettingsFocus,
} from "@/components/Settings/projectPluginsShared";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { makeForgeProviderId } from "@shared/utils/forgeProviderIds";
import { actionService } from "@/services/ActionService";
import type { LoadedPluginInfo } from "@shared/types/plugin";

const VISIBILITY_DEFAULT_OPTIONS = [
  { value: "all", label: "Every project" },
  { value: "selected", label: "Only projects I turn it on in" },
] as const;

/** Detail for one INSTALLED plugin, seen from inside a project. */
export function InstalledPluginPane({
  plugin,
  settingsFocus,
}: {
  plugin: LoadedPluginInfo;
  settingsFocus: PaneSettingsFocus;
}) {
  const pluginId = plugin.instanceId;
  const visibility = useProjectPluginStore((s) => s.visibility);
  const setVisibility = useProjectPluginStore((s) => s.setVisibility);
  const setVisibilityDefault = useProjectPluginStore((s) => s.setVisibilityDefault);
  const loadVisibility = useProjectPluginStore((s) => s.loadVisibility);
  const visibilityFailure = useStoreFailure("visibility", pluginId);
  const defaultFailure = useStoreFailure("visibilityDefault", pluginId);
  const loadFailure = useStoreFailure("loadVisibility");

  const hiddenByDefault = visibility.defaultHiddenPluginIds.includes(pluginId);
  // A forge provider that ships its own settings tab owns its settings there: editing
  // them here as well would skip the checks that page runs (a GitLab instance change
  // that has to clear the saved token first).
  const forgeSettingsProvider = plugin.manifest.contributes.forgeProviders?.find(
    (provider) => provider.slots?.settingsTab
  );
  // A forge-owned settings pane has no field here to land on; the pointer to
  // Code forge is where the request ends.
  const pendingNonce = settingsFocus.request?.nonce;
  const onFocusHandled = settingsFocus.onHandled;
  const forgeOwned = forgeSettingsProvider !== undefined;
  useEffect(() => {
    if (pendingNonce !== undefined && forgeOwned) onFocusHandled(pendingNonce);
  }, [pendingNonce, forgeOwned, onFocusHandled]);
  const override = visibility.overrides[pluginId];
  const visible = override ?? !hiddenByDefault;
  const name = plugin.manifest.displayName ?? pluginId;

  // The switch always writes an explicit answer for this project EXCEPT when
  // the answer it would write is the default anyway — then it clears the
  // override instead, so a project that agrees with the default keeps no record
  // and follows the default if it later changes.
  const handleToggle = (next: boolean) => {
    void setVisibility(pluginId, next === !hiddenByDefault ? null : next);
  };

  const badges = (
    <>
      <Badge size="xs">{plugin.isBuiltin ? "Built-in" : "Installed"}</Badge>
      {plugin.manifest.version && <Badge size="xs">v{plugin.manifest.version}</Badge>}
    </>
  );

  const visibilityError = visibilityFailure ? (
    <RowFailure
      summary={
        // A null write returns to the default, so what it tried to do is whatever
        // the default is.
        (visibilityFailure.source.visible ?? !hiddenByDefault)
          ? `Couldn't show ${name} in this project`
          : `Couldn't hide ${name} in this project`
      }
      detail={visibilityFailure.detail}
      onRetry={() => void setVisibility(pluginId, visibilityFailure.source.visible)}
    />
  ) : loadFailure ? (
    <RowFailure
      summary="Couldn't read which plugins this project hides, so this may show the default"
      detail={loadFailure.detail}
      onRetry={() => void loadVisibility()}
    />
  ) : undefined;

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
          {plugin.disabled ? (
            // Off everywhere, there is nothing here to show or hide: one row that says
            // so and where to turn it back on, rather than a switch that reads "on".
            <SettingsRow
              label="Turned off everywhere"
              accessory={badges}
              description="It isn't running in any project, so there's nothing to show or hide here"
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
            <>
              <SettingsRow
                label="Show in this project"
                accessory={badges}
                description="Hiding removes its panels, commands, buttons, shortcuts, recipes, menu items, file decorations, search providers and custom settings section from this project. It stays installed and running, so background features such as agents and forge providers carry on."
                error={visibilityError}
                control={({ descriptionId, disabled }) => (
                  <SettingsSwitch
                    checked={visible}
                    disabled={disabled}
                    onCheckedChange={handleToggle}
                    aria-label={`Show ${name} in this project`}
                    aria-describedby={descriptionId}
                    data-testid="installed-plugin-visibility-switch"
                  />
                )}
              />
              <SettingsRow
                label="Default for all projects"
                description={
                  hiddenByDefault
                    ? "Hidden in every project that hasn't chosen, including new ones. Changing this affects other projects; the switch above is only this one."
                    : "Shown in every project that hasn't chosen, including new ones. Changing this affects other projects; the switch above is only this one."
                }
                error={
                  defaultFailure ? (
                    <RowFailure
                      summary="Couldn't change the default for all projects"
                      detail={defaultFailure.detail}
                      onRetry={() =>
                        void setVisibilityDefault(pluginId, defaultFailure.source.hidden)
                      }
                    />
                  ) : undefined
                }
                control={({ descriptionId, disabled }) => (
                  <Select
                    value={hiddenByDefault ? "selected" : "all"}
                    disabled={disabled}
                    onValueChange={(next) =>
                      void setVisibilityDefault(pluginId, next === "selected")
                    }
                  >
                    <SelectTrigger
                      aria-label="Which projects show this plugin by default"
                      aria-describedby={descriptionId}
                      data-testid="installed-plugin-visibility-default"
                      className={SETTINGS_CONTROL_WIDTH.wide}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VISIBILITY_DEFAULT_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </>
          )}
        </SettingsGroup>
      </SettingsSection>

      {forgeSettingsProvider ? (
        // A forge provider's settings live beside its credentials, whether or not
        // it also declares generic fields — so the pointer is there either way.
        <SettingsSection title="Settings" id={PLUGIN_SETTINGS_HOME_ID}>
          <SettingsGroup>
            <SettingsRow
              label={`Configured in Code forge → ${forgeSettingsProvider.name}`}
              description="Its settings sit beside its credentials there, so a change that affects the saved token is checked first"
              control={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("daintree:open-settings-tab", {
                        detail: {
                          tab: "code-forge",
                          subtab: makeForgeProviderId(pluginId, forgeSettingsProvider.id),
                        },
                      })
                    )
                  }
                >
                  Open Code forge
                </Button>
              }
            />
          </SettingsGroup>
        </SettingsSection>
      ) : (
        hasPluginSettings(plugin) && (
          <SettingsSection title="Settings" id={PLUGIN_SETTINGS_HOME_ID}>
            <PluginSettingsForm
              plugin={plugin}
              viewScope="project"
              focusRequest={settingsFocus.request}
              onFocusHandled={settingsFocus.onHandled}
            />
          </SettingsSection>
        )
      )}
      {!plugin.disabled && (
        <SearchProvidersSection
          pluginId={pluginId}
          scope="installed"
          refreshKey={visible ? "shown" : "hidden"}
        />
      )}
    </div>
  );
}
