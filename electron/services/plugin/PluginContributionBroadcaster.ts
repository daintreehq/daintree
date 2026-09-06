import { broadcastToRenderer, broadcastToProjectRenderers } from "../../ipc/utils.js";
import {
  getAllAppWebContents,
  getProjectForWebContents,
  getRegisteredProjectViews,
} from "../../window/webContentsRegistry.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getPluginPanelKinds } from "../../../shared/config/panelKindRegistry.js";
import { getAllPluginToolbarButtonConfigs } from "../../../shared/config/toolbarButtonRegistry.js";
import { getPluginKeybindings } from "../pluginKeybindingRegistry.js";
import { getPluginContextMenuItems } from "../pluginContextMenuRegistry.js";
import { getPluginAgentRegistry } from "../../../shared/config/pluginAgentRegistry.js";
import { getPluginRecipes } from "./PluginRecipeRegistry.js";
import {
  hasProjectPluginVisibilityOverrides,
  isPluginVisibleInProject,
} from "./projectPluginVisibility.js";
import type { PluginActionDescriptor, PluginScopeKey } from "../../../shared/types/plugin.js";

/**
 * Scope of a plugin's contributions: `"global"` for installed and builtin
 * plugins, or the owning project's app-minted id for a project-local plugin.
 * Deliberately the same vocabulary as {@link PluginScopeKey} — a plugin's
 * durable state scope and its contribution scope are the same fact.
 */
export type ContributionScope = PluginScopeKey;

/**
 * pluginId → owning project id, for project-scoped plugins only.
 *
 * Global plugins are ABSENT rather than mapped to `"global"`, so the map is
 * empty in an app with no project-local plugins — which is every app today.
 * {@link hasProjectScopedContributions} then short-circuits every filter to the
 * identity, and each broadcast is the exact single `broadcastToRenderer` call
 * it was before contribution scoping existed.
 *
 * Module-level rather than instance state because the registries it filters
 * (`panelKindRegistry`, `toolbarButtonRegistry`, `pluginKeybindingRegistry`,
 * `pluginContextMenuRegistry`) are module-level singletons too — a per-service
 * scope index would disagree with a shared registry.
 */
const PROJECT_SCOPED_PLUGINS = new Map<string, string>();

/**
 * Record the scope every contribution registered by `pluginId` belongs to.
 * The plugin LOADER calls this before registering the plugin's contributions;
 * a plugin never seen here is global, which is why nothing changes for
 * installed and builtin plugins.
 *
 * Throws on an empty project id: a scope that is present but blank is a bug in
 * the loader, and silently treating it as global would publish a project's
 * panels to every view — the exact leak this module exists to prevent.
 */
export function setPluginContributionScope(pluginId: string, scope: ContributionScope): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) {
    throw new TypeError("setPluginContributionScope: pluginId must be a non-empty string");
  }
  if (scope === "global") {
    PROJECT_SCOPED_PLUGINS.delete(pluginId);
    return;
  }
  if (typeof scope !== "string" || scope.length === 0) {
    throw new TypeError(
      `setPluginContributionScope: scope for "${pluginId}" must be "global" or a non-empty project id`
    );
  }
  PROJECT_SCOPED_PLUGINS.set(pluginId, scope);
}

/** The scope a plugin's contributions carry. Unknown plugins are global. */
export function getPluginContributionScope(pluginId: string): ContributionScope {
  return PROJECT_SCOPED_PLUGINS.get(pluginId) ?? "global";
}

/** Drop a plugin's scope on unload. Idempotent. */
export function clearPluginContributionScope(pluginId: string): void {
  PROJECT_SCOPED_PLUGINS.delete(pluginId);
}

/** Reset every recorded scope. Test isolation and full plugin-host disposal. */
export function clearAllPluginContributionScopes(): void {
  PROJECT_SCOPED_PLUGINS.clear();
}

