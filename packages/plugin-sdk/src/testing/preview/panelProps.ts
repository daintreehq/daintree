import type {
  PanelViewProps,
  PluginPanelToolbarItemState,
  PluginSettingsViewContext,
} from "../../../../../shared/types/plugin.js";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "../../../../../shared/types/plugin.js";
import {
  applyExtensionStatePatch,
  type ExtensionStateRejection,
} from "../../../../../shared/utils/extensionState.js";
import { decodePanelExtensionState } from "../../../../../shared/utils/panelExtensionState.js";
import {
  normalizePanelMenuItems,
  type PublishedPanelMenuItem,
} from "../../../../../shared/utils/pluginPanelMenuItems.js";

/**
 * Names the plugin a style root belongs to. Mirrors the host's own stamp
 * (`src/services/plugin/pluginStyleOwner.ts`), so a portal the view spreads
 * `styleRootAttributes` onto is marked exactly as it is in Daintree.
 */
export const PLUGIN_STYLE_OWNER_ATTRIBUTE = "data-daintree-plugin-owner";

export interface PreviewPanelPropsOptions {
  panelId?: string;
  /** The plugin's runtime id — its manifest `name` for an installed plugin. */
  pluginId?: string;
  /** The bag on the panel record, which the view mounts with as `initialArgs`. */
  initialArgs?: Record<string, unknown>;
  /**
   * The `stateVersion` the panel kind declares. Every accepted `persistState`
   * write is stamped with it, as the host stamps a registered kind's writes.
   */
  stateVersion?: number;
  /**
   * The version the record's bag was written at. Defaults to
   * {@link stateVersion} when there is a bag. Above `stateVersion`, the host
   * refuses the bag rather than mount the view on it, and so does the preview.
   */
  initialStateVersion?: number;
  worktreeId?: string;
  runningActions?: readonly string[];
  settingsContext?: PluginSettingsViewContext;
  /**
   * Leave out the optional host callbacks (`persistState`, `requestReload`,
   * `setHasUnsavedChanges`, `setToolbarItemState`, `setMenuItems`), as on a
   * host surface that offers none of them.
   */
  withoutHostCallbacks?: boolean;
}

/** One `persistState` call and what the shared rules made of it. */
export type PersistStateRecord =
  | { patch: Record<string, unknown>; accepted: true }
  | { patch: Record<string, unknown>; accepted: false; reason: ExtensionStateRejection };

/** Hooks the mount wires in; a controller on its own only records. */
export interface PreviewPanelControllerHooks {
  /** A live attempt asked to be reloaded. */
  onReloadRequested?: () => void;
}

export interface PreviewPanelController {
  readonly panelId: string;
  readonly pluginId: string;
  /** What the host marks the view's style root with, and hands the view to spread on portals. */
  readonly styleRootAttributes: Readonly<Record<string, string>>;
  /**
   * Props for a new view attempt, read from the panel record as it stands
   * now. Throws when the host would refuse to mount the view at all — a bag
   * written at a newer version than the kind declares.
   */
  props(): PanelViewProps;
  /** The bag the panel record holds now — what the next attempt reads as `initialArgs`. */
  readonly persistedState: Record<string, unknown> | undefined;
  /** The version the panel record holds now. */
  readonly persistedStateVersion: number | undefined;
  readonly persistCalls: readonly PersistStateRecord[];
  /** The panel's menu entries as the host accepted them, or `null`. */
  readonly menuItems: readonly PublishedPanelMenuItem[] | null;
  /** Why each menu list the host would ignore whole was refused. */
  readonly rejectedMenuItems: readonly string[];
  /** Toolbar button state by `actionId`, as last set. */
  readonly toolbarItems: ReadonlyMap<string, PluginPanelToolbarItemState>;
  readonly hasUnsavedChanges: boolean;
  /** How many times a live attempt asked to be reloaded. */
  readonly reloadRequests: number;
  /**
   * Clear what a reload clears: the panel's menu entries and toolbar state.
   * A temporary remount keeps them, since they belong to the panel.
   */
  clearViewState(): void;
  /** Abort every attempt but the current one. */
  retirePreviousAttempts(): void;
  /** Abort every attempt's `disposeSignal`, as unmounting the view does. */
  disposeAttempt(): void;
  /** Abort `panelRemovedSignal`, as permanently closing the panel does. */
  removePanel(): void;
}

/**
 * Build the `PanelViewProps` a plugin view receives, backed by a mock panel
 * record. `persistState` runs the host's own rules (`shared/utils/extensionState`):
 * the same merge, serializability check, 64KB cap and version stamping; each
 * attempt reads the record through the host's own version decoder.
 */
