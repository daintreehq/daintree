import { broadcastToRenderer } from "../../ipc/utils.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getPluginPanelKinds } from "../../../shared/config/panelKindRegistry.js";
import { getAllPluginToolbarButtonConfigs } from "../../../shared/config/toolbarButtonRegistry.js";
import { getPluginKeybindings } from "../pluginKeybindingRegistry.js";
import { getPluginContextMenuItems } from "../pluginContextMenuRegistry.js";
import { getPluginAgentRegistry } from "../../../shared/config/pluginAgentRegistry.js";
import type { PluginActionDescriptor } from "../../../shared/types/plugin.js";

interface PluginContributionBroadcasterDeps {
  /** Getter so the collaborator never holds a stale snapshot of the disposed flag. */
  isDisposed: () => boolean;
  /** Flattened plugin action snapshot — the pluginActions map stays on the facade. */
  listPluginActions: () => PluginActionDescriptor[];
  /** Resolves once startup load + activation has settled (or dispose ran). */
  initPromise: Promise<void>;
}

/**
 * Owns the coalesced per-tick microtask broadcasts for actions, panel kinds,
 * toolbar buttons, keybindings, and context-menu items, plus the cold-start
 * {@link pushSnapshotTo} replay. Reads only the global registry getters and
 * emits via {@link broadcastToRenderer}.
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

  constructor(deps: PluginContributionBroadcasterDeps) {
    this.deps = deps;
  }

  broadcastProvenanceChanged(): void {
    if (this.deps.isDisposed()) return;
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "plugin:provenance-changed",
      payload: {},
    });
  }

  broadcastPluginActions(): void {
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "plugin:actions-changed",
      payload: { actions: this.deps.listPluginActions() },
    });
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
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "plugin:panel-kinds-changed",
      payload: { kinds: getPluginPanelKinds() },
    });
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
      const complete = this.toolbarButtonsBroadcastComplete;
      this.toolbarButtonsBroadcastComplete = false;
      if (this.deps.isDisposed()) return;
      this.broadcastPluginToolbarButtons(complete);
    });
  }

  private broadcastPluginToolbarButtons(complete: boolean): void {
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "plugin:toolbar-buttons-changed",
      payload: { buttons: getAllPluginToolbarButtonConfigs(), complete },
    });
  }

  scheduleKeybindingsBroadcast(complete: boolean): void {
    if (this.deps.isDisposed()) return;
    if (complete) this.keybindingsBroadcastComplete = true;
    if (this.keybindingsBroadcastPending) return;
    this.keybindingsBroadcastPending = true;
    queueMicrotask(() => {
      const isComplete = this.keybindingsBroadcastComplete;
      this.keybindingsBroadcastPending = false;
      this.keybindingsBroadcastComplete = false;
      if (this.deps.isDisposed()) return;
      broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
        name: "plugin:keybindings-changed",
        payload: { keybindings: getPluginKeybindings(), complete: isComplete },
      });
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
      const drained = this.contextMenuItemsBroadcastComplete;
      this.contextMenuItemsBroadcastComplete = false;
      if (this.deps.isDisposed()) return;
      this.broadcastPluginContextMenuItems(drained);
    });
  }

  private broadcastPluginContextMenuItems(complete: boolean): void {
    broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
      name: "plugin:context-menu-items-changed",
      payload: { items: getPluginContextMenuItems(), complete },
    });
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
      const drained = this.agentsBroadcastComplete;
      this.agentsBroadcastComplete = false;
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
   * Replay the current actions / panel-kinds / toolbar-button snapshots to a
   * single target webContents. Used by the cold-start view-ready hook so a
   * freshly-restored WebContentsView (post-LRU eviction or first cold load on
   * project switch) gets a complete plugin state on the same channels its
   * persistent push listeners already consume — no renderer-side changes
   * needed. Awaits the init gate so the snapshot is post-activation, not the
   * empty pre-init view (#9285).
   *
   * Toolbar buttons use `complete: false` so the renderer does not stale-prune
   * against this snapshot — replay is authoritative for the target view but
   * conceptually identical to a coalesced "load tick" broadcast, not an
   * unload sweep.
   */
  async pushSnapshotTo(webContents: Electron.WebContents): Promise<void> {
    await this.deps.initPromise;
    if (this.deps.isDisposed()) return;
    if (webContents.isDestroyed()) return;
    // Mirror `broadcastToRenderer`'s defensive send pattern (electron/ipc/utils.ts:337-352):
    // the wc may be destroyed between the isDestroyed() check above and any
    // individual send (TOCTOU), and a throw on the first send would otherwise
    // leave the next two channels un-sent — silently degrading the
    // cold-restored renderer to its pull-on-mount path for those two channels
    // only. Each send is independently guarded.
    const events: Array<{ name: string; payload: unknown }> = [
      { name: "plugin:actions-changed", payload: { actions: this.deps.listPluginActions() } },
      { name: "plugin:panel-kinds-changed", payload: { kinds: getPluginPanelKinds() } },
      {
        name: "plugin:toolbar-buttons-changed",
        payload: { buttons: getAllPluginToolbarButtonConfigs(), complete: false },
      },
      {
        name: "plugin:keybindings-changed",
        payload: { keybindings: getPluginKeybindings(), complete: true },
      },
      {
        name: "plugin:context-menu-items-changed",
        payload: { items: getPluginContextMenuItems(), complete: false },
      },
      {
        name: "plugin:agents-changed",
        payload: { agents: getPluginAgentRegistry(), complete: false },
      },
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