/**
 * Whether any loaded plugin is project-scoped. False in an app with only
 * installed/builtin plugins, which is the fast path every filter takes.
 */
export function hasProjectScopedContributions(): boolean {
  return PROJECT_SCOPED_PLUGINS.size > 0;
}

/**
 * Whether ANY reason exists for two views to see different contributions — a
 * project-local plugin, or a per-project visibility decision about a global one.
 *
 * The identity fast path is keyed on this rather than on
 * {@link hasProjectScopedContributions} alone, because the two conditions are
 * independent: an app with no project plugins at all can still have an installed
 * plugin the user switched off in one project, and filtering only on the scope
 * map would silently ignore that.
 */
function hasScopedOrHiddenContributions(): boolean {
  return PROJECT_SCOPED_PLUGINS.size > 0 || hasProjectPluginVisibilityOverrides();
}

/**
 * Does a contribution owned by `pluginId` belong in a view of `projectId`?
 *
 * `projectId` is `null` for a renderer with no project binding (an unbound
 * window showing the project picker, or a view registered after this call).
 * That is "unknown", not "unauthorized" — it sees global contributions and
 * nothing else. An empty-string project id is treated the same way: a blank id
 * matches no project rather than matching every one, so a caller that passes a
 * degenerate id fails closed instead of leaking (`== null` gates only, never
 * truthiness — a project id is compared, never tested).
 */
function isVisibleInProject(pluginId: string | undefined, projectId: string | null): boolean {
  if (pluginId === undefined) return true;
  const scope = PROJECT_SCOPED_PLUGINS.get(pluginId);
  // Global plugin: it runs everywhere, so the only thing that can hide it is an
  // explicit per-project decision. Consulted HERE, at the single point every
  // contribution passes through, rather than anywhere the toggle is written —
  // a filter that reads the overlay only at registration time would leave the
  // switch flipped and the panels still showing.
  if (scope === undefined) return isPluginVisibleInProject(pluginId, projectId);
  if (projectId === null || projectId.length === 0) return false;
  return scope === projectId;
}

/**
 * Narrow a registry snapshot to what a view of `projectId` may see:
 * global contributions plus that project's own.
 *
 * Returns the input array by reference when no plugin is project-scoped, so
 * the all-global app broadcasts the identical payload it always has.
 */
function forProject<T>(
  items: readonly T[],
  pluginIdOf: (item: T) => string | undefined,
  projectId: string | null
): T[] {
  if (!hasScopedOrHiddenContributions()) return items as T[];
  return items.filter((item) => isVisibleInProject(pluginIdOf(item), projectId));
}

/**
 * Main-side registry query, scoped to one project.
 *
 * `projectId` is REQUIRED: a lookup with no project context is a programming
 * error, and this throws rather than guessing the active project — guessing is
 * how one project's contributions end up in another's window. `null` is a
 * legitimate answer (a sender with no project binding) and yields the global
 * contributions; `undefined` is a caller that forgot to resolve one.
 */
export function selectContributionsForProject<T>(
  items: readonly T[],
  pluginIdOf: (item: T) => string | undefined,
  projectId: string | null | undefined
): T[] {
  if (projectId === undefined) {
    throw new TypeError(
      "Plugin contribution lookup requires an explicit project context (pass null for a sender with no project)"
    );
  }
  return forProject(items, pluginIdOf, projectId);
}

/** Plugin-owned panel kinds visible in a view of `projectId`. */
export function getPluginPanelKindsForProject(projectId: string | null | undefined) {
  return selectContributionsForProject(
    getPluginPanelKinds(),
    (config) => config.extensionId,
    projectId
  );
}

/** Plugin toolbar buttons visible in a view of `projectId`. */
export function getPluginToolbarButtonsForProject(projectId: string | null | undefined) {
  return selectContributionsForProject(
    getAllPluginToolbarButtonConfigs(),
    (config) => config.pluginId,
    projectId
  );
}

