import { isBuiltInActionId } from "../../schemas/plugin.js";
import { PROJECT_SURFACE_SLOTS, fileEditorSlotKey } from "../../../shared/types/plugin.js";
import type {
  PluginLaunchEntryTarget,
  PluginLayoutEntry,
  PluginSearchResolvedTarget,
  PluginSearchResultTarget,
  PluginProtocolAuthority,
  ViewContribution,
  PluginHostBinding,
} from "../../../shared/types/plugin.js";
import type { PluginContributionBroadcaster } from "./PluginContributionBroadcaster.js";
import {
  setPluginContributionScope,
  clearPluginContributionScope,
} from "./PluginContributionBroadcaster.js";
import {
  claimProjectSurface,
  refuseProjectSurface,
  releasePluginSurfaces,
  type SurfaceClaimResult,
} from "./PluginSurfaceRegistry.js";
import {
  DEFAULT_FILE_EDITOR_MAX_BYTES,
  pluginHostedViewKindId,
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
  SIDEBAR_VIEW_DEFAULT_PRIORITY,
  type PluginHostedViewDescriptor,
} from "../../../shared/types/plugin.js";
import type { PluginPanelLifecycleBroker } from "./PluginPanelLifecycleBroker.js";
import { PLUGIN_VIEW_GENERATION_PREFIX } from "../../../shared/utils/pluginViewUrl.js";
import type { PluginPanelReloadDispatcher } from "./PluginPanelReloadDispatcher.js";
import { pluginDeclaresConnections } from "../../../shared/utils/pluginConnections.js";
import { registerPluginDatabaseEndpoint } from "../pluginAgentMcp/databaseEndpoint.js";
import type { LoadedPlugin } from "./PluginServiceTypes.js";
import type { ParsedPluginManifest } from "./pluginManifestLoad.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { makePluginTourId } from "../../../shared/utils/tourIds.js";
import type { WorkspaceClient } from "../WorkspaceClient.js";
import {
  registerPanelKind,
  toRuntimePanelKindId,
  unregisterPluginPanelKinds,
  getPanelKindConfig,
} from "../../../shared/config/panelKindRegistry.js";
import {
  registerToolbarButton,
  unregisterPluginToolbarButtons,
} from "../../../shared/config/toolbarButtonRegistry.js";
import {
  registerPluginLaunchEntry,
  unregisterPluginLaunchEntries,
} from "../../../shared/config/pluginLaunchEntryRegistry.js";
import {
  registerPluginLayout,
  unregisterPluginLayouts,
} from "../../../shared/config/pluginLayoutRegistry.js";
import { isPluginIconId } from "../../../shared/config/pluginIconIds.js";
import { SEARCH_PROVIDER_DEFAULT_ICON_ID } from "../../../shared/config/pluginSearchProviders.js";
import {
  registerSearchProviders,
  unregisterSearchProviders,
  type RegisteredSearchProvider,
} from "./pluginSearchProviderRegistry.js";
import {
  createDeclarativeSearchRunner,
  type DeclarativeSearchRunner,
} from "./pluginSearchDatabase.js";
import { registerPluginMenuItem, unregisterPluginMenuItems } from "../pluginMenuRegistry.js";
import {
  registerPluginKeybinding,
  unregisterPluginKeybindings,
} from "../pluginKeybindingRegistry.js";
import {
  registerPluginContextMenuItem,
  unregisterPluginContextMenuItems,
} from "../pluginContextMenuRegistry.js";
import {
  trackPluginExpression,
  unregisterPlugin as unregisterWhenClausePlugin,
} from "../WhenClauseService.js";
import {
  registerForgeProviders,
  unregisterForgeProviderImpls,
  unregisterForgeProviders,
} from "../forgeProviderRegistry.js";
import {
  registerFileDecorationProviders,
  unregisterFileDecorationProviderImpls,
  unregisterFileDecorationProviders,
} from "../fileDecorationRegistry.js";
import { unregisterWorktreeDeleteNotesBinding } from "./worktreeDeleteNotesRegistry.js";
import {
  registerWorktreeSetupSteps,
  unregisterWorktreeSetupStepHandlers,
  unregisterWorktreeSetupSteps,
} from "../worktreeSetupStepRegistry.js";
import {
  registerContextProviders,
  unregisterContextProviderImpls,
  unregisterContextProviders,
} from "../contextProviderRegistry.js";
import {
  getPluginIdForAgent,
  registerPluginAgents,
  unregisterPluginAgents,
} from "../../../shared/config/pluginAgentRegistry.js";
import {
  registerPluginProcessTools,
  unregisterPluginProcessTools,
} from "../../../shared/config/pluginProcessToolRegistry.js";
import {
  makePluginCustomIconKey,
  type PluginCustomIconAsset,
} from "../../../shared/config/pluginCustomIcon.js";
import {
  registerPluginCustomIcons,
  unregisterPluginCustomIcons,
} from "../../../shared/config/pluginCustomIconRegistry.js";
import { loadPluginCustomIcons } from "./pluginIconAssets.js";
import { registerPluginSkills, unregisterPluginSkills } from "./PluginSkillRegistry.js";
import {
  loadPluginThemes,
  registerPluginThemes,
  unregisterPluginThemes,
  type PluginThemeLoadResult,
} from "./PluginThemeRegistry.js";
import {
  getPluginRecipe,
  registerPluginRecipes,
  unregisterPluginRecipes,
} from "./PluginRecipeRegistry.js";
import { registerPluginTours, unregisterPluginTours } from "./PluginTourRegistry.js";
import {
  registerPluginProjectTemplates,
  unregisterPluginProjectTemplates,
} from "./PluginProjectTemplateRegistry.js";
import {
  registerPluginHostedViews,
  unregisterPluginHostedViews,
} from "./PluginHostedViewRegistry.js";
import type { PluginToolbarButtonId } from "../../../shared/types/toolbar.js";
import type { PluginDiagnosticsLogLine } from "../../../shared/types/ipc/pluginDiagnostics.js";
import {
  registerElementPickerProviders,
  unregisterElementPickerProviders,
} from "../elementPickerProviderRegistry.js";

export function runUnloadStep(pluginId: string, step: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn(`[PluginService] Unload step "${step}" for "${pluginId}" threw:`, err);
  }
}

/**
 * Build the `plugin://{authority}/{PLUGIN_VIEW_GENERATION_PREFIX}{n}/{path}` URL
 * that `PluginViewHost` passes to `import()`. Strips a single leading `./` so
 * the host segment doesn't end up with an awkward `./dist/view.js` path
 * component — the URL handler accepts either form, but the canonical shape
 * matches the protocol docs.
 *
 * The generation segment is what makes a plugin upgrade visible without a Force
 * Reload (#11301). V8 caches ESM module records by URL and Chromium has no
 * eviction API, so a re-imported identical specifier returns the OLD module no
 * matter how thoroughly the React tree remounts. A fresh segment is a specifier
 * V8 has never seen, so the new bundle is actually fetched and evaluated.
 *
 * This is deliberately NOT a per-load cache-buster — that is the thing the
 * renderer's own comment warns against, because one entry per panel open grows
 * the module map without bound. The generation changes only when the plugin is
 * (re)loaded in main: a genuine install, upgrade, or dev reload. That is the
 * same bounded cost plugin authors already pay by hand-versioning their bundle
 * filename every release, minus the manual step.
 *
 * A path SEGMENT rather than a `?v=` query on purpose: a relative import inside
 * the entry module resolves against the entry's URL and inherits a path prefix,
 * but drops the query — so a query would refresh the entry chunk and leave
 * every secondary chunk stale.
 */
