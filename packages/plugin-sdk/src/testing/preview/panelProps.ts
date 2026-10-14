import type {
  PanelMenuItemContribution,
  PanelViewProps,
  PluginPanelToolbarItemState,
  PluginSettingsViewContext,
} from "../../../../../shared/types/plugin.js";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "../../../../../shared/types/plugin.js";
import {
  applyExtensionStatePatch,
  type ExtensionStateRejection,
} from "../../../../../shared/utils/extensionState.js";

/**
 * Names the plugin a style root belongs to. Mirrors the host's own stamp
 * (`src/services/plugin/pluginStyleOwner.ts`), so a portal the view spreads
 * `styleRootAttributes` onto is marked exactly as it is in Daintree.
 */
export const PLUGIN_STYLE_OWNER_ATTRIBUTE = "data-daintree-plugin-owner";

export interface PreviewPanelPropsOptions {
  panelId?: string;
  pluginId?: string;
  /** The persisted bag the view mounts with, as `initialArgs`. */
  initialArgs?: Record<string, unknown>;
  /**
   * The `stateVersion` the panel kind declares. Every accepted `persistState`
   * write is stamped with it, as the host stamps a registered kind's writes.
   */
  stateVersion?: number;
  /** What `initialArgs` was written against. Defaults to {@link stateVersion}. */
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

export interface PreviewPanelController {
  readonly panelId: string;
  readonly pluginId: string;
  /** What the host marks the view's style root with, and hands the view to spread on portals. */
  readonly styleRootAttributes: Readonly<Record<string, string>>;
  /** Props for the next mount. Each call starts a fresh view attempt. */
  props(): PanelViewProps;
  /** The bag the panel record holds now — what the next mount reads as `initialArgs`. */
  readonly persistedState: Record<string, unknown> | undefined;
  /** The version the panel record holds now. */
  readonly persistedStateVersion: number | undefined;
  readonly persistCalls: readonly PersistStateRecord[];
  /** The latest `setMenuItems` list, or `null`. */
  readonly menuItems: readonly PanelMenuItemContribution[] | null;
  /** Toolbar button state by `actionId`, as last set. */
  readonly toolbarItems: ReadonlyMap<string, PluginPanelToolbarItemState>;
  readonly hasUnsavedChanges: boolean;
  /** How many times the view asked to be reloaded. */
  readonly reloadRequests: number;
  /**
   * Abort every attempt but the current one. Called once the next attempt has
   * mounted: React has run the outgoing view's cleanups by then, which is when
   * the host aborts its signal.
   */
  retirePreviousAttempts(): void;
  /** Abort every attempt's `disposeSignal`, as a final unmount does. */
  disposeAttempt(): void;
  /** Abort `panelRemovedSignal`, as permanently closing the panel does. */
  removePanel(): void;
}

/**
 * Build the `PanelViewProps` a plugin view receives, backed by a mock panel
 * record. `persistState` runs the host's own rules (`shared/utils/extensionState`):
 * the same merge, serializability check, 64KB cap and version stamping.
 */
export function createPreviewPanelController(
  options: PreviewPanelPropsOptions = {}
): PreviewPanelController {
  const panelId = options.panelId ?? "preview-panel";
  const pluginId = options.pluginId ?? "preview.plugin";
  const panelRemoved = new AbortController();
  const styleRootAttributes = Object.freeze({
    [PLUGIN_STYLE_ROOT_ATTRIBUTE]: "",
    [PLUGIN_STYLE_OWNER_ATTRIBUTE]: pluginId,
  });

  let persistedState = options.initialArgs;
  let persistedStateVersion = options.initialStateVersion ?? options.stateVersion;
  const persistCalls: PersistStateRecord[] = [];
  let menuItems: readonly PanelMenuItemContribution[] | null = null;
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
      // The outgoing attempt's setters go dead now; its signal aborts later,
      // after its cleanups (see `retirePreviousAttempts`).
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
              if (live()) reloadRequests += 1;
            },
            setHasUnsavedChanges: (value: boolean) => {
              if (live()) hasUnsavedChanges = value;
            },
            setToolbarItemState: (actionId: string, state: PluginPanelToolbarItemState | null) => {
              if (!live()) return;
              if (state === null) toolbarItems.delete(actionId);
              else toolbarItems.set(actionId, state);
            },
            setMenuItems: (items: readonly PanelMenuItemContribution[] | null) => {
              if (live()) menuItems = items && items.length > 0 ? items : null;
            },
          };
      return {
        panelId,
        pluginId,
        disposeSignal: current.signal,
        panelRemovedSignal: panelRemoved.signal,
        // A snapshot, as the host hands it: the view's own writes do not reach
        // the mounted attempt.
        ...(persistedState !== undefined ? { initialArgs: structuredClone(persistedState) } : {}),
        ...(persistedStateVersion !== undefined ? { stateVersion: persistedStateVersion } : {}),
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
    toolbarItems,
    get hasUnsavedChanges() {
      return hasUnsavedChanges;
    },
    get reloadRequests() {
      return reloadRequests;
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
