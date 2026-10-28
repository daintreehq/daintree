import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsEmptyRow, SettingsGroup } from "@/components/Settings/SettingsGroup";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { settingsFocusRequestOf } from "@/components/Settings/PluginSettingsForm";
import { forgeOwnsProjectSettings } from "@/services/plugin/pluginSettingsHome";
import { usePluginManagerStore } from "@/store/pluginManagerStore";
import {
  PROJECT_PLUGINS_OVERVIEW_ID,
  ProjectPluginSelectorDropdown,
  type ProjectPluginOption,
} from "@/components/Settings/ProjectPluginSelectorDropdown";
import {
  PLUGIN_SETTINGS_HOME_ID,
  hasPluginSettings,
  isInstanceOn,
  isProjectPluginRunning,
  projectPluginStatus,
  type PaneSettingsFocus,
} from "@/components/Settings/projectPluginsShared";
import { ProjectOverviewPane } from "@/components/Settings/ProjectOverviewPane";
import { ProjectPluginPane } from "@/components/Settings/ProjectPluginPane";
import { InstalledPluginPane } from "@/components/Settings/InstalledPluginPane";
import { ProjectInstancePackagePane } from "@/components/Settings/ProjectInstancePackagePane";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { useProjectStore } from "@/store/projectStore";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import {
  PROJECT_PLUGIN_INSTANCE_PREFIX,
  makeInstalledProjectInstanceKey,
  parseProjectPluginInstanceKey,
  type LoadedPluginInfo,
} from "@shared/types/plugin";

export { projectPluginStatus };

/**
 * Picker option ids are namespaced by origin because a project plugin may share
 * its manifest id with an installed one — the `collidesWithGlobal` case. They
 * are two different plugins whose switches mean different things (mute vs hide),
 * so a bare id would select both panes at once and repeat itself in the DOM.
 */
