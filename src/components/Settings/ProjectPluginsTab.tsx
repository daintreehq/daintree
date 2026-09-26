import { useEffect, useId, useMemo, useState } from "react";
import { AlertCircle, FolderOpen, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SETTINGS_CONTROL_WIDTH,
  SettingsEmptyRow,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CapabilityRow } from "@/components/Plugin/capabilityMeta";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import {
  PluginSettingsForm,
  type PluginSettingsFocusRequest,
} from "@/components/Settings/PluginSettingsForm";
import { pluginHasSettings } from "@/services/plugin/pluginSettingsHome";
import { usePluginManagerStore } from "@/store/pluginManagerStore";
import { ProjectAgentToolsSection } from "@/components/Settings/ProjectAgentToolsSection";
import {
  PROJECT_PLUGINS_OVERVIEW_ID,
  ProjectPluginSelectorDropdown,
  type ProjectPluginOption,
} from "@/components/Settings/ProjectPluginSelectorDropdown";
import { useRenderableSurfaceClaim } from "@/hooks/useRenderableSurfaceClaim";
import {
  selectFailedSave,
  selectSurfaceChoice,
  usePluginProjectSurfacesStore,
} from "@/store/pluginProjectSurfacesStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { useProjectStore } from "@/store/projectStore";
import { systemClient } from "@/clients";
import { makeForgeProviderId } from "@shared/utils/forgeProviderIds";
import { actionService } from "@/services/ActionService";
import { cn } from "@/lib/utils";
import { logError } from "@/utils/logger";
import {
  BUILT_IN_PLUGIN_CAPABILITIES,
  PROJECT_PLUGIN_INSTANCE_PREFIX,
  pluginManifestIdFromInstanceKey,
  type LoadedPluginInfo,
  type ProjectPluginInfo,
  type ProjectPluginState,
} from "@shared/types/plugin";
import { PathSegments } from "@/components/ui/PathSegments";

/**
 * The word beside a project plugin's name.
 *
 * `blocked` reads as "Off" because that is what it means to the person looking
 * at it — the plugin is not running — and the pane below says *why*, which is
 * where the distinction between "the folder is off" and "this one is off"
 * actually matters.
 */
const STATE_LABEL: Record<ProjectPluginState, string> = {
  active: "Running",
  staged: "Staged",
  blocked: "Off",
  invalid: "Unreadable",
};

/**
 * Picker option ids are namespaced by origin because a project plugin may share
 * its manifest id with an installed one — the `collidesWithGlobal` case. They
 * are two different plugins whose switches mean different things (mute vs hide),
 * so a bare id would select both panes at once and repeat itself in the DOM.
 */
const PROJECT_OPTION_PREFIX = "project:";
const INSTALLED_OPTION_PREFIX = "installed:";

/**
 * One status for the picker, the badge and the pane. A plugin in a folder that is
 * turned off is off whatever its own state says, so the folder decides first.
 */
export function projectPluginStatus(plugin: ProjectPluginInfo, folderTrusted: boolean): string {
  if (plugin.state === "invalid") return STATE_LABEL.invalid;
  if (plugin.muted || !folderTrusted) return "Off";
  return STATE_LABEL[plugin.state];
}

const EMPTY_CANVAS_STATUS = {
  none: "You haven't chosen yet, so it shows.",
  surface: "You chose to keep it.",
  stock: "You chose the launcher, so it's hidden.",
} as const;

/**
 * Which plugin draws this project's empty canvas, and the user's remembered
 * answer about it.
 *
 * The answer persists, so it has to be findable: without this, a project whose
 * owner once chose the launcher would keep hiding a canvas its plugin still
 * claims, with nothing anywhere saying why. Rendered only while the claim can
 * render and its answer is known — the canvas's own test — so this never
 * describes a surface the canvas would not draw.
 */
