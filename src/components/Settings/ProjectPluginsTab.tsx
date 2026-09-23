import { useEffect, useMemo, useState } from "react";
import { AlertCircle, FolderOpen, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup, SettingsRow } from "@/components/Settings/SettingsGroup";
import { CapabilityRow } from "@/components/Plugin/capabilityMeta";
import { SettingsSwitch } from "@/components/Settings/SettingsSwitch";
import { PluginSettingsForm } from "@/components/Settings/PluginSettingsForm";
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
import { logError } from "@/utils/logger";
import {
  BUILT_IN_PLUGIN_CAPABILITIES,
  PROJECT_PLUGIN_INSTANCE_PREFIX,
  pluginManifestIdFromInstanceKey,
  type LoadedPluginInfo,
  type ProjectPluginInfo,
  type ProjectPluginState,
} from "@shared/types/plugin";

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

function projectPluginStatus(plugin: ProjectPluginInfo): string {
  if (plugin.muted && plugin.state !== "invalid") return "Off";
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
            ? "No plugins found in .daintree/plugins."
            : `${projectPluginCount} plugin${projectPluginCount === 1 ? "" : "s"} in .daintree/plugins.`
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

/** Detail for one plugin the project itself ships. */
function ProjectPluginPane({
  plugin,
  loaded,
  projectPath,
}: {
  plugin: ProjectPluginInfo;
  loaded: LoadedPluginInfo | undefined;
  projectPath: string | undefined;
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

  return (
    <div data-testid="project-plugin-detail">
      <SettingsGroup>
        <div className="px-4 py-3 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="text-sm font-medium text-text-primary break-words">
                {plugin.displayName}
              </h4>
              <p className="mt-0.5 font-mono text-2xs text-text-secondary break-all">{plugin.id}</p>
            </div>
            {canMute && (
              <div className="shrink-0 flex items-center gap-2">
                <span className="text-xs text-text-secondary">Run here</span>
                <SettingsSwitch
                  checked={!plugin.muted}
                  disabled={muting.has(plugin.id)}
                  onCheckedChange={(next) => void setMuted(plugin.id, !next)}
                  aria-label={`Run ${plugin.displayName} in this project`}
                  data-testid="project-plugin-mute-switch"
                />
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge size="xs">Project</Badge>
            <Badge size="xs">{projectPluginStatus(plugin)}</Badge>
            {plugin.version && <Badge size="xs">v{plugin.version}</Badge>}
          </div>
          {plugin.description && (
            <p className="text-xs text-text-secondary break-words">{plugin.description}</p>
          )}
        </div>

        {plugin.muted && (
          <p className="px-4 py-3 text-xs text-text-secondary leading-relaxed">
            Switched off on its own. The project&apos;s other plugins are unaffected, and the folder
            still has whatever trust you gave it — turning this back on runs it again without
            asking.
          </p>
        )}
        {!plugin.muted && !folderTrusted && plugin.state !== "invalid" && (
          <p className="px-4 py-3 text-xs text-text-secondary leading-relaxed">
            Not running because this project&apos;s plugins are turned off as a folder. Enable them
            under &ldquo;This project&rdquo;.
          </p>
        )}

        <SettingsRow
          label="Source"
          description={
            <span className="font-mono break-all">.daintree/plugins/{plugin.dirName}</span>
          }
        />

        {plugin.state === "invalid" && plugin.error && (
          <div className="flex items-start gap-2 px-4 py-3">
            <AlertCircle className="w-3.5 h-3.5 text-status-danger shrink-0 mt-0.5" />
            <p className="text-xs text-status-danger break-words">{plugin.error}</p>
          </div>
        )}

        {plugin.collidesWithGlobal && (
          <div className="flex items-start gap-2 px-4 py-3">
            <AlertCircle className="w-3.5 h-3.5 text-status-warning shrink-0 mt-0.5" />
            <p className="text-xs text-text-primary break-words">
              An installed plugin already uses this id. Both load — the instance key keeps them
              apart — so check which one a command or panel came from.
            </p>
          </div>
        )}

        {granted.length > 0 && (
          <div className="px-4 py-3 space-y-2">
            <h5 className="text-sm font-medium text-text-primary">Declared capabilities</h5>
            <p className="text-xs text-text-secondary leading-relaxed">
              What the plugin says it uses. Daintree doesn&apos;t sandbox project plugins, so this
              is a description of intent, not a limit on it.
            </p>
            <ul className="space-y-1.5">
              {granted.map((capability) => (
                <CapabilityRow key={capability} capability={capability} />
              ))}
            </ul>
          </div>
        )}

        <div className="px-4 py-3 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            {plugin.state === "staged" && !plugin.muted && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void activateStaged(plugin.id)}
                loading={activating.has(plugin.id)}
              >
                Activate plugin
              </Button>
            )}
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
          {plugin.state === "staged" && !plugin.muted && (
            <p className="text-xs text-text-secondary leading-relaxed">
              New to this project, so it was read but never run. Activating starts it now and on
              every future open.
            </p>
          )}
          <p className="text-xs text-text-secondary leading-relaxed">
            Reloading re-reads every manifest in the folder, not just this one.
          </p>
        </div>

        {loaded && (
          <div className="px-4 py-3">
            <PluginSettingsForm plugin={loaded} />
          </div>
        )}
      </SettingsGroup>
    </div>
  );
}

/** Detail for one INSTALLED plugin, seen from inside a project. */
function InstalledPluginPane({ plugin }: { plugin: LoadedPluginInfo }) {
  const pluginId = plugin.instanceId;
  const visibility = useProjectPluginStore((s) => s.visibility);
  const setVisibility = useProjectPluginStore((s) => s.setVisibility);
  const setVisibilityDefault = useProjectPluginStore((s) => s.setVisibilityDefault);

  const hiddenByDefault = visibility.defaultHiddenPluginIds.includes(pluginId);
  const override = visibility.overrides[pluginId];
  const visible = override ?? !hiddenByDefault;

  // The switch always writes an explicit answer for this project EXCEPT when
  // the answer it would write is the default anyway — then it clears the
  // override instead, so a project that agrees with the default keeps no record
  // and follows the default if it later changes.
  const handleToggle = (next: boolean) => {
    void setVisibility(pluginId, next === !hiddenByDefault ? null : next);
  };

  return (
    <div data-testid="installed-plugin-detail">
      <SettingsGroup>
        <div className="px-4 py-3 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="text-sm font-medium text-text-primary break-words">
                {plugin.manifest.displayName ?? pluginId}
              </h4>
              <p className="mt-0.5 font-mono text-2xs text-text-secondary break-all">{pluginId}</p>
            </div>
            <div className="shrink-0 flex items-center gap-2">
              <span className="text-xs text-text-secondary">Show here</span>
              <SettingsSwitch
                checked={visible}
                disabled={plugin.disabled}
                onCheckedChange={handleToggle}
                aria-label={`Show ${plugin.manifest.displayName ?? pluginId} in this project`}
                data-testid="installed-plugin-visibility-switch"
              />
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge size="xs">{plugin.isBuiltin ? "Built-in" : "Installed"}</Badge>
            {plugin.manifest.version && <Badge size="xs">v{plugin.manifest.version}</Badge>}
          </div>
          {plugin.manifest.description && (
            <p className="text-xs text-text-secondary break-words">{plugin.manifest.description}</p>
          )}
        </div>

        {plugin.disabled ? (
          <p className="px-4 py-3 text-xs text-text-secondary leading-relaxed">
            Turned off everywhere in Settings → Plugins, so there is nothing for this project to
            show or hide.
          </p>
        ) : (
          <>
            <SettingsRow
              label="Where it shows up"
              description={
                hiddenByDefault
                  ? "Hidden in projects you haven't decided about, including ones you open later. The switch above is this project's answer."
                  : "Shown everywhere unless a project says otherwise. The switch above is this project's answer."
              }
              control={({ descriptionId }) => (
                <select
                  value={hiddenByDefault ? "selected" : "all"}
                  onChange={(e) =>
                    void setVisibilityDefault(pluginId, e.target.value === "selected")
                  }
                  aria-label="Which projects show this plugin by default"
                  aria-describedby={descriptionId}
                  data-testid="installed-plugin-visibility-default"
                  className="w-72 px-3 py-1.5 text-sm rounded-[var(--radius-md)] border border-border-strong bg-surface-canvas text-text-primary focus:border-accent-primary/40 focus:outline-hidden transition-colors"
                >
                  <option value="all">Every project</option>
                  <option value="selected">Only projects I turn it on in</option>
                </select>
              )}
            />
            <p className="px-4 py-3 text-xs text-text-secondary leading-relaxed">
              Hiding keeps this plugin out of this project&apos;s panels, commands, toolbar buttons,
              keyboard shortcuts and context menus. It stays installed and keeps running, so
              anything it contributes elsewhere — agents, recipes, forge providers, file decorations
              — carries on here regardless. This is which projects see it, not whether it is loaded.
            </p>
          </>
        )}

        <div className="px-4 py-3">
          <PluginSettingsForm plugin={plugin} />
        </div>
      </SettingsGroup>
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
  const projectPath = useProjectStore((s) => s.currentProject?.path);

  const [installed, setInstalled] = useState<LoadedPluginInfo[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>(PROJECT_PLUGINS_OVERVIEW_ID);

  // Same pull-and-resubscribe shape as the global Plugins tab: `list()` is the
  // only source for installed plugins, and provenance changes (install,
  // uninstall, enable) are what invalidate it.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      window.electron.plugin
        .list()
        .then((list) => {
          if (!cancelled) setInstalled(list);
        })
        .catch((err) => {
          if (cancelled) return;
          setInstalled([]);
          logError("Failed to load installed plugins for the project plugins tab", err);
        });
    };
    load();
    const unsubscribe = window.electron.plugin.onProvenanceChanged(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

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
        status: projectPluginStatus(p),
        active: p.state === "active",
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
    [projectPlugins, installedOnly]
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

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Plugin"
        description="Plugins this project ships, and which of your installed plugins show up in it"
        action={
          <div className="w-72">
            <ProjectPluginSelectorDropdown
              options={options}
              activeId={showOverview ? PROJECT_PLUGINS_OVERVIEW_ID : selectedId}
              onChange={setSelectedId}
            />
          </div>
        }
      >
        {error && (
          <p className="text-xs text-status-danger" role="alert">
            {error}
          </p>
        )}
      </SettingsSection>

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
        />
      )}

      {selectedInstalled && (
        <InstalledPluginPane key={selectedInstalled.instanceId} plugin={selectedInstalled} />
      )}

      {showOverview && projectPlugins.length === 0 && installedOnly.length === 0 && (
        <p className="text-xs text-text-secondary">No plugins to configure yet.</p>
      )}
    </div>
  );
}
