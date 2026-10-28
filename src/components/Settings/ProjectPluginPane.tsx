import { useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowActions,
} from "@/components/Settings/SettingsGroup";
import { CapabilityRow } from "@/components/Plugin/capabilityMeta";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { PluginSettingsForm } from "@/components/Settings/PluginSettingsForm";
import { SearchProvidersSection } from "@/components/Settings/SearchProvidersSection";
import {
  PLUGIN_SETTINGS_HOME_ID,
  PluginIdentityDescription,
  RowFailure,
  hasPluginSettings,
  isProjectPluginRunning,
  projectPluginStatus,
  useStoreFailure,
  type PaneSettingsFocus,
} from "@/components/Settings/projectPluginsShared";
import {
  describeSurfaceRefusal,
  surfacePluginFallbackName,
  useProjectSurfaceRefusals,
} from "@/hooks/useProjectSurfaceRefusals";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { systemClient } from "@/clients";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  BUILT_IN_PLUGIN_CAPABILITIES,
  type LoadedPluginInfo,
  type ProjectPluginInfo,
} from "@shared/types/plugin";
import { PathSegments } from "@/components/ui/PathSegments";
import { PluginTerminalLinksRow } from "@/components/Plugin/PluginTerminalLinksSection";

/**
 * Detail for one plugin the project itself ships.
 *
 * Ordered by what someone arrives here to do: whether it runs, then its
 * settings, then where it lives and what it declares. The declared
 * capabilities move up beside the Activate step while it is staged, because
 * that is the decision they inform.
 */