/** Plugin keybindings visible in a view of `projectId`. */
export function getPluginKeybindingsForProject(projectId: string | null | undefined) {
  return selectContributionsForProject(
    getPluginKeybindings(),
    (entry) => entry.pluginId,
    projectId
  );
}

/** Plugin context-menu items visible in a view of `projectId`. */
export function getPluginContextMenuItemsForProject(projectId: string | null | undefined) {
  return selectContributionsForProject(
    getPluginContextMenuItems(),
    (entry) => entry.pluginId,
    projectId
  );
}

interface PluginContributionBroadcasterDeps {
  /** Getter so the collaborator never holds a stale snapshot of the disposed flag. */
  isDisposed: () => boolean;
  /** Flattened plugin action snapshot — the pluginActions map stays on the facade. */
  listPluginActions: () => PluginActionDescriptor[];
  /** Resolves once startup load + activation has settled (or dispose ran). */
  initPromise: Promise<void>;
  /** Live per-instance runtime health, for the cold-start replay (#12277, #12278). */
  listPluginRuntimeStatuses: () => import("../../../shared/types/plugin.js").PluginRuntimeStatus[];
  /**
   * True while a plugin is being replaced in place (a dev rebuild reconcile).
   * The unload half of a replacement empties the registries for one turn, and a
   * `complete` snapshot taken there is a lie the renderer acts on destructively
   * — it sweeps persisted preferences for contributions that are about to come
   * straight back (#12277).
   */
  isReplacingPlugin: () => boolean;
}

/**
 * Owns the coalesced per-tick microtask broadcasts for actions, panel kinds,
 * toolbar buttons, keybindings, and context-menu items, plus the cold-start
 * {@link PluginContributionBroadcaster.pushSnapshotTo} replay. Reads the global
 * registry getters, narrows each snapshot to the receiving view's project (see
 * {@link setPluginContributionScope}), and emits via {@link broadcastToRenderer}
 * or {@link broadcastToProjectRenderers}.
 *
 * Agents and recipes are deliberately NOT scoped: both are deferred to a later
 * phase, neither snapshot item carries an owning plugin id, and scoping them
 * would mean per-contribution-point code for a point nothing can reach yet.
 */
export class PluginContributionBroadcaster {
  private readonly deps: PluginContributionBroadcasterDeps;

  /**
   * Coalesces multiple registry events fired in the same tick (e.g., when a
   * plugin contributes several panel kinds, or when `unregisterPluginPanelKinds`
   * removes N kinds in one call) into a single broadcast carrying the current
   * snapshot.
   */
  private panelKindsBroadcastPending = false;
  /**
   * Same coalescing rationale as {@link panelKindsBroadcastPending}: a plugin
   * contributing N toolbar buttons calls `registerToolbarButton` N times in
   * `loadPlugin()`, and `unregisterPluginToolbarButtons` removes them in one
   * call on unload — batch into a single snapshot broadcast per tick.
   */
  private toolbarButtonsBroadcastPending = false;
  /**
   * OR-accumulated across triggers coalesced into one tick: true if any was an
   * unload (uninstall). The registry at microtask-drain time always reflects
   * the current set, so a tick that included an unload is an authoritative
   * snapshot the renderer may safely sweep against; a tick of only loads is a
   * partial/growing snapshot (concurrent load + deferred init) and must not.
   */
  private toolbarButtonsBroadcastComplete = false;
  private keybindingsBroadcastPending = false;
  private keybindingsBroadcastComplete = false;
  /**
   * Same coalescing rationale as {@link toolbarButtonsBroadcastPending}.
   * Context-menu items are mutated only from `loadPlugin()` / `unloadPlugin()`,
   * so the two call sites invoke {@link scheduleContextMenuItemsBroadcast}
   * directly.
   */
  private contextMenuItemsBroadcastPending = false;
  /** Mirrors {@link toolbarButtonsBroadcastComplete} for context-menu items. */
  private contextMenuItemsBroadcastComplete = false;
  /**
   * Same coalescing rationale as {@link toolbarButtonsBroadcastPending}. Plugin
   * agents are mutated only from `loadPlugin()` / `unloadPlugin()`, so the two
   * call sites invoke {@link scheduleAgentsBroadcast} directly.
   */
  private agentsBroadcastPending = false;
  /** Mirrors {@link toolbarButtonsBroadcastComplete} for plugin agents. */
  private agentsBroadcastComplete = false;
  /**
   * Same coalescing rationale as {@link toolbarButtonsBroadcastPending}. Plugin
   * recipes are mutated only from `loadPlugin()` / `unloadPlugin()`.
   */
  private recipesBroadcastPending = false;
  /** Mirrors {@link toolbarButtonsBroadcastComplete} for plugin recipes. */
  private recipesBroadcastComplete = false;