export function buildPluginViewUrl(
  authority: PluginProtocolAuthority,
  componentPath: string,
  generation: number
): string {
  const normalized = componentPath.startsWith("./") ? componentPath.slice(2) : componentPath;
  return `plugin://${authority}/${PLUGIN_VIEW_GENERATION_PREFIX}${generation}/${normalized}`;
}

/**
 * A manifest names its own commands `{manifest.name}.<id>`; a project-owned
 * instance registers them under its instance key, so that is where they dispatch.
 */
export function qualifyOwnActionId(
  pluginId: string,
  manifestName: string,
  actionId: string
): string {
  const ownPrefix = `${manifestName}.`;
  return projectIdFromPluginInstanceKey(pluginId) !== null && actionId.startsWith(ownPrefix)
    ? `${pluginId}.${actionId.slice(ownPrefix.length)}`
    : actionId;
}

export interface PluginContributionTarget {
  pluginId: string;
  plugin: LoadedPlugin;
  /** `plugin.manifest`, in the parsed shape that carries every defaulted group. */
  manifest: Readonly<ParsedPluginManifest>;
  binding: PluginHostBinding;
}

/** What the first registration phase resolved, for the phase after the commit. */
interface PendingPluginContributions {
  customIconAssets: PluginCustomIconAsset[];
  customIconKeys: Map<string, string>;
  resolveIconId: (iconId: string) => string;
  ownPrefix: string;
  qualifyActionId: (actionId: string) => string;
  hasPluginSettings: boolean;
  themeLoad: PluginThemeLoadResult | null;
}

export type PluginThemeChange = "registered" | "reloading" | "removed";

export interface PluginContributionRegistrarDeps {
  broadcaster: PluginContributionBroadcaster;
  panelLifecycleBroker: PluginPanelLifecycleBroker;
  panelReloadDispatcher: PluginPanelReloadDispatcher;
  getWorkspaceClient: () => WorkspaceClient | null;
  /** The loaded-instance identity check: is `plugin` still what `pluginId` resolves to? */
  isCurrent: (pluginId: string, plugin: LoadedPlugin) => boolean;
  getLoadedPlugin: (pluginId: string) => LoadedPlugin | undefined;
  recordPluginLog: (
    plugin: LoadedPlugin,
    pluginId: string,
    level: PluginDiagnosticsLogLine["level"],
    message: string
  ) => void;
  pluginDataDir: (pluginId: string) => string;
  publishProjectSurfaces: (projectIds: Iterable<string>) => void;
  themesChanged: (pluginId: string, change: PluginThemeChange) => void;
}

/**
 * Registers a loaded instance's manifest contributions into the module-level
 * registries, and owns the matching ordered unregister cascade. Instance
 * ownership — the `plugins` map, authority minting and the commit between the
 * two load phases — stays with `PluginService`, which calls in at each step.
 */
export class PluginContributionRegistrar {
  constructor(private readonly deps: PluginContributionRegistrarDeps) {}