export function ProjectPluginPane({
  plugin,
  loaded,
  projectPath,
  onShowOverview,
  settingsFocus,
}: {
  plugin: ProjectPluginInfo;
  loaded: LoadedPluginInfo | undefined;
  projectPath: string | undefined;
  onShowOverview: () => void;
  settingsFocus: PaneSettingsFocus;
}) {
  const trust = useProjectPluginStore((s) => s.trust);
  const muting = useProjectPluginStore((s) => s.muting);
  const activating = useProjectPluginStore((s) => s.activating);
  const setMuted = useProjectPluginStore((s) => s.setMuted);
  const activateStaged = useProjectPluginStore((s) => s.activateStaged);
  const reload = useProjectPluginStore((s) => s.reload);
  const reloading = useProjectPluginStore((s) => s.reloading);
  const muteFailure = useStoreFailure("mute", plugin.id);
  const activateFailure = useStoreFailure("activate", plugin.id);
  const reloadFailure = useStoreFailure("reload");
  const projectPlugins = useProjectPluginStore((s) => s.plugins);
  // A claim this plugin lost, or one the host couldn't apply. Shown whatever the
  // claim's own state, because a loaded plugin whose surface never appears is
  // exactly what the author would otherwise have no way to explain.
  const refusals = useProjectSurfaceRefusals(plugin.instanceId);
  const nameOf = (pluginId: string) =>
    projectPlugins.find((p) => p.instanceId === pluginId)?.displayName ??
    surfacePluginFallbackName(pluginId);

  const folderTrusted = trust?.enabled === true;
  const declared = new Set(plugin.capabilities);
  const granted = BUILT_IN_PLUGIN_CAPABILITIES.filter((c) => declared.has(c));
  const canMute = plugin.state !== "invalid";
  // The live project-plugin state decides, not the loaded list, which only
  // catches up on the next pull: until then a stopped plugin still has a
  // loaded entry, and a write against it lands after main dropped the
  // declaration that says which values are secret.
  const editable =
    isProjectPluginRunning(plugin, folderTrusted) && hasPluginSettings(loaded) ? loaded : undefined;

  const [revealFailure, setRevealFailure] = useState<{ reason: string | null } | null>(null);
  const handleReveal = () => {
    if (!projectPath) return;
    systemClient
      .showItemInFolder(`${projectPath}/.daintree/plugins/${plugin.dirName}`)
      .then(() => setRevealFailure(null))
      .catch((err: unknown) => {
        setRevealFailure({ reason: formatErrorMessage(err, "") || null });
        logError("Failed to reveal project plugin folder", err);
      });
  };

  const folderOff = !folderTrusted && plugin.state !== "invalid";
  const awaitingActivation = plugin.state === "staged" && !plugin.muted && folderTrusted;
  const runStatus = folderOff
    ? undefined
    : plugin.muted
      ? "Switched off on its own. The project's other plugins are unaffected, and turning this back on runs it again without asking."
      : plugin.state === "active"
        ? "Running in this project. Switching it off stops only this plugin."
        : undefined;

  const badges = (
    <>
      <Badge size="xs">Project</Badge>
      <Badge size="xs">{projectPluginStatus(plugin, folderTrusted)}</Badge>
      {plugin.version && <Badge size="xs">v{plugin.version}</Badge>}
    </>
  );

  const capabilitiesRow =
    granted.length > 0 ? (
      <SettingsRow
        label="Declared capabilities"
        layout="stacked"
        description="What the plugin says it uses. Daintree doesn't sandbox project plugins, so this is a description of intent, not a limit on it."
        control={
          <ul className="space-y-1.5">
            {granted.map((capability) => (
              <CapabilityRow key={capability} capability={capability} />
            ))}
          </ul>
        }
      />
    ) : null;

  return (
    <div className="space-y-8" data-testid="project-plugin-detail">
      <SettingsSection
        title={plugin.displayName}
        description={
          <PluginIdentityDescription
            description={plugin.description}
            id={plugin.id}
            title={plugin.displayName}
          />
        }
      >
        <SettingsGroup>
          {folderOff && (
            <SettingsRow
              label="This project's plugins are turned off"
              description="Nothing in .daintree/plugins runs until the folder is allowed, this plugin included"
              control={
                <Button variant="outline" size="sm" onClick={onShowOverview}>
                  Review folder
                </Button>
              }
            />
          )}
          {awaitingActivation ? (
            // Staged and allowed: the one thing left is to start it, so the row is that
            // step rather than a switch that reads "on" for a plugin that has never run.
            <SettingsRow
              label="Run here"
              accessory={badges}
              description="New to this project, so it was read but never run. Activating starts it now and on every future open."
              error={
                activateFailure ? (
                  <RowFailure
                    summary={`Couldn't activate ${plugin.displayName}`}
                    detail={activateFailure.detail}
                    onRetry={() => void activateStaged(plugin.id)}
                  />
                ) : undefined
              }
              control={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void activateStaged(plugin.id)}
                  loading={activating.has(plugin.id)}
                >
                  Activate plugin
                </Button>
              }
            />
          ) : canMute ? (
            <SettingsRow
              label="Run here"
              accessory={badges}
              description={runStatus}
              disabled={folderOff}
              // While the folder is off the switch shows what is true — not running —
              // and the reason carries what it will do once the folder is allowed.
              disabledReason={
                plugin.muted
                  ? "Also switched off on its own, so it stays off when the folder is allowed"
                  : plugin.state === "staged"
                    ? "New to this project, so once the folder is allowed it waits for you to activate it"
                    : "Runs once this project's plugins are allowed"
              }
              error={
                muteFailure ? (
                  <RowFailure
                    summary={
                      muteFailure.source.muted
                        ? `Couldn't turn off ${plugin.displayName}`
                        : `Couldn't turn on ${plugin.displayName}`
                    }
                    detail={muteFailure.detail}
                    onRetry={() => void setMuted(plugin.id, muteFailure.source.muted)}
                  />
                ) : undefined
              }
              control={({ descriptionId, disabled }) => (
                <SettingsSwitch
                  checked={!plugin.muted && !folderOff}
                  disabled={disabled || muting.has(plugin.id)}
                  onCheckedChange={(next) => void setMuted(plugin.id, !next)}
                  aria-label={`Run ${plugin.displayName} in this project`}
                  aria-describedby={descriptionId}
                  data-testid="project-plugin-mute-switch"
                />
              )}
            />
          ) : (
            <SettingsRow
              label="Manifest"
              accessory={badges}
              description={plugin.error ? undefined : "Its manifest isn't valid"}
              error={plugin.error ? <span className="break-words">{plugin.error}</span> : undefined}
            />
          )}

          {plugin.collidesWithGlobal && (
            <SettingsRow
              label="Shares an id with an installed plugin"
              description="Both load — the instance key keeps them apart — so check which one a command or panel came from."
            />
          )}

          {refusals.map((refusal) => {
            const copy = describeSurfaceRefusal(refusal, nameOf);
            return (
              <SettingsRow
                key={`${refusal.slot}:${refusal.reason}`}
                label={copy.title}
                description={copy.detail}
              />
            );
          })}

          {awaitingActivation && capabilitiesRow}

          {loaded && (loaded.manifest.contributes.terminalLinks?.length ?? 0) > 0 && (
            <PluginTerminalLinksRow pluginId={loaded.instanceId} />
          )}
        </SettingsGroup>
      </SettingsSection>

      {editable && (
        <SettingsSection title="Settings" id={PLUGIN_SETTINGS_HOME_ID}>
          <PluginSettingsForm
            plugin={editable}
            viewScope="project"
            focusRequest={settingsFocus.request}
            onFocusHandled={settingsFocus.onHandled}
            viewRunning
          />
        </SettingsSection>
      )}

      {!editable &&
        ((plugin.settings?.length ?? 0) > 0 || plugin.declaresSettingsView === true) && (
          <SettingsSection title="Settings" id={PLUGIN_SETTINGS_HOME_ID}>
            <StoppedPluginSettings
              plugin={plugin}
              reason={stoppedSettingsReason(plugin, folderOff)}
            />
          </SettingsSection>
        )}

      <SettingsSection title="Details">
        <SettingsGroup>
          <SettingsRow
            label="Source"
            description={
              <span className="font-mono">
                <PathSegments path={`.daintree/plugins/${plugin.dirName}`} />
              </span>
            }
          />
          {!awaitingActivation && capabilitiesRow}
          <SettingsRow
            label="Plugins folder"
            layout="stacked"
            description="Re-scanning reads every manifest in the folder again, not just this one"
            error={
              reloadFailure ? (
                <RowFailure
                  summary="Couldn't re-scan the plugins folder"
                  detail={reloadFailure.detail}
                  onRetry={() => void reload()}
                />
              ) : revealFailure ? (
                <RowFailure
                  summary="Couldn't reveal the plugin's folder"
                  detail={revealFailure.reason}
                  onRetry={handleReveal}
                />
              ) : undefined
            }
            control={
              <SettingsRowActions>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void reload()}
                  loading={reloading}
                >
                  <RefreshCw />
                  Re-scan plugins folder
                </Button>
                <Button variant="outline" size="sm" onClick={handleReveal} disabled={!projectPath}>
                  <FolderOpen />
                  Reveal folder
                </Button>
              </SettingsRowActions>
            }
          />
        </SettingsGroup>
      </SettingsSection>
      <SearchProvidersSection
        pluginId={plugin.instanceId}
        scope="project"
        refreshKey={`${plugin.state}:${loaded ? "loaded" : "unloaded"}`}
      />
    </div>
  );
}