const PROJECT_OPTION_PREFIX = "project:";
const INSTALLED_OPTION_PREFIX = "installed:";

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
  const clearError = useProjectPluginStore((s) => s.clearError);
  const visibility = useProjectPluginStore((s) => s.visibility);
  const instanceEnabled = useProjectPluginStore((s) => s.instanceEnabled);
  const instanceProjectId = useProjectPluginStore((s) => s.viewProjectId ?? s.projectId);
  const errorSource = useProjectPluginStore((s) => s.errorSource);
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
  // A per-project package lists once, by its package row: its running instance
  // carries a `project__` key too, so it never reads as a second installed plugin.
  const installedOnly = useMemo(
    () => (installed ?? []).filter((p) => !p.instanceId.startsWith(PROJECT_PLUGIN_INSTANCE_PREFIX)),
    [installed]
  );
  const loadedByInstanceId = useMemo(
    () => new Map((installed ?? []).map((p) => [p.instanceId, p])),
    [installed]
  );

  // Each group in name order: the lists arrive in load order, which differs
  // from one launch to the next, so a plugin would otherwise move around.
  const options: ProjectPluginOption[] = useMemo(() => {
    const byName = (a: ProjectPluginOption, b: ProjectPluginOption) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    const project = projectPlugins.map((p) => ({
      id: `${PROJECT_OPTION_PREFIX}${p.id}`,
      pluginId: p.id,
      name: p.displayName,
      origin: "project" as const,
      status: projectPluginStatus(p, folderTrusted),
      active: folderTrusted && !p.muted && p.state === "active",
    }));
    const installedOptions = installedOnly.map((p) => {
      if (p.instanceMode === "project") {
        const on =
          !p.disabled && !p.blocklisted && isInstanceOn(p, instanceEnabled, instanceProjectId);
        return {
          id: `${INSTALLED_OPTION_PREFIX}${p.instanceId}`,
          pluginId: p.instanceId,
          name: p.manifest.displayName ?? p.instanceId,
          origin: "installed" as const,
          status: on ? "On" : "Off",
          active: on,
        };
      }
      // What this project shows, not only where it came from: a plugin hidden
      // here reads "Hidden", so the list agrees with its pane's switch.
      const shown =
        visibility.overrides[p.instanceId] ??
        !visibility.defaultHiddenPluginIds.includes(p.instanceId);
      return {
        id: `${INSTALLED_OPTION_PREFIX}${p.instanceId}`,
        pluginId: p.instanceId,
        name: p.manifest.displayName ?? p.instanceId,
        origin: "installed" as const,
        status: p.disabled ? "Off" : !shown ? "Hidden" : p.isBuiltin ? "Built-in" : "Installed",
        active: !p.disabled && shown,
      };
    });
    return [...project.sort(byName), ...installedOptions.sort(byName)];
  }, [
    projectPlugins,
    installedOnly,
    folderTrusted,
    visibility,
    instanceEnabled,
    instanceProjectId,
  ]);

  // A failure is stated on the row that caused it. One plugin's failed switch
  // leaves with its pane rather than waiting to be read as news about the next
  // plugin; a failure that isn't one plugin's (the folder, the visibility read)
  // stays until it is retried, since its row is on more than one pane.
  const select = (id: string) => {
    if (id !== selectedId && errorSource !== null && "pluginId" in errorSource) clearError();
    setSelectedId(id);
  };

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
    if (installedMatch) return `${INSTALLED_OPTION_PREFIX}${installedMatch.instanceId}`;
    // A per-project package's settings belong to this project's instance, which
    // is listed under the package's one row.
    const instanceKey = parseProjectPluginInstanceKey(settingsRequest.pluginId);
    const packageMatch = instanceKey?.installed
      ? installedOnly.find(
          (p) => p.instanceMode === "project" && p.instanceId === instanceKey.manifestId
        )
      : undefined;
    return packageMatch ? `${INSTALLED_OPTION_PREFIX}${packageMatch.instanceId}` : null;
  }, [settingsRequest, installed, projectPlugins, installedOnly]);
  const requestNonce = settingsRequest?.nonce;
  const requestFocus = settingsFocusRequestOf(settingsRequest);
  const requestTargeted = requestFocus !== null;
  // Whether the target pane will render a settings form to land in at all.
  // A stopped project plugin gets the declaration-only section, so it counts as
  // formless even while the loaded list still carries it — and so does a forge
  // plugin whose pane points to Code forge in place of its form.
  const requestProjectPlugin =
    settingsRequest === null
      ? undefined
      : projectPlugins.find((p) => p.instanceId === settingsRequest.pluginId);
  const requestLoaded =
    settingsRequest === null ? undefined : loadedByInstanceId.get(settingsRequest.pluginId);
  // A per-project package's pane shows its instance's form only while it is on here.
  const requestInstanceKey =
    settingsRequest === null ? null : parseProjectPluginInstanceKey(settingsRequest.pluginId);
  const requestInstanceOff =
    requestInstanceKey?.installed === true &&
    instanceEnabled[requestInstanceKey.manifestId] === false;
  const requestTargetHasForm =
    settingsRequest !== null &&
    !requestInstanceOff &&
    (requestProjectPlugin === undefined ||
      isProjectPluginRunning(requestProjectPlugin, folderTrusted)) &&
    hasPluginSettings(requestLoaded) &&
    !(requestProjectPlugin === undefined && forgeOwnsProjectSettings(requestLoaded));
  const [headingFocusNonce, setHeadingFocusNonce] = useState<number | null>(null);
  useEffect(() => {
    if (requestTargetId === null || requestNonce === undefined) return;
    setSelectedId(requestTargetId);
    if (!requestTargeted || !requestTargetHasForm) setHeadingFocusNonce(requestNonce);
  }, [requestTargetId, requestNonce, requestTargeted, requestTargetHasForm]);
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
    // A formless pane (stopped, or pointing to Code forge) gets nothing to
    // answer: the heading landing above settles it.
    request:
      requestFocus !== null && requestTargetHasForm && selectedId === requestTargetId
        ? requestFocus
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
          onChange={select}
        />
        {installedFailed && (
          // Once a read has succeeded the list is kept, so a later failure leaves it
          // possibly stale rather than empty.
          <SettingsLoadErrorBanner
            message={
              installed === null
                ? "Couldn't read your installed plugins, so they're missing from this list"
                : "Couldn't refresh your installed plugins, so this list may be out of date"
            }
            onRetry={() => setInstalledAttempt((n) => n + 1)}
          />
        )}
      </div>

      {showOverview && (
        <ProjectOverviewPane
          projectPlugins={projectPlugins}
          onSelectPlugin={(plugin) => select(`${PROJECT_OPTION_PREFIX}${plugin.id}`)}
        />
      )}

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
          onShowOverview={() => select(PROJECT_PLUGINS_OVERVIEW_ID)}
          settingsFocus={paneSettingsFocus}
        />
      )}

      {selectedInstalled?.instanceMode === "project" && (
        <ProjectInstancePackagePane
          key={selectedInstalled.instanceId}
          plugin={selectedInstalled}
          instance={
            instanceProjectId === null
              ? undefined
              : loadedByInstanceId.get(
                  makeInstalledProjectInstanceKey(instanceProjectId, selectedInstalled.instanceId)
                )
          }
          settingsFocus={paneSettingsFocus}
        />
      )}

      {selectedInstalled && selectedInstalled.instanceMode !== "project" && (
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