  constructor(deps: PluginContributionBroadcasterDeps) {
    this.deps = deps;
  }

  /**
   * Emit one contribution snapshot per audience.
   *
   * With no project-scoped plugin loaded this is byte-for-byte the single
   * `broadcastToRenderer` call it has always been — same channel, same payload,
   * same one-shot ordering. Once a project-local plugin exists the snapshot
   * stops being one value: each project's views get `global ∪ that project`,
   * and every other app webContents gets the global slice alone. Renderer
   * stores replace their state wholesale from this payload, so an audience must
   * receive its merged snapshot in ONE message — never a global message
   * followed by a project one.
   */
  private emitScoped(name: string, buildPayload: (projectId: string | null) => unknown): void {
    if (!hasScopedOrHiddenContributions()) {
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, { name, payload: buildPayload(null) });
      return;
    }
    const views = getRegisteredProjectViews();
    if (views.length === 0) {
      // No project view is registered at all (startup, or a window that does
      // not route through ProjectViewManager). Mirrors the same widening in
      // `broadcastToProjectRenderers`.
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, { name, payload: buildPayload(null) });
      return;
    }
    const projectViewIds = new Set<number>();
    const sentProjects = new Set<string>();
    for (const { webContents, projectId } of views) {
      projectViewIds.add(webContents.id);
      if (sentProjects.has(projectId)) continue;
      sentProjects.add(projectId);
      broadcastToProjectRenderers(projectId, CHANNELS.EVENTS_PUSH, {
        name,
        payload: buildPayload(projectId),
      });
    }
    const globalPayload = buildPayload(null);
    for (const wc of getAllAppWebContents()) {
      if (projectViewIds.has(wc.id)) continue;
      if (wc.isDestroyed()) continue;
      try {
        wc.send(CHANNELS.EVENTS_PUSH, { name, payload: globalPayload });
      } catch {
        // Silently ignore send failures during window initialization/disposal.
      }
    }
  }

  /**
   * Re-emit every scoped contribution channel because the audience changed
   * rather than the registries did.
   *
   * A per-project visibility decision moves a plugin's contributions in or out
   * of one project's snapshot without any registry mutation, so nothing in the
   * ordinary load/unload path fires. Without this the switch would take effect
   * only on the next unrelated plugin event or the next cold view restore.
   *
   * Every payload that carries the flag is marked COMPLETE. This is the one
   * case where a re-send has to be authoritative: the registries still hold the
   * hidden plugin's contributions, so an incomplete snapshot would merely be
   * merged into what the renderer already has and the newly hidden buttons,
   * keybindings and menu items would stay exactly where they were. The toggle
   * would flip, persist, filter every future broadcast — and change nothing on
   * screen until the next unrelated plugin event swept them.
   */
  broadcastVisibilityChanged(): void {
    if (this.deps.isDisposed()) return;
    this.broadcastPluginActions();
    this.schedulePanelKindsBroadcast();
    this.scheduleToolbarButtonsBroadcast(true);
    this.scheduleKeybindingsBroadcast(true);
    this.scheduleContextMenuItemsBroadcast(true);
  }

  /**
   * Re-publish any authoritative snapshot that was held back while a plugin was
   * being replaced. Called once the replacement completes; a no-op when nothing
   * was suppressed.
   */
  flushDeferredCompleteSnapshots(): void {
    if (this.deps.isDisposed() || this.deps.isReplacingPlugin()) return;
    if (this.toolbarButtonsBroadcastComplete) this.scheduleToolbarButtonsBroadcast(true);
    if (this.keybindingsBroadcastComplete) this.scheduleKeybindingsBroadcast(true);
    if (this.contextMenuItemsBroadcastComplete) this.scheduleContextMenuItemsBroadcast(true);
    if (this.agentsBroadcastComplete) this.scheduleAgentsBroadcast(true);
    if (this.recipesBroadcastComplete) this.scheduleRecipesBroadcast(true);
  }

  broadcastProvenanceChanged(): void {
    if (this.deps.isDisposed()) return;
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "plugin:provenance-changed",
      payload: {},
    });
  }

  broadcastPluginActions(): void {
    this.emitScoped("plugin:actions-changed", (projectId) => ({
      actions: forProject(this.deps.listPluginActions(), (a) => a.pluginId, projectId),
    }));
  }

  /**
   * Coalesce multiple registry mutations in the same microtask into a single
   * broadcast. `unregisterPluginPanelKinds` fires the unregister listener once
   * per removed kind; without this batching a plugin contributing N panels
   * would trigger N broadcasts on unload, each carrying the same shrinking
   * snapshot.
   */
  schedulePanelKindsBroadcast(): void {
    if (this.deps.isDisposed()) return;
    if (this.panelKindsBroadcastPending) return;
    this.panelKindsBroadcastPending = true;
    queueMicrotask(() => {
      this.panelKindsBroadcastPending = false;
      // Disposal between scheduling and the microtask draining must not leak
      // a phantom broadcast — particularly important for test isolation where
      // a service from one test could otherwise emit into the next.
      if (this.deps.isDisposed()) return;
      this.broadcastPluginPanelKinds();
    });
  }

  private broadcastPluginPanelKinds(): void {
    this.emitScoped("plugin:panel-kinds-changed", (projectId) => ({
      kinds: forProject(getPluginPanelKinds(), (c) => c.extensionId, projectId),
    }));
  }

  /**
   * Coalesce toolbar-button registry mutations the same way panel kinds are
   * batched (see {@link schedulePanelKindsBroadcast}). Toolbar buttons are only
   * ever mutated from `loadPlugin()` / `unloadPlugin()`, so the two call sites
   * invoke this directly rather than via registry event listeners.
   */
  scheduleToolbarButtonsBroadcast(complete: boolean): void {
    if (this.deps.isDisposed()) return;
    if (complete) this.toolbarButtonsBroadcastComplete = true;
    if (this.toolbarButtonsBroadcastPending) return;
    this.toolbarButtonsBroadcastPending = true;
    queueMicrotask(() => {
      this.toolbarButtonsBroadcastPending = false;
      const complete = this.toolbarButtonsBroadcastComplete && !this.deps.isReplacingPlugin();
      // Cleared only when it was actually published: a `complete` suppressed
      // mid-replacement is still owed, and dropping it here would leave the
      // renderer's stale entries un-swept until some later authoritative event.
      if (complete) this.toolbarButtonsBroadcastComplete = false;
      if (this.deps.isDisposed()) return;
      this.broadcastPluginToolbarButtons(complete);
    });
  }

  private broadcastPluginToolbarButtons(complete: boolean): void {
    this.emitScoped("plugin:toolbar-buttons-changed", (projectId) => ({
      buttons: forProject(getAllPluginToolbarButtonConfigs(), (c) => c.pluginId, projectId),
      complete,
    }));
  }

  scheduleKeybindingsBroadcast(complete: boolean): void {
    if (this.deps.isDisposed()) return;
    if (complete) this.keybindingsBroadcastComplete = true;
    if (this.keybindingsBroadcastPending) return;
    this.keybindingsBroadcastPending = true;
    queueMicrotask(() => {
      const isComplete = this.keybindingsBroadcastComplete && !this.deps.isReplacingPlugin();
      this.keybindingsBroadcastPending = false;
      if (isComplete) this.keybindingsBroadcastComplete = false;
      if (this.deps.isDisposed()) return;
      this.emitScoped("plugin:keybindings-changed", (projectId) => ({
        keybindings: forProject(getPluginKeybindings(), (e) => e.pluginId, projectId),
        complete: isComplete,
      }));
    });
  }

  /**
   * Same shape as {@link scheduleToolbarButtonsBroadcast}; see that method for
   * the coalescing and `complete`-OR-accumulation rationale.
   */
  scheduleContextMenuItemsBroadcast(complete: boolean): void {
    if (this.deps.isDisposed()) return;
    if (complete) this.contextMenuItemsBroadcastComplete = true;
    if (this.contextMenuItemsBroadcastPending) return;
    this.contextMenuItemsBroadcastPending = true;
    queueMicrotask(() => {
      this.contextMenuItemsBroadcastPending = false;
      const drained = this.contextMenuItemsBroadcastComplete && !this.deps.isReplacingPlugin();
      if (drained) this.contextMenuItemsBroadcastComplete = false;
      if (this.deps.isDisposed()) return;
      this.broadcastPluginContextMenuItems(drained);
    });
  }

  private broadcastPluginContextMenuItems(complete: boolean): void {
    this.emitScoped("plugin:context-menu-items-changed", (projectId) => ({
      items: forProject(getPluginContextMenuItems(), (e) => e.pluginId, projectId),
      complete,
    }));
  }

  /**
   * Same shape as {@link scheduleToolbarButtonsBroadcast}; see that method for
   * the coalescing and `complete`-OR-accumulation rationale. Plugin agents are
   * mutated only from `loadPlugin()` / `unloadPlugin()`.
   */
  scheduleAgentsBroadcast(complete: boolean): void {
    if (this.deps.isDisposed()) return;
    if (complete) this.agentsBroadcastComplete = true;
    if (this.agentsBroadcastPending) return;
    this.agentsBroadcastPending = true;
    queueMicrotask(() => {
      this.agentsBroadcastPending = false;
      const drained = this.agentsBroadcastComplete && !this.deps.isReplacingPlugin();
      if (drained) this.agentsBroadcastComplete = false;
      if (this.deps.isDisposed()) return;
      this.broadcastPluginAgents(drained);
    });
  }

  private broadcastPluginAgents(complete: boolean): void {
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "plugin:agents-changed",
      payload: { agents: getPluginAgentRegistry(), complete },
    });
  }

  /**
   * Same shape as {@link scheduleAgentsBroadcast}. Plugin recipes are mutated
   * from `loadPlugin()` / `unloadPlugin()` and after a metadata write, all of
   * which carry the full snapshot (#11860).
   */
  scheduleRecipesBroadcast(complete: boolean): void {
    if (this.deps.isDisposed()) return;
    if (complete) this.recipesBroadcastComplete = true;
    if (this.recipesBroadcastPending) return;
    this.recipesBroadcastPending = true;
    queueMicrotask(() => {
      this.recipesBroadcastPending = false;
      const drained = this.recipesBroadcastComplete && !this.deps.isReplacingPlugin();
      if (drained) this.recipesBroadcastComplete = false;
      if (this.deps.isDisposed()) return;
      this.broadcastPluginRecipes(drained);
    });
  }

  private broadcastPluginRecipes(complete: boolean): void {
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "plugin:recipes-changed",
      payload: { recipes: getPluginRecipes(), complete },
    });
  }

  /**
   * Replay the current actions / panel-kinds / toolbar-button snapshots to a
   * single target webContents. Used by the cold-start view-ready hook so a
   * freshly-restored WebContentsView (post-LRU eviction or first cold load on
   * project switch) gets a complete plugin state on the same channels its
   * persistent push listeners already consume — no renderer-side changes
   * needed. Awaits the init gate so the snapshot is post-activation, not the
   * empty pre-init view (#9285).
   *
   * Project-aware: the replay carries `global ∪ the target view's project` and
   * nothing else. This is the leak that is invisible until a view is recreated
   * after LRU eviction and suddenly shows another project's panels, so
   * `projectId` is resolved from the target's own registration rather than from
   * the active project. An explicit `projectId` overrides that lookup; `null`
   * means "this view has no project" and yields the global contributions alone,
   * never everything.
   *
   * Toolbar buttons use `complete: false` so the renderer does not stale-prune
   * against this snapshot — replay is authoritative for the target view but
   * conceptually identical to a coalesced "load tick" broadcast, not an
   * unload sweep.
   */
  async pushSnapshotTo(
    webContents: Electron.WebContents,
    projectId?: string | null
  ): Promise<void> {
    await this.deps.initPromise;
    if (this.deps.isDisposed()) return;
    if (webContents.isDestroyed()) return;
    // `undefined` means "the caller did not resolve one" — look it up from the
    // target's own project-view registration. Never the active project: a
    // cold-restored background view is routinely not the focused one.
    const target = projectId === undefined ? getProjectForWebContents(webContents.id) : projectId;
    // Mirror `broadcastToRenderer`'s defensive send pattern (electron/ipc/utils.ts:337-352):
    // the wc may be destroyed between the isDestroyed() check above and any
    // individual send (TOCTOU), and a throw on the first send would otherwise
    // leave the next two channels un-sent — silently degrading the
    // cold-restored renderer to its pull-on-mount path for those two channels
    // only. Each send is independently guarded.
    const events: Array<{ name: string; payload: unknown }> = [
      {
        name: "plugin:actions-changed",
        payload: {
          actions: forProject(this.deps.listPluginActions(), (a) => a.pluginId, target),
        },
      },
      {
        name: "plugin:panel-kinds-changed",
        payload: { kinds: forProject(getPluginPanelKinds(), (c) => c.extensionId, target) },
      },
      {
        name: "plugin:toolbar-buttons-changed",
        payload: {
          buttons: forProject(getAllPluginToolbarButtonConfigs(), (c) => c.pluginId, target),
          complete: false,
        },
      },
      {
        name: "plugin:keybindings-changed",
        payload: {
          keybindings: forProject(getPluginKeybindings(), (e) => e.pluginId, target),
          // Authoritative only when the registries are whole. A view attaching
          // mid-replacement would otherwise be handed a snapshot missing the
          // plugin being rebuilt and sweep its preferences against it.
          complete: !this.deps.isReplacingPlugin(),
        },
      },
      {
        name: "plugin:context-menu-items-changed",
        payload: {
          items: forProject(getPluginContextMenuItems(), (e) => e.pluginId, target),
          complete: false,
        },
      },
      {
        name: "plugin:agents-changed",
        payload: { agents: getPluginAgentRegistry(), complete: false },
      },
      {
        name: "plugin:recipes-changed",
        payload: { recipes: getPluginRecipes(), complete: false },
      },
      // Not project-scoped: the payload is health metadata keyed by instance id,
      // and a view with no panel on that instance simply renders nothing for it.
      // A view that missed the live event has no other way to learn which
      // generation is running, or that its backend already died.
      ...this.deps.listPluginRuntimeStatuses().map((status) => ({
        name: "plugin:runtime-status-changed",
        payload: { pluginId: status.pluginId, status },
      })),
    ];
    for (const event of events) {
      try {
        webContents.send(CHANNELS.EVENTS_PUSH, event);
      } catch {
        // Silently ignore send failures during window initialization/disposal.
      }
    }
  }
}