  /**
   * The registrations that may await (custom icons, skills, themes) and those
   * between them. Everything after the last await belongs to
   * {@link registerCommitted}.
   */
  async prepare(target: PluginContributionTarget): Promise<PendingPluginContributions> {
    const { pluginId, plugin, manifest, binding } = target;
    const pluginDir = plugin.dir;
    const isProject = plugin.origin === "project";

    // Custom SVG icons (#13143) are read before any contribution registers so
    // each `iconId: "./icons/x.svg"` can be rewritten to its runtime key. A
    // reference that fails to load keeps its authored value, which the
    // renderer treats as an unknown id and draws the fallback glyph for — the
    // plugin itself still loads. The assets are only published once the plugin
    // commits below, so a load that fails part-way leaves none behind.
    const customIconAssets: PluginCustomIconAsset[] = [];
    const customIconKeys = new Map<string, string>();
    try {
      const icons = await loadPluginCustomIcons(pluginId, pluginDir, manifest.contributes);
      for (const issue of icons.issues) {
        console.warn(
          `[PluginService] Plugin "${manifest.name}": ${issue.path} ${issue.message} — rendering the fallback icon`
        );
      }
      for (const [ref, svg] of icons.loaded) {
        const key = makePluginCustomIconKey(pluginId, ref);
        customIconKeys.set(ref, key);
        customIconAssets.push({
          key,
          pluginId,
          pluginName: manifest.displayName ?? manifest.name,
          svg,
        });
      }
    } catch (err) {
      console.warn(
        `[PluginService] Plugin "${manifest.name}": failed to load custom icons — rendering fallbacks`,
        err
      );
    }
    const resolveIconId = (iconId: string): string => customIconKeys.get(iconId) ?? iconId;

    // Scope the contribution registries to this plugin's project BEFORE a
    // single contribution is registered. The registries are module-level
    // singletons filtered at read/broadcast time by owning plugin id, so a
    // contribution registered while the index says "global" is broadcast to
    // every project until the next mutation corrects it. `"global"` is the
    // explicit no-op form for the unbound roots.
    setPluginContributionScope(pluginId, binding.projectId ?? "global");

    // Contributed `actionId`s are authored in the plugin's own manifest
    // namespace (the schema enforces exactly that), but a project plugin's
    // commands register under its INSTANCE namespace. Left unrewritten, every
    // declarative toolbar button, menu item, keybinding and context-menu entry
    // would dispatch an id that either resolves to nothing or — worse — to a
    // same-named installed plugin's action.
    const ownPrefix = `${manifest.name}.`;
    const qualifyActionId = (actionId: string): string =>
      isProject && actionId.startsWith(ownPrefix)
        ? `${pluginId}.${actionId.slice(ownPrefix.length)}`
        : actionId;

    // Anything a settings home would show — fields, a custom section, setup
    // steps or an account — so every piece of the plugin's chrome offers
    // "Plugin settings…" by the same rule the renderer's homes use.
    const hasPluginSettings =
      manifest.contributes.settings.length > 0 ||
      manifest.contributes.views.some((v) => v.location === "settings") ||
      (manifest.contributes.setup?.length ?? 0) > 0 ||
      pluginDeclaresConnections(manifest);

    for (const btn of manifest.contributes.toolbarButtons) {
      // Canonical `{pluginId}.{id}` form (#9281) — matches `registerPluginAction`
      // and `panelKindRegistry`. The legacy `plugin.{pluginId}.{id}` form lived
      // here alone and is migrated renderer-side by `toolbarPreferencesStore`'s
      // v9 migration so existing user pins survive the rename.
      const buttonId = `${pluginId}.${btn.id}` as PluginToolbarButtonId;
      const base = {
        id: buttonId,
        label: btn.label,
        iconId: resolveIconId(btn.iconId),
        priority: btn.priority ?? 3,
        pluginId,
        ...(hasPluginSettings ? { hasPluginSettings: true } : {}),
        ...(btn.when !== undefined ? { when: btn.when } : {}),
        ...(btn.menu !== undefined && btn.menu.length > 0
          ? {
              menu: btn.menu.map((item) => ({
                actionId: qualifyActionId(item.actionId),
                ...(item.label !== undefined ? { label: item.label } : {}),
              })),
            }
          : {}),
      };
      if (btn.popover !== undefined) {
        // The popover mounts the view's panel kind, so it carries the RUNTIME
        // kind id — project-qualified for a project plugin, exactly as the
        // panels loop below registers it. The renderer resolves that id in its
        // own registry and refuses a kind this plugin does not own.
        const panelKindId = isProject
          ? toRuntimePanelKindId(
              { origin: "project", pluginId: manifest.name, kindId: btn.popover.viewId },
              binding.projectId
            )
          : `${manifest.name}.${btn.popover.viewId}`;
        if (panelKindId === null) {
          console.error(
            `[PluginService] Plugin "${manifest.name}": cannot qualify toolbar popover view "${btn.popover.viewId}" without an owning project — skipping button "${btn.id}"`
          );
          continue;
        }
        registerToolbarButton({
          ...base,
          popover: { viewId: btn.popover.viewId, panelKindId },
        });
      } else if (btn.actionId !== undefined) {
        registerToolbarButton({ ...base, actionId: qualifyActionId(btn.actionId) });
      } else if (base.menu !== undefined) {
        registerToolbarButton(base);
      }
      trackPluginExpression(pluginId, btn.when);
    }
    if (manifest.contributes.toolbarButtons.length > 0) {
      this.deps.broadcaster.scheduleToolbarButtonsBroadcast(false);
    }

    // Launch entries (#13788) carry runtime ids, never manifest ones: a panel
    // target names the kind exactly as the panels loop below registers it, and
    // a command target is rewritten into the instance namespace like every
    // other contributed `actionId`. The schema already held both to this
    // plugin's own panels and commands.
    const launchEntries = manifest.contributes.launchEntries ?? [];
    for (const entry of launchEntries) {
      let target: PluginLaunchEntryTarget;
      if (entry.panel !== undefined) {
        const panelKindId = isProject
          ? toRuntimePanelKindId(
              { origin: "project", pluginId: manifest.name, kindId: entry.panel.id },
              binding.projectId
            )
          : `${manifest.name}.${entry.panel.id}`;
        if (panelKindId === null) {
          console.error(
            `[PluginService] Plugin "${manifest.name}": cannot qualify launch entry panel "${entry.panel.id}" without an owning project — skipping entry "${entry.id}"`
          );
          continue;
        }
        target = {
          type: "panel",
          panelKindId,
          ...(entry.panel.args !== undefined ? { args: entry.panel.args } : {}),
          ...(entry.panel.placement !== undefined ? { placement: entry.panel.placement } : {}),
        };
      } else if (entry.command !== undefined) {
        target = {
          type: "command",
          actionId: qualifyActionId(entry.command.actionId),
          ...(entry.command.args !== undefined ? { args: entry.command.args } : {}),
        };
      } else if (entry.agent !== undefined) {
        target = { type: "agent", agentId: entry.agent.id, prompt: entry.agent.prompt };
      } else {
        continue;
      }
      registerPluginLaunchEntry({
        id: `${pluginId}.${entry.id}`,
        pluginId,
        pluginName: manifest.displayName ?? manifest.name,
        label: entry.label,
        iconId: resolveIconId(entry.iconId),
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        priority: entry.priority ?? 3,
        ...(entry.when !== undefined ? { when: entry.when } : {}),
        ...(entry.showInEmptyState === true ? { showInEmptyState: true } : {}),
        target,
      });
      trackPluginExpression(pluginId, entry.when);
    }
    if (launchEntries.length > 0) {
      this.deps.broadcaster.scheduleLaunchEntriesBroadcast();
    }

    for (const menuItem of manifest.contributes.menuItems) {
      trackPluginExpression(pluginId, menuItem.when);
      registerPluginMenuItem(pluginId, {
        ...menuItem,
        actionId: qualifyActionId(menuItem.actionId),
      });
    }

    for (const keybinding of manifest.contributes.keybindings) {
      trackPluginExpression(pluginId, keybinding.when);
      registerPluginKeybinding(pluginId, {
        ...keybinding,
        actionId: qualifyActionId(keybinding.actionId),
      });
    }
    if (manifest.contributes.keybindings.length > 0) {
      this.deps.broadcaster.scheduleKeybindingsBroadcast(false);
    }

    for (const ctxMenu of manifest.contributes.contextMenus) {
      trackPluginExpression(pluginId, ctxMenu.when);
      registerPluginContextMenuItem(pluginId, {
        ...ctxMenu,
        actionId: qualifyActionId(ctxMenu.actionId),
      });
    }
    if (manifest.contributes.contextMenus.length > 0) {
      this.deps.broadcaster.scheduleContextMenuItemsBroadcast(false);
    }

    // Lazy MCP discovery (#9235): plugin activation no longer eagerly spawns
    // contributed MCP servers. The subprocess starts on the first tool
    // enumeration (`plugin-mcp:list-tools`), which resolves the contribution
    // and calls the (idempotent) supervisor `start()` at the IPC boundary. This
    // keeps idle plugins from holding live subprocesses they never use.

    if (manifest.contributes.forgeProviders.length > 0) {
      registerForgeProviders(pluginId, manifest.contributes.forgeProviders);
      // Wake workspace-hosts whose PR polling paused on a "no provider
      // matches" resolution so they re-evaluate against the new descriptor
      // (#9997). Covers both the startup scan and runtime install/enable.
      this.deps.getWorkspaceClient()?.notifyForgeProviderRegistryUpdated();
    }

    const elementPickerProviders = manifest.contributes.elementPickerProviders ?? [];
    if (elementPickerProviders.length > 0) {
      registerElementPickerProviders(pluginId, manifest.name, elementPickerProviders, pluginDir);
    }

    if (manifest.contributes.fileDecorationProviders.length > 0) {
      registerFileDecorationProviders(pluginId, manifest.contributes.fileDecorationProviders);
    }

    const worktreeSetupSteps = manifest.contributes.worktreeSetupSteps ?? [];
    if (worktreeSetupSteps.length > 0) {
      registerWorktreeSetupSteps(
        pluginId,
        { pluginName: manifest.displayName || manifest.name, pluginVersion: manifest.version },
        worktreeSetupSteps
      );
    }

    const contextProviders = manifest.contributes.contextProviders ?? [];
    if (contextProviders.length > 0) {
      registerContextProviders(
        pluginId,
        manifest.displayName?.trim() || manifest.name,
        contextProviders
      );
    }

    // Skills (#10892) are read and parsed eagerly here so the built-in MCP
    // server's `skills.search`/`skills.load` tools query an in-memory registry.
    // A malformed/unreadable skill file is skipped (with a warning) rather than
    // failing the plugin load. Torn down per-plugin in unloadPlugin.
    if (manifest.contributes.skills.length > 0) {
      await registerPluginSkills(pluginId, pluginDir, manifest.contributes.skills);
    }

    // Themes (#13832) are read, validated and contrast-gated here, before the
    // commit, and registered after it so a refusal can be written to the
    // committed instance's log. Project plugins can't declare them (the schema
    // refuses the group).
    const themeContributions = manifest.contributes.themes ?? [];
    let themeLoad: PluginThemeLoadResult | null = null;
    if (themeContributions.length > 0) {
      themeLoad = await loadPluginThemes(
        pluginId,
        manifest.displayName ?? manifest.name,
        pluginDir,
        themeContributions
      );
    }

    return {
      customIconAssets,
      customIconKeys,
      resolveIconId,
      ownPrefix,
      qualifyActionId,
      hasPluginSettings,
      themeLoad,
    };
  }

