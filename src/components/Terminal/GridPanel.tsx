import React, { useCallback, useMemo, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store";
import type { PanelInstance } from "@shared/types/panel";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { canDuplicatePanelKind } from "@/services/terminal/panelDuplicationService";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  getPanelKindDefinitionsSnapshot,
  subscribeToPanelKindDefinitions,
  type PanelComponentProps,
} from "@/registry";
import { ContentPanel, PluginMissingPanel, triggerPanelTransition } from "@/components/Panel";
import type { TabInfo } from "@/components/Panel/TabButton";
import { usePanelHandlers } from "@/hooks/usePanelHandlers";
import { buildPanelProps } from "@/utils/panelProps";
import { getGridLayoutSnapshot } from "./gridLayoutSnapshot";
import type { AgentState } from "@/types";

export interface GridPanelProps {
  terminalId: string;
  isFocused: boolean;
  isMaximized?: boolean;
  isMultiPanelGrid?: boolean;
  // Group-level ambient agent state (highest urgency across all tabs in a tab group)
  ambientAgentState?: AgentState;
  // Fleet scope render overrides: force input lock, disable per-panel
  // maximize/minimize/add-tab, and let the caller disambiguate titles when
  // the armed set spans multiple worktrees. These are transient render-only
  // flags; the store is untouched. Title-bar selection chrome is derived
  // inside TerminalPane from `fleetArmingStore`, not from this prop.
  isFleetScope?: boolean;
  titleOverride?: string;
  // Tab support
  tabs?: TabInfo[];
  groupId?: string;
  onTabClick?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabRename?: (tabId: string, newTitle: string) => void;
  // No-arg add-tab callback. Used by GridTabGroup, which owns the active panel
  // and supplies its own handler. Single-panel call sites should prefer
  // `onAddTabForPanel` so the inline `(terminal) => ...` closure can be
  // composed inside GridPanel against the store-subscribed terminal — that
  // keeps the prop reference stable across parent re-renders.
  onAddTab?: () => void;
  // Panel-aware add-tab callback. Receives the subscribed terminal. Pass a
  // stable handler (e.g., `ctx.handleAddTabForPanel`) — GridPanel composes
  // the no-arg shape internally and skips it in fleet scope.
  onAddTabForPanel?: (terminal: PanelInstance) => void | Promise<void>;
  onTabReorder?: (newOrder: string[]) => void;
}