export function createPreviewPanelController(
  options: PreviewPanelPropsOptions = {},
  hooks: PreviewPanelControllerHooks = {}
): PreviewPanelController {
  const panelId = options.panelId ?? "preview-panel";
  const pluginId = options.pluginId ?? "preview.plugin";
  const panelRemoved = new AbortController();
  const styleRootAttributes = Object.freeze({
    [PLUGIN_STYLE_ROOT_ATTRIBUTE]: "",
    [PLUGIN_STYLE_OWNER_ATTRIBUTE]: pluginId,
  });

  let persistedState = options.initialArgs;
  // A record with no bag carries no version, as a freshly spawned panel does.
  let persistedStateVersion =
    persistedState === undefined
      ? options.initialStateVersion
      : (options.initialStateVersion ?? options.stateVersion);
  const persistCalls: PersistStateRecord[] = [];
  let menuItems: readonly PublishedPanelMenuItem[] | null = null;
  const rejectedMenuItems: string[] = [];
  const toolbarItems = new Map<string, PluginPanelToolbarItemState>();
  let hasUnsavedChanges = false;
  let reloadRequests = 0;
  let attempt: AbortController | null = null;
  /** Attempts whose signal has not been aborted yet, current included. */
  const openAttempts = new Set<AbortController>();

  function persistState(patch: Record<string, unknown>): boolean {
    const result = applyExtensionStatePatch(persistedState, patch, {
      current: persistedStateVersion,
      next: options.stateVersion,
    });
    if (!result.ok) {
      persistCalls.push({ patch, accepted: false, reason: result.reason });
      return false;
    }
    persistCalls.push({ patch, accepted: true });
    if (result.commit.kind === "replace") persistedState = result.commit.state;
    if (result.commit.kind !== "unchanged") persistedStateVersion = result.commit.version;
    return true;
  }

  return {
    panelId,
    pluginId,
    styleRootAttributes,
    props() {
      const decoded = decodePanelExtensionState({
        state: persistedState,
        persistedVersion: persistedStateVersion,
        declaredVersion: options.stateVersion,
      });
      if (!decoded.ok) {
        throw new Error(
          `the panel's state was written at version ${decoded.persistedVersion}, newer than the ${decoded.declaredVersion} this kind declares, so the host refuses to mount it`
        );
      }
      // The outgoing attempt's setters go dead now; its signal is aborted by
      // whoever retires it, after its cleanups.
      const current = new AbortController();
      attempt = current;
      openAttempts.add(current);
      // Like the host's, these setters belong to the attempt that received
      // them: one held past its teardown does nothing.
      const live = () => attempt === current && !current.signal.aborted;
      hasUnsavedChanges = false;
      const callbacks = options.withoutHostCallbacks
        ? {}
        : {
            persistState,
            requestReload: () => {
              if (!live()) return;
              reloadRequests += 1;
              hooks.onReloadRequested?.();
            },
            setHasUnsavedChanges: (value: boolean) => {
              if (live()) hasUnsavedChanges = value;
            },
            setToolbarItemState: (actionId: string, state: PluginPanelToolbarItemState | null) => {
              if (!live()) return;
              if (state === null) toolbarItems.delete(actionId);
              else toolbarItems.set(actionId, structuredClone(state));
            },
            setMenuItems: (items: unknown) => {
              if (!live()) return;
              // The host's own vetting: a foreign, duplicate or oversized list
              // is ignored whole.
              const result = normalizePanelMenuItems(items, pluginId, pluginId);
              if (!result.ok) {
                rejectedMenuItems.push(result.error);
                return;
              }
              menuItems = result.items.length > 0 ? result.items : null;
            },
          };
      return {
        panelId,
        pluginId,
        disposeSignal: current.signal,
        panelRemovedSignal: panelRemoved.signal,
        // A snapshot, as the host hands it: the view's own writes do not reach
        // the mounted attempt.
        ...(decoded.state !== undefined ? { initialArgs: structuredClone(decoded.state) } : {}),
        stateVersion: decoded.version,
        ...(options.worktreeId !== undefined ? { worktreeId: options.worktreeId } : {}),
        ...(options.runningActions !== undefined ? { runningActions: options.runningActions } : {}),
        ...(options.settingsContext !== undefined
          ? { settingsContext: options.settingsContext }
          : {}),
        styleRootAttributes,
        ...callbacks,
      };
    },
    get persistedState() {
      return persistedState;
    },
    get persistedStateVersion() {
      return persistedStateVersion;
    },
    persistCalls,
    get menuItems() {
      return menuItems;
    },
    rejectedMenuItems,
    toolbarItems,
    get hasUnsavedChanges() {
      return hasUnsavedChanges;
    },
    get reloadRequests() {
      return reloadRequests;
    },
    clearViewState() {
      menuItems = null;
      toolbarItems.clear();
    },
    retirePreviousAttempts() {
      for (const open of openAttempts) {
        if (open === attempt) continue;
        open.abort();
        openAttempts.delete(open);
      }
    },
    disposeAttempt() {
      for (const open of openAttempts) open.abort();
      openAttempts.clear();
    },
    removePanel() {
      panelRemoved.abort();
    },
  };
}