  /**
   * The rest of the registrations, the commit, and everything that publishes
   * after it, in one synchronous stretch. `commit` makes the instance
   * addressable and returns its authority. Never split across an `await`: the
   * broadcaster drains on a microtask, and one running inside this stretch
   * would publish a layout or recipe before the panel kinds it names, and the
   * caller relies on no gap between the commit and its command discovery.
   */
  registerCommitted(
    target: PluginContributionTarget,
    pending: PendingPluginContributions,
    commit: () => PluginProtocolAuthority
  ): void {
    const { pluginId, plugin, manifest, binding } = target;
    const pluginDir = plugin.dir;
    const isProject = plugin.origin === "project";
    const { resolveIconId } = pending;

    if (manifest.contributes.agents.length > 0) {
      registerPluginAgents(pluginId, manifest.contributes.agents, pluginDir);
      this.deps.broadcaster.scheduleAgentsBroadcast(false);
      // Mirror the updated registry into the pty-host so its activity monitor
      // resolves this agent's detection patterns at spawn time (#10587). The
      // renderer is covered by the broadcast above; the pty-host is a separate
      // process that never registers agents itself.
      getPtyClient()?.syncPluginAgentRegistry();
    }

    // Recipes (#11860) are registered AFTER agents so `ownedAgentIds` can be
    // resolved against the live registry rather than the manifest: a
    // cross-plugin agent-id collision resolves first-registered-wins, and a
    // plugin that lost one must not have its recipe launch the winner's agent.
    if (manifest.contributes.recipes.length > 0) {
      const ownedAgentIds = new Set(
        manifest.contributes.agents
          .map((agent) => agent.id)
          .filter((id) => getPluginIdForAgent(id) === pluginId)
      );
      // A `plugin-panel` step (#13797) names its kind as the panels loop below
      // registers it, qualified the same way as a launch entry's panel target.
      const ownedPanelKinds = new Map<string, string>();
      for (const panel of manifest.contributes.panels) {
        const panelKindId = isProject
          ? toRuntimePanelKindId(
              { origin: "project", pluginId: manifest.name, kindId: panel.id },
              binding.projectId
            )
          : `${manifest.name}.${panel.id}`;
        if (panelKindId !== null) ownedPanelKinds.set(panel.id, panelKindId);
      }
      registerPluginRecipes(pluginId, manifest.contributes.recipes, ownedAgentIds, ownedPanelKinds);
      this.deps.broadcaster.scheduleRecipesBroadcast(false);
    }

    // Layouts (#13780) resolve to runtime ids the same way launch entries do: a
    // panel names the kind as the panels loop registers it, a recipe the
    // qualified id `registerPluginRecipes` gave it. The schema already held
    // both to this plugin's own and settled each entry's default location.
    // Registered after recipes so an entry naming a recipe the sanitizer
    // rejected is dropped here rather than failing every apply.
    const layouts = manifest.contributes.layouts ?? [];
    for (const layout of layouts) {
      const entries: PluginLayoutEntry[] = [];
      for (const entry of layout.entries) {
        const placement = {
          ...(entry.tabGroup !== undefined ? { tabGroup: entry.tabGroup } : {}),
          ...(entry.maximized === true ? { maximized: true } : {}),
        };
        if (entry.panel !== undefined) {
          const panel = manifest.contributes.panels.find((p) => p.id === entry.panel);
          const panelKindId = isProject
            ? toRuntimePanelKindId(
                { origin: "project", pluginId: manifest.name, kindId: entry.panel },
                binding.projectId
              )
            : `${manifest.name}.${entry.panel}`;
          if (panelKindId === null) {
            console.error(
              `[PluginService] Plugin "${manifest.name}": cannot qualify layout panel "${entry.panel}" without an owning project — skipping layout "${layout.id}"`
            );
            entries.length = 0;
            break;
          }
          entries.push({
            target: { type: "panel", panelKindId },
            location: entry.location ?? (panel?.scope === "project" ? "dock" : "grid"),
            ...placement,
          });
        } else if (entry.browser !== undefined) {
          entries.push({
            target: { type: "browser", url: entry.browser },
            location: entry.location ?? "grid",
            ...placement,
          });
        } else if (entry.recipe !== undefined) {
          const recipeId = `${pluginId}.${entry.recipe}`;
          if (getPluginRecipe(recipeId) === undefined) {
            console.error(
              `[PluginService] Plugin "${manifest.name}": layout "${layout.id}" names recipe "${entry.recipe}", which was not registered — dropping that entry`
            );
            continue;
          }
          entries.push({
            target: { type: "recipe", recipeId },
            location: entry.location ?? "grid",
            ...placement,
          });
        }
      }
      if (entries.length === 0) continue;
      registerPluginLayout({
        id: `${pluginId}.${layout.id}`,
        pluginId,
        pluginName: manifest.displayName ?? manifest.name,
        name: layout.name,
        entries,
        // The project's first open picks it up from the broadcast (#13782).
        ...(isProject && manifest.contributes.surfaces?.defaultLayout === layout.id
          ? { projectDefault: true as const }
          : {}),
      });
    }
    if (layouts.length > 0) {
      this.deps.broadcaster.scheduleLayoutsBroadcast();
    }

    if (manifest.contributes.processTools.length > 0) {
      registerPluginProcessTools(
        pluginId,
        manifest.contributes.processTools.map((tool) => ({
          ...tool,
          iconId: resolveIconId(tool.iconId),
        }))
      );
      // Mirror into the pty-host, where `ProcessDetector` runs — the renderer
      // needs no broadcast because the detected icon id already reaches it on
      // the terminal identity event (#11613).
      getPtyClient()?.syncPluginProcessToolRegistry();
    }

    const authority = commit();
    this.registerAfterCommit(target, authority, pending);
  }

