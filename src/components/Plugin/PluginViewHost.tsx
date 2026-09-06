import { useCallback, useEffect, type ComponentType } from "react";
import type { PanelKindConfig } from "@shared/config/panelKindRegistry";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import type { TabInfo } from "@/components/Panel/TabButton";
import { makePluginViewContent } from "@/components/Plugin/PluginViewContent";
import { logWarn } from "@/utils/logger";
import {
  getPanelStoreSnapshot,
  persistPanelExtensionStateThroughAccessor,
} from "@/store/storeAccessors";
import {
  decodePanelExtensionState,
  panelExtensionStateVersionMessage,
} from "@shared/utils/panelExtensionState";

/**
 * Plugin panels are ordinary grid panels: `ContentPanel` owns their chrome and
 * their focus-registry entry, so the host's props mirror what every other
 * non-PTY pane declares (`FilePaneProps`) rather than the registry's untyped
 * `PanelComponentProps` bag — spreading `unknown`-valued tab props into
 * `ContentPanel` would not typecheck. `GridPanel` supplies every field here.
 */
export interface PluginViewHostProps extends BasePanelProps {
  extensionState?: Record<string, unknown>;
  /** Version `extensionState` was persisted at (#12280). */
  extensionStateVersion?: number;
  tabs?: TabInfo[];
  groupId?: string;
  onTabClick?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabRename?: (tabId: string, newTitle: string) => void;
  onAddTab?: () => void;
  onTabReorder?: (newOrder: string[]) => void;
}

/**
 * Build a per-kind renderer host that presents a plugin view as a grid/dock
 * panel. This is the *presentation adapter* only: it maps panel props onto
 * `ContentPanel` and delegates every plugin concern — activation, the lazy
 * `plugin://` import, the error boundary, and dispose-signal teardown — to
 * `PluginViewContent`, which carries no panel chrome of its own (#11240).
 *
 * One host instance is created per plugin panel kind during
 * `usePluginPanelKinds` reconciliation, which caches it per
 * `(kindId, componentPath)`. That cache is what keeps both this component and
 * the content component it creates stable across broadcast replays; see
 * `makePluginViewContent` for why the inner factory must not run during render.
 */