export const GridPanel = React.memo(function GridPanel({
  terminalId,
  isFocused,
  isMaximized = false,
  isMultiPanelGrid,
  ambientAgentState,
  isFleetScope = false,
  titleOverride,
  tabs,
  groupId,
  onTabClick,
  onTabClose,
  onTabRename,
  onAddTab,
  onAddTabForPanel,
  onTabReorder,
}: GridPanelProps) {
  // Subscribe to the terminal slice keyed by id. `useShallow` does per-field
  // identity comparison, so re-renders fire only when fields of THIS terminal
  // change — sibling panel mutations no longer cascade through the grid.
  const terminal = usePanelStore(useShallow((state) => state.panelsById[terminalId]));

  const toggleMaximize = usePanelStore((state) => state.toggleMaximize);
  const getPanelGroup = usePanelStore((state) => state.getPanelGroup);
  const moveTerminalToDock = usePanelStore((state) => state.moveTerminalToDock);

  const { handleFocus, handleClose, handleTitleChange } = usePanelHandlers({
    terminalId,
  });

  const handleToggleMaximize = useCallback(() => {
    const snapshot = getGridLayoutSnapshot();
    toggleMaximize(terminalId, snapshot.gridCols, snapshot.gridItemCount, getPanelGroup);
  }, [toggleMaximize, terminalId, getPanelGroup]);

  const handleMinimize = useCallback(() => {
    const panelElement = document.querySelector(`[data-panel-id="${terminalId}"]`);
    if (panelElement) {
      const sourceRect = panelElement.getBoundingClientRect();
      const dockElement = document.querySelector("[data-dock-density]");
      if (dockElement) {
        const dockRect = dockElement.getBoundingClientRect();
        const targetRect = {
          x: dockRect.x + dockRect.width / 2 - 50,
          y: dockRect.y + dockRect.height / 2 - 16,
          width: 100,
          height: 32,
        };
        triggerPanelTransition(
          terminalId,
          "minimize",
          {
            x: sourceRect.x,
            y: sourceRect.y,
            width: sourceRect.width,
            height: sourceRect.height,
          },
          targetRect
        );
      }
    }

    moveTerminalToDock(terminalId);
  }, [moveTerminalToDock, terminalId]);

  // Subscribe to definition registry mutations so a plugin re-registering its
  // panel kind hot-swaps the PluginMissingPanel placeholder without a reload.
  // The lookup MUST read this snapshot rather than calling
  // `getPanelKindDefinition(kind)` separately: React Compiler caches that call
  // keyed only on `kind`, so a definition registered after this fiber first
  // rendered would never be picked up (#11636).
  const definitions = useSyncExternalStore(
    subscribeToPanelKindDefinitions,
    getPanelKindDefinitionsSnapshot
  );

  // Compose the effective add-tab handler. Fleet scope disables it (would
  // create a cross-worktree tab group). For single-panel and two-pane callers
  // that supply `onAddTabForPanel`, we bind it to the subscribed terminal here
  // so the parent can pass a stable callback reference.
  const composedOnAddTab = useMemo<(() => void) | undefined>(() => {
    if (isFleetScope) return undefined;
    if (terminal && !canDuplicatePanelKind(terminal.kind)) return undefined;
    if (onAddTab) return onAddTab;
    if (onAddTabForPanel && terminal) {
      return () => {
        const narrowed = getNarrowPanel(usePanelStore.getState().panelsById, terminal.id);
        if (narrowed) void onAddTabForPanel(narrowed);
      };
    }
    return undefined;
  }, [isFleetScope, onAddTab, onAddTabForPanel, terminal]);

  const kind = terminal?.kind ?? "terminal";
  const definition = definitions[kind];

  const panelProps: PanelComponentProps | null = useMemo(() => {
    if (!terminal) return null;
    return buildPanelProps({
      terminal,
      isFocused,
      overrides: {
        location: "grid" as const,
        isMaximized,
        isMultiPanelGrid,
        ambientAgentState,
        onFocus: handleFocus,
        onClose: handleClose,
        // Fleet scope disables per-panel maximize — the armed grid is a single
        // read-only composite view; promoting one cell would drop the rest.
        onToggleMaximize: isFleetScope ? undefined : handleToggleMaximize,
        onTitleChange: handleTitleChange,
        onMinimize: isFleetScope ? undefined : handleMinimize,
        tabs,
        groupId,
        onTabClick,
        onTabClose,
        onTabRename,
        onAddTab: composedOnAddTab,
        onTabReorder,
        ...(isFleetScope ? { isInputLocked: true } : undefined),
        ...(titleOverride !== undefined ? { title: titleOverride } : undefined),
      },
    });
  }, [
    terminal,
    isFocused,
    isMaximized,
    isMultiPanelGrid,
    ambientAgentState,
    handleFocus,
    handleClose,
    handleToggleMaximize,
    handleTitleChange,
    handleMinimize,
    tabs,
    groupId,
    onTabClick,
    onTabClose,
    onTabRename,
    composedOnAddTab,
    onTabReorder,
    isFleetScope,
    titleOverride,
  ]);

  // Transient unmount race: the panel was removed from the store while this
  // cell is still in React's commit queue. Rendering null is correct — the
  // parent removes the grid cell on the same tick.
  if (!terminal || !panelProps) {
    return null;
  }

  if (!definition) {
    const isPluginOwned = Boolean(terminal.pluginId) || kind.includes(".");
    if (!isPluginOwned) {
      console.warn(`[GridPanel] No component registered for kind: ${kind}`);
    }
    return (
      <ContentPanel
        id={terminal.id}
        title={terminal.title}
        kind={kind}
        isFocused={isFocused}
        isMaximized={isMaximized}
        location="grid"
        ambientAgentState={ambientAgentState}
        onFocus={handleFocus}
        onClose={handleClose}
        onToggleMaximize={handleToggleMaximize}
        onTitleChange={handleTitleChange}
        onMinimize={handleMinimize}
        tabs={tabs}
        groupId={groupId}
        onTabClick={onTabClick}
        onTabClose={onTabClose}
        onTabRename={onTabRename}
        onAddTab={composedOnAddTab}
        onTabReorder={onTabReorder}
      >
        {isPluginOwned ? (
          <PluginMissingPanel
            kind={kind}
            pluginId={terminal.pluginId}
            onRemove={() => handleClose(true)}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center bg-surface-panel text-text-muted">
            <div className="text-center">
              <p className="text-sm font-medium">Unknown Panel Type</p>
              <p className="text-xs mt-1 text-daintree-text/50">Kind: {kind}</p>
              <p className="text-xs mt-2 text-daintree-text/40">
                No component registered for this panel kind
              </p>
            </div>
          </div>
        )}
      </ContentPanel>
    );
  }

  const PanelComponent = definition.component;
  const componentName = PanelComponent.displayName || PanelComponent.name || `Panel(${kind})`;

  return (
    <ErrorBoundary
      variant="component"
      componentName={componentName}
      resetKeys={[terminal.id, terminal.worktreeId].filter(
        (key): key is string => key !== undefined
      )}
      context={{ terminalId: terminal.id, worktreeId: terminal.worktreeId }}
    >
      <PanelComponent {...panelProps} />
    </ErrorBoundary>
  );
});