function EmptyCanvasSection() {
  const init = usePluginProjectSurfacesStore((s) => s.init);
  const renderable = useRenderableSurfaceClaim("emptyCanvas");
  const choicesLoaded = usePluginProjectSurfacesStore((s) => s.choicesLoaded);
  const choice = usePluginProjectSurfacesStore((s) => selectSurfaceChoice(s, "emptyCanvas"));
  const setSurfaceChoice = usePluginProjectSurfacesStore((s) => s.setSurfaceChoice);
  const failedSave = usePluginProjectSurfacesStore((s) => selectFailedSave(s, "emptyCanvas"));
  const plugins = useProjectPluginStore((s) => s.plugins);

  useEffect(() => {
    init();
  }, [init]);

  if (renderable === null || !choicesLoaded) return null;

  const { claim } = renderable;
  const pluginName =
    plugins.find((p) => p.instanceId === claim.pluginId)?.displayName ??
    pluginManifestIdFromInstanceKey(claim.pluginId);

  return (
    <div data-testid="project-plugins-empty-canvas">
      <SettingsSection
        title="Empty canvas"
        description={`${pluginName} draws what this project shows when no panels are open, in place of the launcher.`}
      >
        <SettingsGroup>
          <SettingsRow
            label="Show on the empty canvas"
            description={EMPTY_CANVAS_STATUS[choice ?? "none"]}
            control={({ descriptionId }) => (
              <SettingsSwitch
                checked={choice !== "stock"}
                onCheckedChange={(next) =>
                  void setSurfaceChoice("emptyCanvas", next ? "surface" : "stock")
                }
                aria-label="Show on the empty canvas"
                aria-describedby={descriptionId}
                data-testid="project-empty-canvas-switch"
              />
            )}
          />
          <SettingsRow
            label="Remembered choice"
            description="Resetting shows the plugin's canvas again and asks the next time it appears"
            control={
              <Button
                variant="outline"
                size="sm"
                disabled={choice === null}
                onClick={() => void setSurfaceChoice("emptyCanvas", null)}
              >
                Reset choice
              </Button>
            }
          />
          {failedSave !== null && (
            <div className="flex items-center justify-between gap-3 px-4 py-2.5">
              <p role="alert" className="text-xs text-status-error">
                Couldn&apos;t save the canvas choice.
              </p>
              <Button
                variant="outline"
                size="xs"
                onClick={() => void setSurfaceChoice("emptyCanvas", failedSave.choice)}
              >
                Retry
              </Button>
            </div>
          )}
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}

/** Everything the project pane needs about the folder as a whole. */
function ProjectOverviewPane({ projectPluginCount }: { projectPluginCount: number }) {
  const trust = useProjectPluginStore((s) => s.trust);
  const deciding = useProjectPluginStore((s) => s.deciding);
  const decide = useProjectPluginStore((s) => s.decide);
  const reload = useProjectPluginStore((s) => s.reload);
  const [reloading, setReloading] = useState(false);

  const enabled = trust?.enabled === true;

  const handleReload = async () => {
    setReloading(true);
    try {
      await reload();
    } finally {
      setReloading(false);
    }
  };

  return (
    <div className="space-y-8" data-testid="project-plugins-overview">
      <SettingsSection
        title="This project's plugins"
        description={
          projectPluginCount === 0
            ? "None found in .daintree/plugins"
            : `${projectPluginCount} plugin${projectPluginCount === 1 ? "" : "s"} in .daintree/plugins`
        }
      >
        <SettingsGroup>
          {enabled ? (
            <SettingsRow
              label="Allowed to run"
              description="They execute with your account — Daintree doesn't sandbox them. Turning them off unloads every plugin this project ships; to silence just one, pick it above and use its own switch."
              control={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void decide("disabled")}
                  loading={deciding === "disabled"}
                >
                  Turn off project plugins
                </Button>
              }
            />
          ) : (
            <SettingsRow
              label="Not running"
              description="Nothing in this project's plugins folder is running. Enabling runs all of them with your account; Daintree doesn't sandbox them."
              control={
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void decide("session")}
                    loading={deciding === "session"}
                  >
                    Enable for this session
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void decide("enabled")}
                    loading={deciding === "enabled"}
                  >
                    Enable for this project
                  </Button>
                </div>
              }
            />
          )}
          <SettingsRow
            label="Plugins folder"
            description="Reads every manifest again and reloads what changed. Same trust and staging rules as opening the project."
            control={
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleReload()}
                loading={reloading}
              >
                <RefreshCw />
                Re-scan plugins folder
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <EmptyCanvasSection />

      <ProjectAgentToolsSection />
    </div>
  );
}

/** Longer than this and a manifest description is clamped behind "Show more". */
const LONG_DESCRIPTION = 160;