/** Why a declared-but-stopped plugin's settings can't be changed right now. */
function stoppedSettingsReason(plugin: ProjectPluginInfo, folderOff: boolean): string {
  if (folderOff) return "Available once this project's plugins are allowed to run";
  if (plugin.muted) return "Available once the plugin is turned on";
  if (plugin.state === "staged") return "Available once the plugin is activated";
  return "Available while the plugin is running";
}

/**
 * A project plugin's Settings section while it isn't running — muted, staged,
 * or its folder turned off.
 *
 * Nothing is loaded to answer for its values: the settings bridge reads and
 * writes against a running plugin's declarations, and without them it can't
 * tell a secret from a plain string, so it must not be handed a write. The
 * section keeps its shape anyway — each declared field as a disabled row, and
 * the custom section as its own row — each saying what it needs, so turning the
 * plugin off doesn't make its settings look like they never existed. With no
 * control on them, the rows keep their words at full contrast.
 */
function StoppedPluginSettings({ plugin, reason }: { plugin: ProjectPluginInfo; reason: string }) {
  const fields = plugin.settings ?? [];
  if (fields.length === 0 && plugin.declaresSettingsView !== true) return null;
  return (
    <SettingsGroup>
      {fields.map((def) => (
        <SettingsRow
          key={def.id}
          label={def.label ?? def.id}
          description={def.description}
          disabled
          disabledReason={reason}
        />
      ))}
      {plugin.declaresSettingsView === true && (
        <SettingsRow label="More settings" disabled disabledReason={reason} />
      )}
    </SettingsGroup>
  );
}