  /**
   * Everything that publishes a `plugin://` URL or reads the committed
   * instance. Synchronous on purpose: it runs straight after the commit with no
   * await in between, which is what makes the commit the addressability gate.
   */
  private registerAfterCommit(
    target: PluginContributionTarget,
    authority: PluginProtocolAuthority,
    pending: PendingPluginContributions
  ): void {
    const { pluginId, plugin, manifest, binding } = target;
    const pluginDir = plugin.dir;
    const isProject = plugin.origin === "project";
    const {
      customIconAssets,
      customIconKeys,
      resolveIconId,
      ownPrefix,
      qualifyActionId,
      hasPluginSettings,
      themeLoad,
    } = pending;

    if (customIconAssets.length > 0) {
      registerPluginCustomIcons(pluginId, customIconAssets);
      this.deps.broadcaster.schedulePluginIconsBroadcast();
    }
    if (themeLoad) {
      registerPluginThemes(pluginId, themeLoad.accepted);
      for (const { themeId, reason } of themeLoad.refused) {
        this.deps.recordPluginLog(
          plugin,
          pluginId,
          "warn",
          `Theme "${themeId}" isn't offered: ${reason}`
        );
      }
      this.deps.themesChanged(pluginId, "registered");
    }

    // The host's read-only database endpoint, bound with the plugin rather than
    // at activation: agents read the data without the plugin's code running.
    // Unload drops it with the instance's other rosters.
    if (manifest.contributes.databases.length > 0) {
      registerPluginDatabaseEndpoint({
        pluginInstanceId: pluginId,
        manifestId: manifest.name,
        declarations: manifest.contributes.databases,
        boundProjectId: binding.projectId,
        boundProjectRoot: binding.projectRoot,
        dataDir: this.deps.pluginDataDir(pluginId),
        isCurrent: () => this.deps.isCurrent(pluginId, plugin),
      });
    }

    // Quick switcher search providers (#13792), bound with the plugin rather
    // than at activation: a declarative one answers from its declared query
    // without the plugin's code running, and a runtime one is asked only once
    // `activate()` has bound it. Every target a result names is resolved here,
    // so a row can only open this plugin's own panels and commands.
    const searchProviders = manifest.contributes.searchProviders ?? [];
    if (searchProviders.length > 0) {
      const panelKindIdFor = (panelId: string): string | null => {
        const panel = manifest.contributes.panels.find((candidate) => candidate.id === panelId);
        if (!panel || panel.hasPty === true) return null;
        return isProject
          ? toRuntimePanelKindId(
              { origin: "project", pluginId: manifest.name, kindId: panelId },
              binding.projectId
            )
          : `${manifest.name}.${panelId}`;
      };
      const declaredCommands = new Set(
        manifest.contributes.commands.map((command) => `${ownPrefix}${command.id}`)
      );
      const resolveTarget = (
        target: PluginSearchResultTarget,
        args: Record<string, unknown>
      ): PluginSearchResolvedTarget | null => {
        if (typeof target.panel === "string" && target.command === undefined) {
          const panelKindId = panelKindIdFor(target.panel);
          return panelKindId === null ? null : { type: "panel", panelKindId, args };
        }
        if (typeof target.command === "string" && target.panel === undefined) {
          const actionId = target.command;
          if (
            !actionId.startsWith(ownPrefix) ||
            actionId.length === ownPrefix.length ||
            isBuiltInActionId(actionId) ||
            (declaredCommands.size > 0 && !declaredCommands.has(actionId))
          ) {
            return null;
          }
          return { type: "command", actionId: qualifyActionId(actionId), args };
        }
        return null;
      };
      const resolveResultIcon = (iconId: string): string | undefined =>
        isPluginIconId(iconId) ? iconId : customIconKeys.get(iconId);
      const declaredQueries = manifest.contributes.databases.flatMap((declaration) =>
        (declaration.queries ?? []).map((query) => ({ declaration, query }))
      );
      const registered: RegisteredSearchProvider[] = [];
      for (const provider of searchProviders) {
        let runDeclarative: DeclarativeSearchRunner | undefined;
        if (provider.kind === "declarative") {
          const declared = declaredQueries.find(({ query }) => query.name === provider.query);
          if (!declared) continue;
          runDeclarative = createDeclarativeSearchRunner({
            declaration: declared.declaration,
            query: declared.query,
            manifestId: manifest.name,
            projectRoot: binding.projectRoot,
            dataDir: this.deps.pluginDataDir(pluginId),
            isCurrent: () => this.deps.isCurrent(pluginId, plugin),
          });
        }
        registered.push({
          key: `${pluginId}.${provider.id}`,
          pluginId,
          providerId: provider.id,
          pluginName: manifest.displayName ?? manifest.name,
          title: provider.title,
          keyword: provider.keyword,
          iconId: resolveIconId(provider.iconId ?? SEARCH_PROVIDER_DEFAULT_ICON_ID),
          blend: provider.blend === true,
          kind: provider.kind,
          projectId: binding.projectId,
          ...(provider.target !== undefined ? { defaultTarget: provider.target } : {}),
          resolveTarget,
          resolveResultIcon,
          ...(runDeclarative ? { runDeclarative } : {}),
        });
      }
      // Reported to the refused provider's own plugin, which may be another one
      // whose keyword this plugin's reload just took back.
      for (const { provider, takenBy } of registerSearchProviders(pluginId, registered)) {
        const refused = this.deps.getLoadedPlugin(provider.pluginId);
        if (!refused) continue;
        this.deps.recordPluginLog(
          refused,
          provider.pluginId,
          "warn",
          `Search provider "${provider.providerId}" keyword "${provider.keyword}" is already taken by ${takenBy.pluginName}, so the quick switcher refuses it wherever both plugins are on. Choose a different keyword.`
        );
      }
    }

    // Panel kinds are published only AFTER the map commit above, with no await
    // in between (#11728). `registerPanelKind` is what makes a panel
    // addressable — it carries the `plugin://` `componentPath` and schedules the
    // `plugin:panel-kinds-changed` broadcast — while the protocol handler's
    // resolver reads the authority map committed with it. Publishing first, as
    // this block used to, handed the renderer a URL that the protocol could not
    // yet resolve; any plugin with an await before the commit (a `skills`
    // contribution alone was enough) 404'd its own view module, and a rejected
    // dynamic import is permanent for that specifier. The map commit is now the
    // single addressability gate, so this ordering is the invariant, not an
    // incidental arrangement.
    //
    // Index views by bare id so the panels loop can attach `componentPath` in
    // a single registerPanelKind pass (#9229). View ids are pre-namespace; the
    // runtime panel id is `${manifest.name}.${panel.id}`. The generation lives
    // on `plugin` (allocated at construction) so every view shares one virtual
    // namespace, which is what lets relative imports inherit it (#11301).
    const viewsByBareId = new Map<string, ViewContribution>();
    const unmatchedViewIds = new Set<string>();
    for (const view of manifest.contributes.views) {
      // `componentPath` safety is enforced by `ViewContributionSchema` at
      // manifest parse. A view for any other location mounts outside the
      // panel grid, so it is left out of the panel match entirely and
      // registered as a hosted view below.
      if (view.location !== "panel") continue;
      if (viewsByBareId.has(view.id)) {
        // Two entries with the same bare id — last would silently overwrite
        // earlier. Surface the authoring mistake; keep the first to make the
        // outcome deterministic.
        console.warn(
          `[PluginService] Plugin "${manifest.name}": views has duplicate entries for id "${view.id}"; keeping the first occurrence`
        );
        continue;
      }
      viewsByBareId.set(view.id, view);
      unmatchedViewIds.add(view.id);
    }

    // A panel kind's menus offer at most one Welcome Tour, so a second tour
    // naming the same kind is an authoring mistake: keep the first, as views do.
    const tourIdByPanelId = new Map<string, string>();
    for (const tour of manifest.contributes.tours) {
      if (tour.panelKind === undefined) continue;
      if (tourIdByPanelId.has(tour.panelKind)) {
        console.warn(
          `[PluginService] Plugin "${manifest.name}": tours "${tour.id}" is a second tour for panel "${tour.panelKind}"; keeping the first`
        );
        continue;
      }
      tourIdByPanelId.set(tour.panelKind, makePluginTourId(pluginId, tour.id));
    }

    // Every panel of the plugin offers "Plugin settings…" when there is anything
    // to configure, and checks its required settings when it declares any.
    // Only present-when-true, so a plugin with no settings registers exactly
    // the config it did before.
    const declaredSettings = manifest.contributes.settings;
    const pluginSettingsKindFlags = {
      ...(hasPluginSettings ? { hasPluginSettings: true } : {}),
      ...(declaredSettings.some((s) => s.required === true) ? { hasRequiredSettings: true } : {}),
      ...((manifest.contributes.setup?.length ?? 0) > 0 ? { hasSetupSteps: true } : {}),
      // "Back up data…" on every panel of a plugin that declares a database;
      // main checks what actually exists when it is picked.
      ...((manifest.contributes.databases?.length ?? 0) > 0 ? { hasPluginDatabases: true } : {}),
    };

    for (const panel of manifest.contributes.panels) {
      // A project plugin's panel kinds register under the project-qualified
      // runtime id, so two projects can each contribute `acme.dash/overview`
      // without one silently overwriting the other. `toRuntimePanelKindId`
      // returns null for a project ref with no owning project — that can only
      // mean a bug in the caller, and inventing the unqualified form here would
      // alias a project kind onto a global one.
      const panelId = isProject
        ? toRuntimePanelKindId(
            { origin: "project", pluginId: manifest.name, kindId: panel.id },
            binding.projectId
          )
        : `${manifest.name}.${panel.id}`;
      if (panelId === null) {
        console.error(
          `[PluginService] Plugin "${manifest.name}": cannot qualify panel kind "${panel.id}" without an owning project — skipping`
        );
        continue;
      }
      const view = viewsByBareId.get(panel.id);
      if (view) unmatchedViewIds.delete(panel.id);
      const tourId = tourIdByPanelId.get(panel.id);
      registerPanelKind({
        ...pluginSettingsKindFlags,
        id: panelId,
        name: panel.name,
        iconId: resolveIconId(panel.iconId),
        color: panel.color,
        hasPty: panel.hasPty,
        canRestart: panel.canRestart,
        canConvert: panel.canConvert,
        showInPalette: panel.showInPalette,
        // Dockable by default; only forward an explicit opt-out (or opt-in) so
        // absence stays `undefined` and `panelKindIsDockable` applies the
        // default. #11332.
        ...(panel.dockable !== undefined ? { dockable: panel.dockable } : {}),
        // Absence has to survive as `undefined` for the same reason as
        // `dockable`: a plugin that declares no state version gets its bag
        // handed over unjudged, and defaulting to 1 here would start refusing
        // bags on a promise the author never made (#12280).
        ...(panel.stateVersion !== undefined ? { stateVersion: panel.stateVersion } : {}),
        ...(panel.scope !== undefined ? { scope: panel.scope } : {}),
        ...(panel.reportsActivity !== undefined ? { reportsActivity: panel.reportsActivity } : {}),
        ...(tourId !== undefined ? { tourId } : {}),
        // Authored in the manifest namespace, dispatched in the instance's —
        // the same rewrite the toolbar and menu contributions above get.
        ...(panel.menu !== undefined && panel.menu.length > 0
          ? {
              pluginMenu: panel.menu.map((item) => ({
                actionId: qualifyActionId(item.actionId),
                ...(item.label !== undefined ? { label: item.label } : {}),
              })),
            }
          : {}),
        // The manifest's own id rides along as `stateKey`: it is what the view
        // names when it sets a button's state, so it must not be rewritten.
        ...(panel.toolbar !== undefined && panel.toolbar.length > 0
          ? {
              pluginToolbar: panel.toolbar.map((item) => ({
                actionId: qualifyActionId(item.actionId),
                stateKey: item.actionId,
                ...(item.label !== undefined ? { label: item.label } : {}),
                ...(item.iconId !== undefined ? { iconId: resolveIconId(item.iconId) } : {}),
                ...(item.status === true ? { status: true } : {}),
              })),
            }
          : {}),
        // Keyed by the INSTANCE, because `unregisterPluginPanelKinds` matches
        // on `extensionId` alone: keying by manifest id would make one
        // project's unload sweep every other project's copies of the same kind.
        extensionId: pluginId,
        ...(isProject ? { projectId: binding.projectId, pluginManifestId: manifest.name } : {}),
        ...(view && !panel.hasPty
          ? {
              componentPath: buildPluginViewUrl(
                authority,
                view.componentPath,
                plugin.viewGeneration
              ),
            }
          : {}),
      });
      if (view && panel.hasPty) {
        // A PTY panel with a matching view is contradictory — the view module
        // would never render because TerminalPane owns the surface. Surface the
        // collision rather than silently dropping the view.
        console.warn(
          `[PluginService] Plugin "${manifest.name}": views entry "${view.id}" matches a panel with hasPty=true; the view will be ignored because PTY panels are rendered by TerminalPane`
        );
      }
    }

    for (const orphanId of unmatchedViewIds) {
      console.warn(
        `[PluginService] Plugin "${manifest.name}": views entry "${orphanId}" has no matching contributes.panels entry and will be ignored`
      );
    }

    // Project templates (#13825) are declarative: the host reads their files
    // straight from the plugin folder when the Create project dialog asks, so
    // nothing here runs plugin code. Installed and builtin plugins only — the
    // manifest schema refuses them for project scope.
    if (manifest.contributes.projectTemplates.length > 0) {
      registerPluginProjectTemplates(
        pluginId,
        manifest.displayName ?? manifest.name,
        pluginDir,
        manifest.contributes.projectTemplates
      );
    }

    // Tours (#12773) resolve their scene module and bundled audio under this
    // load's authority and generation, so a reload hands renderers URLs V8 has
    // never cached. The module itself is imported only when a tour opens.
    // Registered under the instance key, so a project plugin's tours stay with
    // its project and never collide with the same plugin installed globally.
    if (manifest.contributes.tours.length > 0) {
      registerPluginTours(pluginId, manifest.contributes.tours, {
        pluginName: manifest.displayName ?? manifest.name,
        pluginUrl: (relativePath) =>
          buildPluginViewUrl(authority, relativePath, plugin.viewGeneration),
        qualifyActionId: (actionId) => qualifyOwnActionId(pluginId, manifest.name, actionId),
      });
      this.deps.broadcaster.scheduleToursBroadcast();
    }

    // Views that mount outside the panel grid (#13770) — the settings section,
    // file editor views and sidebar views. Registered here, after the map
    // commit and with no await since, for the same addressability reason as the
    // panel kinds above: the URL is only resolvable once the protocol handler
    // can see this load's authority. Never registered as panel kinds, so
    // nothing can spawn one.
    const pluginName = manifest.displayName ?? manifest.name;
    const hostedViews = manifest.contributes.views.flatMap((view): PluginHostedViewDescriptor[] => {
      if (view.location === "panel") return [];
      const base = {
        id: pluginHostedViewKindId(pluginId, view.id),
        pluginId,
        viewId: view.id,
        componentPath: buildPluginViewUrl(authority, view.componentPath, plugin.viewGeneration),
      };
      if (view.location === "settings") {
        return [{ ...base, location: "settings", name: `${pluginName} settings` }];
      }
      if (view.location === "fileEditor") {
        return [
          {
            ...base,
            location: "fileEditor",
            name: `${pluginName} fileEditor`,
            // The view-backed file editors this view backs (#13809), so the
            // renderer learns the claim and the module URL from one snapshot,
            // narrowed to the projects that may see the plugin.
            fileEditors: manifest.contributes.fileEditors.flatMap((entry) =>
              entry.view === view.id && entry.mode !== undefined
                ? [
                    {
                      id: entry.id,
                      mode: entry.mode,
                      extensions: entry.extensions ?? [],
                      paths: entry.paths ?? [],
                      maxBytes: entry.maxBytes ?? DEFAULT_FILE_EDITOR_MAX_BYTES,
                    },
                  ]
                : []
            ),
          },
        ];
      }
      // The schema requires a sidebar view's name; the id stands in only for
      // a manifest that skipped validation.
      const title = view.name ?? view.id;
      return [
        {
          ...base,
          location: "sidebar",
          name: `${pluginName} ${title}`,
          title,
          pluginName,
          ...(view.iconId !== undefined ? { iconId: resolveIconId(view.iconId) } : {}),
          priority: view.priority ?? SIDEBAR_VIEW_DEFAULT_PRIORITY,
          ...(view.when !== undefined ? { when: view.when } : {}),
        },
      ];
    });
    if (hostedViews.length > 0) {
      registerPluginHostedViews(pluginId, hostedViews);
      this.deps.broadcaster.scheduleHostedViewsBroadcast();
    }

    // Project surface claims (§7.8). After the panels loop, because a claim
    // resolves to the RUNTIME panel-kind id that loop just registered — the
    // renderer mounts a surface through the ordinary plugin-view path, so a
    // claim naming a kind that never registered would point at nothing.
    //
    // Additive only: a claim replaces one slot's content and touches no host
    // chrome, so the project switcher, the worktree dashboard and the stock
    // launcher stay reachable even when the claimed view is broken.
    if (isProject && binding.projectId != null && binding.projectId.length > 0) {
      const surfaceProjectId = binding.projectId;
      const surfaces = manifest.contributes.surfaces ?? {};
      let surfacesChanged = false;
      // Never a silent winner: which claim the user sees follows a fixed rank,
      // and BOTH plugins are named, because the fix is to change one of the two
      // manifests and the author cannot do that without knowing the other. The
      // same refusal reaches project plugin settings and `daintree-plugin doctor`.
      const reportConflict = (claimed: string, result: SurfaceClaimResult) => {
        if (!result.ok && result.reason === "outranked" && result.heldBy !== undefined) {
          console.warn(
            `[PluginService] Project surface conflict: "${manifest.name}" claims ${claimed}, which "${pluginManifestIdFromInstanceKey(result.heldBy)}" holds in this project. Only one plugin may claim it; the lower manifest id keeps it.`
          );
        } else if (result.ok && result.displaced !== undefined) {
          console.warn(
            `[PluginService] Project surface conflict: "${manifest.name}" takes ${claimed} from "${pluginManifestIdFromInstanceKey(result.displaced)}" in this project. Only one plugin may claim it; the lower manifest id keeps it.`
          );
        }
      };
      for (const slot of PROJECT_SURFACE_SLOTS) {
        const claim = surfaces[slot];
        if (claim === undefined) continue;
        surfacesChanged = true;
        const panelKindId = toRuntimePanelKindId(
          { origin: "project", pluginId: manifest.name, kindId: claim.viewId },
          surfaceProjectId
        );
        // The schema already cross-checks `viewId` against `contributes.views`,
        // and a view without a matching panel is a manifest error — so a miss
        // here means the panels loop skipped the kind (an unqualifiable id, or
        // a `hasPty` panel whose view is ignored). Refuse the slot rather than
        // publish a claim the renderer cannot resolve.
        // `componentPath`, not merely a registered kind: the panels loop leaves
        // it off for a PTY panel (and for a view it skipped), and a claim with
        // no module to load would hold the project's slot against every other
        // plugin while rendering nothing.
        if (panelKindId === null || getPanelKindConfig(panelKindId)?.componentPath === undefined) {
          refuseProjectSurface(surfaceProjectId, slot, pluginId, "unresolved-view");
          console.warn(
            `[PluginService] Plugin "${manifest.name}": surfaces.${slot} names view "${claim.viewId}", which registered no loadable panel kind — the slot keeps its stock content`
          );
          continue;
        }
        const result = claimProjectSurface(surfaceProjectId, slot, {
          pluginId,
          scope: "project",
          value: { kind: "view", viewId: claim.viewId, panelKindId },
        });
        reportConflict(`surfaces.${slot}`, result);
      }
      // File editor defaults (#13811): each pattern of a `default` editor claims
      // that pattern's slot, with the editor's bare id as the claim. The schema
      // confines the flag to a view-backed Edit editor with paths, and the
      // hosted views above already carry that editor, so the renderer resolves
      // the claim against the same snapshot it offers the editor from.
      for (const entry of manifest.contributes.fileEditors) {
        if (entry.default !== true || entry.mode !== "edit" || entry.view === undefined) continue;
        for (const pattern of entry.paths ?? []) {
          surfacesChanged = true;
          const result = claimProjectSurface(surfaceProjectId, fileEditorSlotKey(pattern), {
            pluginId,
            scope: "project",
            value: { kind: "data", data: { editorId: entry.id } },
          });
          reportConflict(`the default editor for "${pattern}"`, result);
        }
      }
      if (surfacesChanged) this.deps.publishProjectSurfaces([surfaceProjectId]);
    }
  }