export function makePluginViewHost(config: PanelKindConfig): ComponentType<PluginViewHostProps> {
  const componentPath = config.componentPath;
  const pluginId = config.extensionId;
  const kindId = config.id;
  const displayName = config.name;
  const stateVersion = config.stateVersion;

  if (!componentPath || !pluginId) {
    // The else-branch of usePluginPanelKinds guards this, but a defensive
    // check here keeps the component contract self-checking — a future caller
    // that bypasses the hook gets an inline warn rather than a confusing
    // runtime error from `import('plugin://undefined')`.
    return function PluginViewHostMisconfigured() {
      return (
        <PluginViewLoadError
          pluginId={pluginId ?? "(unknown)"}
          displayName={displayName}
          message="Plugin view is misconfigured: missing componentPath or pluginId."
        />
      );
    };
  }

  // Created once per host, at factory-construction scope. Constructing it inside
  // `PluginViewHost` would produce a new component type per render, remounting
  // the plugin view and restarting its import every time a panel prop changed.
  // (`useMemo` with a stable dep array would survive ordinary rerenders, but it
  // ties the view's identity to a hook that remounts it whenever a dep changes;
  // the construction belongs outside the component entirely.)
  // Re-bound inside the guarded region so the narrowing survives into the
  // component closure below, where the misconfigured branch is already gone.
  const ownerPluginId: string = pluginId;

  const PluginViewContent = makePluginViewContent({
    id: kindId,
    name: displayName,
    componentPath,
    extensionId: pluginId,
  });

  function PluginViewHost({
    extensionState,
    extensionStateVersion,
    ...panelProps
  }: PluginViewHostProps) {
    const { onClose } = panelProps;
    // Refuse a bag written by a NEWER build of this plugin rather than hand the
    // view state it will misread and then overwrite (#12280). The record and
    // its `extensionState` are untouched by this — reinstalling the newer build
    // brings the user's state back intact — so the only thing withheld is the
    // view's chance to corrupt it.
    const decoded = decodePanelExtensionState({
      state: extensionState,
      persistedVersion: extensionStateVersion,
      declaredVersion: stateVersion,
    });
    // `ContentPanel`'s own close control already sits in the header; this hands
    // the same action to the diagnostics fallback so a crashed view offers the
    // way out where the failure is actually shown (#11301). Wrapped to drop
    // `ContentPanel`'s `force` argument — the fallback's button is the ordinary
    // recoverable close, never a forced one.
    const handleRequestClose = useCallback(() => onClose(), [onClose]);
    // The view's write path back into `extensionState`. Routed through the
    // cross-store accessor rather than the store itself: this component is a
    // leaf by design, and it never subscribes to what it writes — the value is
    // only ever read back on the NEXT mount, so persisting cannot re-render the
    // panel that just persisted.
    const panelId = panelProps.id;
    const persistState = useCallback(
      (patch: Record<string, unknown>): boolean =>
        persistPanelExtensionStateThroughAccessor(panelId, patch),
      [panelId]
    );
    // What recovery restores, read at the moment it starts rather than at mount
    // (#12278). The props above are a snapshot of the record as of THIS render,
    // and a view that persisted state after mounting has moved on from them —
    // restoring those on a restart would quietly undo the user's work. Read
    // through the accessor for the same reason `persistState` is: this
    // component is a leaf and must not subscribe to what it writes.
    //
    // Runs the same version guard as the mount path, so a bag written by a
    // newer build of the plugin is withheld on recovery exactly as it is on
    // open, rather than smuggled in through the back door.
    const readRecoveryState = useCallback(() => {
      const panel = getPanelStoreSnapshot()?.panelsById[panelId];
      if (!panel) return null;
      const decodedRecovery = decodePanelExtensionState({
        state: panel.extensionState,
        persistedVersion: panel.extensionStateVersion,
        declaredVersion: stateVersion,
      });
      if (!decodedRecovery.ok) return null;
      return { state: decodedRecovery.state, version: decodedRecovery.version };
    }, [panelId]);
    return (
      // ContentPanel owns click-to-focus, the focus-registry entry, and the pane
      // chrome, exactly as it does for every other non-PTY kind (#11228). It sits
      // outside the content's boundary and Suspense on purpose: a loading or
      // crashed view keeps its header, context menu, and close control, so the
      // panel is never stranded open. `kind` comes from the closure —
      // `buildPanelProps` doesn't supply one, and the closure value is
      // authoritative anyway.
      //
      // `chrome={undefined}` forces ContentPanel to derive the descriptor from
      // `kind`, matching FilePane/Browser/DevPreview (none of which forward one).
      // buildPanelProps precomputes a `chrome` and GridPanel spreads it in
      // untyped; forwarding it would pin a stale descriptor when a disabled
      // plugin's persisted panel re-enables (the panelProps memo doesn't depend
      // on the kind registry).
      <ContentPanel {...panelProps} kind={kindId} chrome={undefined}>
        {/* `extensionState` is how the panel store persists a view's spawn
            arguments; the content layer speaks the SDK's presentation-neutral
            `initialArgs` instead, so the mapping happens here at the seam. */}
        {decoded.ok ? (
          <PluginViewContent
            panelId={panelProps.id}
            initialArgs={decoded.state}
            stateVersion={decoded.version}
            persistState={persistState}
            readRecoveryState={readRecoveryState}
            onRequestClose={handleRequestClose}
            worktreeId={panelProps.worktreeId}
          />
        ) : (
          <PluginViewLoadError
            pluginId={ownerPluginId}
            displayName={displayName}
            message={panelExtensionStateVersionMessage(
              displayName,
              decoded.persistedVersion,
              decoded.declaredVersion
            )}
          />
        )}
      </ContentPanel>
    );
  }

  PluginViewHost.displayName = `PluginViewHost(${kindId})`;
  return PluginViewHost;
}

interface PluginViewLoadErrorProps {
  pluginId: string;
  displayName: string;
  message: string;
}

function PluginViewLoadError({ pluginId, displayName, message }: PluginViewLoadErrorProps) {
  useEffect(() => {
    logWarn("[PluginViewHost] view configuration error", { pluginId, displayName, message });
  }, [pluginId, displayName, message]);

  return (
    <div
      role="region"
      aria-label="Plugin view unavailable"
      className="flex flex-1 flex-col items-center justify-center gap-2 bg-surface-panel p-6 text-text-muted"
    >
      <p className="text-sm font-medium text-text-primary">{displayName} unavailable</p>
      <p className="max-w-sm text-center text-xs text-text-muted">{message}</p>
    </div>
  );
}