/** Whether a loaded plugin contributes settings, so its section is worth a heading. */
/** Whether a project plugin runs now, by its live state rather than the loaded list. */
function isProjectPluginRunning(plugin: ProjectPluginInfo, folderTrusted: boolean): boolean {
  return folderTrusted && !plugin.muted && plugin.state === "active";
}

function hasPluginSettings(plugin: LoadedPluginInfo | undefined): plugin is LoadedPluginInfo {
  return plugin !== undefined && pluginHasSettings(plugin);
}

/** The DOM id of a plugin pane's Settings section, where a key-less deep link lands. */
const PLUGIN_SETTINGS_HOME_ID = "project-plugin-settings-home";

/** A settings deep link aimed at the pane showing it, and how to report it handled. */
interface PaneSettingsFocus {
  request: PluginSettingsFocusRequest | null;
  onHandled: (nonce: number) => void;
}

/**
 * The plugin's name as the section title, its manifest description and id beneath.
 * The id stays visible because two plugins can share a display name, and the
 * `collidesWithGlobal` case is exactly two plugins sharing an id.
 */
function PluginIdentityDescription({ description, id }: { description?: string; id: string }) {
  const [expanded, setExpanded] = useState(false);
  const textId = useId();
  const long = (description?.length ?? 0) > LONG_DESCRIPTION;
  return (
    <>
      {description && (
        <span id={textId} className={cn("block break-words", long && !expanded && "line-clamp-2")}>
          {description}
        </span>
      )}
      {long && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={textId}
          onClick={() => setExpanded((v) => !v)}
          className="text-text-primary underline-offset-2 hover:underline rounded-[var(--radius-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      <span className="mt-1 block font-mono break-all">{id}</span>
    </>
  );
}

/** Detail for one plugin the project itself ships. */
function ProjectPluginPane({
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
  const [reloading, setReloading] = useState(false);

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

  const handleReload = async () => {
    setReloading(true);
    try {
      await reload();
    } finally {
      setReloading(false);
    }
  };

  const handleReveal = () => {
    if (!projectPath) return;
    systemClient
      .showItemInFolder(`${projectPath}/.daintree/plugins/${plugin.dirName}`)
      .catch((err: unknown) => logError("Failed to reveal project plugin folder", err));
  };

  const folderOff = !folderTrusted && plugin.state !== "invalid";
  const awaitingActivation = plugin.state === "staged" && !plugin.muted && folderTrusted;
  const runStatus = folderOff
    ? undefined
    : plugin.muted
      ? "Switched off on its own. The project's other plugins are unaffected, and turning this back on runs it again without asking."
      : plugin.state === "staged"
        ? undefined
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

  return (
    <div className="space-y-8" data-testid="project-plugin-detail">
      <SettingsSection
        title={plugin.displayName}
        description={<PluginIdentityDescription description={plugin.description} id={plugin.id} />}
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
              disabledReason="Not running because this project's plugins are turned off"
              control={({ descriptionId, disabled }) => (
                <SettingsSwitch
                  checked={!plugin.muted}
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
              error={
                plugin.error ? (
                  <span className="flex items-start gap-1.5 break-words">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
                    {plugin.error}
                  </span>
                ) : undefined
              }
            />
          )}

          <SettingsRow
            label="Source"
            description={
              <span className="font-mono">
                <PathSegments path={`.daintree/plugins/${plugin.dirName}`} />
              </span>
            }
          />

          {plugin.collidesWithGlobal && (
            <SettingsRow
              label="Shares an id with an installed plugin"
              description="Both load — the instance key keeps them apart — so check which one a command or panel came from."
            />
          )}

          {granted.length > 0 && (
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
          )}

          <SettingsRow
            label="Plugin folder"
            layout="stacked"
            description="Reloading re-reads every manifest in the folder, not just this one."
            control={
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleReload()}
                  loading={reloading}
                >
                  <RefreshCw />
                  Reload from disk
                </Button>
                <Button variant="outline" size="sm" onClick={handleReveal} disabled={!projectPath}>
                  <FolderOpen />
                  Reveal folder
                </Button>
              </div>
            }
          />
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
    </div>
  );
}

/** Why a declared-but-stopped plugin's settings can't be changed right now. */
function stoppedSettingsReason(plugin: ProjectPluginInfo, folderOff: boolean): string {
  if (folderOff) return "Available once this project's plugins are allowed to run";
  if (plugin.muted) return "Available when the plugin is turned on";
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
 * section keeps its shape anyway — each declared field as a row, and the custom
 * section as its own row — each saying what it needs, so turning the plugin off
 * doesn't make its settings look like they never existed.
 */
function StoppedPluginSettings({ plugin, reason }: { plugin: ProjectPluginInfo; reason: string }) {
  const fields = plugin.settings ?? [];
  return (
    <div className="grid gap-3">
      {fields.length > 0 && (
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
        </SettingsGroup>
      )}
      {plugin.declaresSettingsView === true && (
        <SettingsGroup>
          <SettingsRow label="More settings" description={reason} />
        </SettingsGroup>
      )}
    </div>
  );
}

const VISIBILITY_DEFAULT_OPTIONS = [
  { value: "all", label: "Every project" },
  { value: "selected", label: "Only projects I turn it on in" },
] as const;

/** Detail for one INSTALLED plugin, seen from inside a project. */
function InstalledPluginPane({
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

  return (
    <div className="space-y-8" data-testid="installed-plugin-detail">
      <SettingsSection
        title={name}
        description={
          <PluginIdentityDescription description={plugin.manifest.description} id={pluginId} />
        }
      >
        <SettingsGroup>
          <SettingsRow
            label="Show in this project"
            accessory={
              <>
                <Badge size="xs">{plugin.isBuiltin ? "Built-in" : "Installed"}</Badge>
                {plugin.manifest.version && <Badge size="xs">v{plugin.manifest.version}</Badge>}
              </>
            }
            description="Hiding removes its panels, commands, buttons and shortcuts from this project. It stays installed and running, so background features such as agents, forge providers and file decorations carry on."
            disabled={plugin.disabled}
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
          {plugin.disabled && (
            <SettingsRow
              label="Turned off everywhere"
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
          )}
          {!plugin.disabled && (
            <SettingsRow
              label="Default for all projects"

              description={
                hiddenByDefault
                  ? "Hidden in every project that hasn't chosen, including new ones. Changing this affects other projects; the switch above is only this one."
                  : "Shown in every project that hasn't chosen, including new ones. Changing this affects other projects; the switch above is only this one."
              }
              control={({ descriptionId, disabled }) => (
                <Select
                  value={hiddenByDefault ? "selected" : "all"}
                  disabled={disabled}
                  onValueChange={(next) => void setVisibilityDefault(pluginId, next === "selected")}
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
          )}
        </SettingsGroup>
      </SettingsSection>

      {hasPluginSettings(plugin) &&
        (forgeSettingsProvider ? (
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
          <SettingsSection title="Settings" id={PLUGIN_SETTINGS_HOME_ID}>
            <PluginSettingsForm
              plugin={plugin}
              viewScope="project"
              focusRequest={settingsFocus.request}
              onFocusHandled={settingsFocus.onHandled}
            />
          </SettingsSection>
        ))}
    </div>
  );
}

/**
 * Project → Plugins.
 *
 * One place for every plugin question that is about *this* project: the plugins
 * the repository ships (their trust, their individual off switches, their
 * settings), and the installed ones (whether each is surfaced here at all).
 *
 * The two halves deliberately share a picker but not a mechanism. Turning off a
 * project plugin stops it loading; turning off an installed one only hides it
 * from this project's views, because its worker is global and shared with every
 * other project. Each pane says which of the two it is doing rather than
 * offering one switch that quietly means different things.
 */
export function ProjectPluginsTab() {
  const projectPlugins = useProjectPluginStore((s) => s.plugins);
  const error = useProjectPluginStore((s) => s.error);
  const folderTrusted = useProjectPluginStore((s) => s.trust?.enabled === true);
  const projectPath = useProjectStore((s) => s.currentProject?.path);

  const [installed, setInstalled] = useState<LoadedPluginInfo[] | null>(null);
  const [installedFailed, setInstalledFailed] = useState(false);
  const [installedAttempt, setInstalledAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string>(PROJECT_PLUGINS_OVERVIEW_ID);

  // Same pull-and-resubscribe shape as the global Plugins tab: `list()` is the
  // only source for installed plugins, and provenance changes (install,
  // uninstall, enable) are what invalidate it. A project plugin's own lifecycle
  // — muted, activated, reloaded onto a new module — arrives as a project-plugin
  // change instead, so the store's list is a second trigger: without it a
  // stopped plugin's custom section, or a reloaded one's old module, would stay.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      window.electron.plugin
        .list()
        .then((list) => {
          if (cancelled) return;
          setInstalled(list);
          setInstalledFailed(false);
        })
        .catch((err) => {
          if (cancelled) return;
          // Keep whatever list we had: an empty one would claim nothing is installed.
          setInstalledFailed(true);
          logError("Failed to load installed plugins for the project plugins tab", err);
        });
    };
    load();
    const unsubscribe = window.electron.plugin.onProvenanceChanged(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [installedAttempt, projectPlugins]);

  // A project plugin loads under an instance key, so it appears in `list()`
  // alongside the installed ones. Split on `instanceId`, NOT on `manifest.name`
  // — the manifest is left untouched for a project plugin, so its name is the
  // bare id and indistinguishable from an installed plugin's.
  const installedOnly = useMemo(
    () => (installed ?? []).filter((p) => !p.instanceId.startsWith(PROJECT_PLUGIN_INSTANCE_PREFIX)),
    [installed]
  );
  const loadedByInstanceId = useMemo(
    () => new Map((installed ?? []).map((p) => [p.instanceId, p])),
    [installed]
  );

  const options: ProjectPluginOption[] = useMemo(
    () => [
      ...projectPlugins.map((p) => ({
        id: `${PROJECT_OPTION_PREFIX}${p.id}`,
        pluginId: p.id,
        name: p.displayName,
        origin: "project" as const,
        status: projectPluginStatus(p, folderTrusted),
        active: folderTrusted && !p.muted && p.state === "active",
      })),
      ...installedOnly.map((p) => ({
        id: `${INSTALLED_OPTION_PREFIX}${p.instanceId}`,
        pluginId: p.instanceId,
        name: p.manifest.displayName ?? p.instanceId,
        origin: "installed" as const,
        status: p.disabled ? "Off" : "Installed",
        active: !p.disabled,
      })),
    ],
    [projectPlugins, installedOnly, folderTrusted]
  );

  // A selection that has gone away — the folder changed, a plugin was
  // uninstalled — falls back to the overview rather than rendering an empty
  // pane for an id nothing describes any more.
  const selectedProjectPlugin = selectedId.startsWith(PROJECT_OPTION_PREFIX)
    ? projectPlugins.find((p) => p.id === selectedId.slice(PROJECT_OPTION_PREFIX.length))
    : undefined;
  const selectedInstalled = selectedId.startsWith(INSTALLED_OPTION_PREFIX)
    ? installedOnly.find((p) => p.instanceId === selectedId.slice(INSTALLED_OPTION_PREFIX.length))
    : undefined;
  const showOverview = !selectedProjectPlugin && !selectedInstalled;

  // A `plugin.openSettings` whose home is this page: pick the plugin it names,
  // then let that pane's form land on the key. A request with no key, or for a
  // plugin that has no settings here, is done once the pane is showing.
  const settingsRequest = usePluginManagerStore((s) =>
    s.settingsRequest?.home === "project" ? s.settingsRequest : null
  );
  const consumeSettingsRequest = usePluginManagerStore((s) => s.consumeSettingsRequest);
  const requestTargetId = useMemo(() => {
    // Not until the running list is in: before it, a pane can't tell whether it
    // has a form to land in, and would settle for its heading.
    if (settingsRequest === null || installed === null) return null;
    const project = projectPlugins.find((p) => p.instanceId === settingsRequest.pluginId);
    if (project) return `${PROJECT_OPTION_PREFIX}${project.id}`;
    const installedMatch = installedOnly.find((p) => p.instanceId === settingsRequest.pluginId);
    return installedMatch ? `${INSTALLED_OPTION_PREFIX}${installedMatch.instanceId}` : null;
  }, [settingsRequest, installed, projectPlugins, installedOnly]);
  const requestNonce = settingsRequest?.nonce;
  const requestKey = settingsRequest?.key;
  // Whether the target pane will render a settings form to land in at all.
  // A stopped project plugin gets the declaration-only section, so it counts as
  // formless even while the loaded list still carries it.
  const requestProjectPlugin =
    settingsRequest === null
      ? undefined
      : projectPlugins.find((p) => p.instanceId === settingsRequest.pluginId);
  const requestTargetHasForm =
    settingsRequest !== null &&
    (requestProjectPlugin === undefined ||
      isProjectPluginRunning(requestProjectPlugin, folderTrusted)) &&
    hasPluginSettings(loadedByInstanceId.get(settingsRequest.pluginId));
  const [headingFocusNonce, setHeadingFocusNonce] = useState<number | null>(null);
  useEffect(() => {
    if (requestTargetId === null || requestNonce === undefined) return;
    setSelectedId(requestTargetId);
    if (requestKey === undefined || !requestTargetHasForm) setHeadingFocusNonce(requestNonce);
  }, [requestTargetId, requestNonce, requestKey, requestTargetHasForm]);
  // With no field to land on, focus goes to the plugin's Settings heading — or
  // its pane, when it has nothing to configure here — once that pane shows and
  // the dialog has switched to this tab.
  useEffect(() => {
    if (headingFocusNonce === null || selectedId !== requestTargetId) return;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      const target =
        document.querySelector<HTMLElement>(
          `#${PLUGIN_SETTINGS_HOME_ID} [data-settings-section-title]`
        ) ??
        document.querySelector<HTMLElement>(
          '[data-testid="project-plugin-detail"], [data-testid="installed-plugin-detail"]'
        );
      if (target && target.closest(".hidden, [hidden]") !== null && attempts++ < 20) {
        timer = setTimeout(attempt, 50);
        return;
      }
      if (target) {
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: false });
      }
      setHeadingFocusNonce(null);
      consumeSettingsRequest(headingFocusNonce);
    };
    attempt();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [headingFocusNonce, selectedId, requestTargetId, consumeSettingsRequest]);
  // Handed only to the pane the request names, and only once it is the one
  // showing — a pane being replaced must not answer for the one replacing it.
  const paneSettingsFocus: PaneSettingsFocus = {
    request:
      requestNonce !== undefined && requestKey !== undefined && selectedId === requestTargetId
        ? { key: requestKey, nonce: requestNonce }
        : null,
    onHandled: consumeSettingsRequest,
  };

  return (
    <div className="space-y-8">
      {/* The picker leads the page bare, the way the agent and forge pages open: it
          chooses what the rest of the page is about, so it is not a setting in a section. */}
      <div className="space-y-2">
        <ProjectPluginSelectorDropdown
          options={options}
          activeId={showOverview ? PROJECT_PLUGINS_OVERVIEW_ID : selectedId}
          onChange={setSelectedId}
        />
        {error && (
          <p className="text-xs text-status-error" role="alert">
            {error}
          </p>
        )}
        {installedFailed && (
          <SettingsLoadErrorBanner
            message="Couldn't read your installed plugins, so they're missing from this list"
            onRetry={() => setInstalledAttempt((n) => n + 1)}
          />
        )}
      </div>

      {showOverview && <ProjectOverviewPane projectPluginCount={projectPlugins.length} />}

      {selectedProjectPlugin && (
        <ProjectPluginPane
          key={selectedProjectPlugin.id}
          plugin={selectedProjectPlugin}
          loaded={
            selectedProjectPlugin.instanceId
              ? loadedByInstanceId.get(selectedProjectPlugin.instanceId)
              : undefined
          }
          projectPath={projectPath}
          onShowOverview={() => setSelectedId(PROJECT_PLUGINS_OVERVIEW_ID)}
          settingsFocus={paneSettingsFocus}
        />
      )}

      {selectedInstalled && (
        <InstalledPluginPane
          key={selectedInstalled.instanceId}
          plugin={selectedInstalled}
          settingsFocus={paneSettingsFocus}
        />
      )}

      {showOverview &&
        !installedFailed &&
        installed !== null &&
        projectPlugins.length === 0 &&
        installedOnly.length === 0 && (
          <SettingsGroup>
            <SettingsEmptyRow
              action={
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
            >
              Install a plugin, or add one to .daintree/plugins, to configure it here
            </SettingsEmptyRow>
          </SettingsGroup>
        )}
    </div>
  );
}