  /** The registry half of the unload cascade, in its original order. */
  unregister(pluginId: string, options?: { reload: true }): void {
    runUnloadStep(pluginId, "unregisterPluginMenuItems", () => unregisterPluginMenuItems(pluginId));
    runUnloadStep(pluginId, "unregisterPluginKeybindings", () =>
      unregisterPluginKeybindings(pluginId)
    );
    runUnloadStep(pluginId, "scheduleKeybindingsBroadcast", () =>
      this.deps.broadcaster.scheduleKeybindingsBroadcast(true)
    );
    runUnloadStep(pluginId, "unregisterPluginContextMenuItems", () =>
      unregisterPluginContextMenuItems(pluginId)
    );
    runUnloadStep(pluginId, "scheduleContextMenuItemsBroadcast", () =>
      this.deps.broadcaster.scheduleContextMenuItemsBroadcast(true)
    );
    runUnloadStep(pluginId, "unregisterWhenClausePlugin", () =>
      unregisterWhenClausePlugin(pluginId)
    );
    runUnloadStep(pluginId, "unregisterPluginToolbarButtons", () =>
      unregisterPluginToolbarButtons(pluginId)
    );
    runUnloadStep(pluginId, "scheduleToolbarButtonsBroadcast", () =>
      this.deps.broadcaster.scheduleToolbarButtonsBroadcast(true)
    );
    runUnloadStep(pluginId, "unregisterPluginLaunchEntries", () =>
      unregisterPluginLaunchEntries(pluginId)
    );
    runUnloadStep(pluginId, "unregisterSearchProviders", () => unregisterSearchProviders(pluginId));
    runUnloadStep(pluginId, "scheduleLaunchEntriesBroadcast", () =>
      this.deps.broadcaster.scheduleLaunchEntriesBroadcast()
    );
    runUnloadStep(pluginId, "unregisterPluginLayouts", () => unregisterPluginLayouts(pluginId));
    runUnloadStep(pluginId, "scheduleLayoutsBroadcast", () =>
      this.deps.broadcaster.scheduleLayoutsBroadcast()
    );
    runUnloadStep(pluginId, "unregisterPluginPanelKinds", () =>
      unregisterPluginPanelKinds(pluginId)
    );
    // Its own step (#9322): the per-subscription disposers already ran via
    // `flushPluginEventCleanups`, but a disposer lost to an earlier throw would
    // otherwise strand a listener holding this plugin's closure alive.
    runUnloadStep(pluginId, "clearPanelLifecycleListeners", () =>
      this.deps.panelLifecycleBroker.clearPlugin(pluginId)
    );
    runUnloadStep(pluginId, "cancelPanelReloads", () =>
      this.deps.panelReloadDispatcher.cancelPlugin(pluginId)
    );
    runUnloadStep(pluginId, "unregisterElementPickerProviders", () =>
      unregisterElementPickerProviders(pluginId)
    );
    runUnloadStep(pluginId, "unregisterForgeProviders", () => unregisterForgeProviders(pluginId));
    runUnloadStep(pluginId, "unregisterForgeProviderImpls", () =>
      unregisterForgeProviderImpls(pluginId)
    );
    // Mirror the load-path notify (registerBeforeCommit): a runtime disable
    // removes forge descriptors/impls from the registry, so workspace hosts
    // whose PR polling resolved (or no-matched) against this provider must
    // re-evaluate. A spurious notify for a plugin that contributed no forge
    // provider is harmless — PullRequestService only invalidates a cached
    // no-match. Without this, live-disable left stale provider resolution.
    runUnloadStep(pluginId, "notifyForgeProviderRegistryUpdated", () =>
      this.deps.getWorkspaceClient()?.notifyForgeProviderRegistryUpdated()
    );
    runUnloadStep(pluginId, "unregisterFileDecorationProviders", () =>
      unregisterFileDecorationProviders(pluginId)
    );
    runUnloadStep(pluginId, "unregisterFileDecorationProviderImpls", () =>
      unregisterFileDecorationProviderImpls(pluginId)
    );
    runUnloadStep(pluginId, "unregisterWorktreeSetupSteps", () =>
      unregisterWorktreeSetupSteps(pluginId)
    );
    runUnloadStep(pluginId, "unregisterWorktreeSetupStepHandlers", () =>
      unregisterWorktreeSetupStepHandlers(pluginId)
    );
    runUnloadStep(pluginId, "unregisterContextProviders", () =>
      unregisterContextProviders(pluginId)
    );
    runUnloadStep(pluginId, "unregisterContextProviderImpls", () =>
      unregisterContextProviderImpls(pluginId)
    );
    runUnloadStep(pluginId, "unregisterWorktreeDeleteNotesBinding", () =>
      unregisterWorktreeDeleteNotesBinding(pluginId)
    );
    runUnloadStep(pluginId, "unregisterPluginSkills", () => unregisterPluginSkills(pluginId));
    runUnloadStep(pluginId, "unregisterPluginThemes", () => {
      if (!unregisterPluginThemes(pluginId)) return;
      this.deps.themesChanged(pluginId, options?.reload ? "reloading" : "removed");
    });
    // Recipes retract on unload/disable/reload, but their sidecar metadata does
    // NOT — only an explicit successful uninstall purges that (#11860).
    runUnloadStep(pluginId, "unregisterPluginRecipes", () => unregisterPluginRecipes(pluginId));
    runUnloadStep(pluginId, "scheduleRecipesBroadcast", () =>
      this.deps.broadcaster.scheduleRecipesBroadcast(true)
    );
    runUnloadStep(pluginId, "unregisterPluginTours", () => unregisterPluginTours(pluginId));
    runUnloadStep(pluginId, "unregisterPluginProjectTemplates", () =>
      unregisterPluginProjectTemplates(pluginId)
    );
    runUnloadStep(pluginId, "scheduleToursBroadcast", () =>
      this.deps.broadcaster.scheduleToursBroadcast()
    );
    runUnloadStep(pluginId, "unregisterPluginHostedViews", () => {
      if (unregisterPluginHostedViews(pluginId))
        this.deps.broadcaster.scheduleHostedViewsBroadcast();
    });
    runUnloadStep(pluginId, "unregisterPluginAgents", () => unregisterPluginAgents(pluginId));
    runUnloadStep(pluginId, "scheduleAgentsBroadcast", () =>
      this.deps.broadcaster.scheduleAgentsBroadcast(true)
    );
    // Re-mirror the (now-smaller) registry to the pty-host so it stops resolving
    // detection patterns for the unloaded plugin's agents (#10587).
    runUnloadStep(pluginId, "syncPluginAgentRegistryToPtyHost", () =>
      getPtyClient()?.syncPluginAgentRegistry()
    );
    runUnloadStep(pluginId, "unregisterPluginCustomIcons", () => {
      if (unregisterPluginCustomIcons(pluginId))
        this.deps.broadcaster.schedulePluginIconsBroadcast();
    });
    runUnloadStep(pluginId, "unregisterPluginProcessTools", () =>
      unregisterPluginProcessTools(pluginId)
    );
    // Re-mirror the (now-smaller) registry so the pty-host stops resolving the
    // unloaded plugin's command detections. A discrete step from the unregister
    // above per the unload-cascade contract — a throw in one can't strand the
    // other (#11613).
    runUnloadStep(pluginId, "syncPluginProcessToolRegistryToPtyHost", () =>
      getPtyClient()?.syncPluginProcessToolRegistry()
    );
  }

  /** Called once the instance has left the plugins map. */
  releaseScope(pluginId: string): void {
    // Drop the project-scope index entry with the instance it described.
    // Leaving it behind would keep filtering broadcasts against a plugin id
    // that no longer exists, and would resurface if the id were reloaded
    // under a different project.
    runUnloadStep(pluginId, "clearPluginContributionScope", () =>
      clearPluginContributionScope(pluginId)
    );

    // A surface must not outlive the plugin that draws it: the claimed view's
    // module is unimportable the moment its authority is dropped, so a
    // surviving claim would leave the project rendering a permanently-failing
    // view where its stock content used to be. Trust revoke unloads through
    // this same cascade, so revoking trust releases the slot too. Every
    // project it touched is told, so its views fall back (to stock or to the
    // next claimant) now rather than at the next unrelated panel-kind change.
    runUnloadStep(pluginId, "releasePluginSurfaces", () =>
      this.deps.publishProjectSurfaces(releasePluginSurfaces(pluginId))
    );
  }
}
