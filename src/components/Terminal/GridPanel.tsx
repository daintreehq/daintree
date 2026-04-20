import React, { useCallback, useMemo } from "react";
import { usePanelStore, type TerminalInstance } from "@/store";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { getPanelKindDefinition, type PanelComponentProps } from "@/registry";
import { ContentPanel, PluginMissingPanel, triggerPanelTransition } from "@/components/Panel";
import type { TabInfo } from "@/components/Panel/TabButton";
import { usePanelLifecycle } from "@/hooks/usePanelLifecycle";
import { usePanelHandlers } from "@/hooks/usePanelHandlers";
import { buildPanelProps } from "@/utils/panelProps";
import type { AgentState } from "@/types";

export interface GridPanelProps {
  terminal: TerminalInstance;
  isFocused: boolean;
  isMaximized?: boolean;
  gridPanelCount?: number;
  gridCols?: number;
  // Group-level ambient agent state (highest urgency across all tabs in a tab group)
  ambientAgentState?: AgentState;
  // Fleet scope render overrides: force input lock, surface broadcast overlay,
  // and let the caller disambiguate titles when the armed set spans multiple
  // worktrees. These are transient render-only flags; the store is untouched.
  isFleetScope?: boolean;
  titleOverride?: string;
  // Tab support
  tabs?: TabInfo[];
  groupId?: string;
  onTabClick?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabRename?: (tabId: string, newTitle: string) => void;
  onAddTab?: () => void;
  onTabReorder?: (newOrder: string[]) => void;
}

/**
 * Custom comparator for GridPanel's React.memo wrapper.
 *
 * Skips callback props (onTabClick, onTabClose, onTabRename, onAddTab,
 * onTabReorder) because ContentGrid passes inline closures that change every
 * render. Compares terminal fields used by buildPanelProps and ErrorBoundary
 * resetKeys — if buildPanelProps gains new terminal fields, update this list.
 */
export function gridPanelPropsAreEqual(prev: GridPanelProps, next: GridPanelProps): boolean {
  // Scalar props
  if (
    prev.isFocused !== next.isFocused ||
    prev.isMaximized !== next.isMaximized ||
    prev.gridPanelCount !== next.gridPanelCount ||
    prev.gridCols !== next.gridCols ||
    prev.ambientAgentState !== next.ambientAgentState ||
    prev.isFleetScope !== next.isFleetScope ||
    prev.titleOverride !== next.titleOverride ||
    prev.groupId !== next.groupId
  ) {
    return false;
  }

  // Terminal: fast-path reference check, then field-level comparison
  if (prev.terminal !== next.terminal) {
    const a = prev.terminal;
    const b = next.terminal;
    if (
      a.id !== b.id ||
      a.title !== b.title ||
      a.worktreeId !== b.worktreeId ||
      a.kind !== b.kind ||
      a.type !== b.type ||
      a.agentId !== b.agentId ||
      a.cwd !== b.cwd ||
      a.agentState !== b.agentState ||
      a.activityHeadline !== b.activityHeadline ||
      a.activityStatus !== b.activityStatus ||
      a.activityType !== b.activityType ||
      a.lastCommand !== b.lastCommand ||
      a.flowStatus !== b.flowStatus ||
      a.restartKey !== b.restartKey ||
      a.restartError !== b.restartError ||
      a.reconnectError !== b.reconnectError ||
      a.spawnError !== b.spawnError ||
      a.detectedProcessId !== b.detectedProcessId ||
      a.browserUrl !== b.browserUrl ||
      a.isRestarting !== b.isRestarting ||
      a.runtimeStatus !== b.runtimeStatus ||
      a.isInputLocked !== b.isInputLocked ||
      a.extensionState !== b.extensionState ||
      a.pluginId !== b.pluginId
    ) {
      return false;
    }
  }

  // Tabs: compare by length and element fields
  const prevTabs = prev.tabs;
  const nextTabs = next.tabs;
  if (prevTabs !== nextTabs) {
    if (prevTabs == null || nextTabs == null) return false;
    if (prevTabs.length !== nextTabs.length) return false;
    for (let i = 0; i < prevTabs.length; i++) {
      const pt = prevTabs[i]!;
      const nt = nextTabs[i]!;
      if (
        pt.id !== nt.id ||
        pt.title !== nt.title ||
        pt.type !== nt.type ||
        pt.agentId !== nt.agentId ||
        pt.detectedProcessId !== nt.detectedProcessId ||
        pt.kind !== nt.kind ||
        pt.agentState !== nt.agentState ||
        pt.isActive !== nt.isActive
      ) {
        return false;
      }
    }
  }

  return true;
}

export const GridPanel = React.memo(function GridPanel({
  terminal,
  isFocused,
  isMaximized = false,
  gridPanelCount,
  gridCols,
  ambientAgentState,
  isFleetScope = false,
  titleOverride,
  tabs,
  groupId,
  onTabClick,
  onTabClose,
  onTabRename,
  onAddTab,
  onTabReorder,
}: GridPanelProps) {
  const toggleMaximize = usePanelStore((state) => state.toggleMaximize);
  const getPanelGroup = usePanelStore((state) => state.getPanelGroup);
  const moveTerminalToDock = usePanelStore((state) => state.moveTerminalToDock);

  const lifecycle = usePanelLifecycle();
  const { handleFocus, handleClose, handleTitleChange } = usePanelHandlers({
    terminalId: terminal.id,
    lifecycle,
  });

  const handleToggleMaximize = useCallback(() => {
    toggleMaximize(terminal.id, gridCols, gridPanelCount, getPanelGroup);
  }, [toggleMaximize, terminal.id, gridCols, gridPanelCount, getPanelGroup]);

  const handleMinimize = useCallback(() => {
    const panelElement = document.querySelector(`[data-panel-id="${terminal.id}"]`);
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
          terminal.id,
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

    moveTerminalToDock(terminal.id);
  }, [moveTerminalToDock, terminal.id]);

  const kind = terminal.kind ?? "terminal";
  const definition = getPanelKindDefinition(kind);

  const panelProps: PanelComponentProps = useMemo(
    () =>
      buildPanelProps({
        terminal,
        isFocused,
        isTrashing: lifecycle.isTrashing,
        overrides: {
          location: "grid" as const,
          isMaximized,
          gridPanelCount,
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
          // Adding a new tab in scope would create a cross-worktree tab group,
          // which violates the tab-group invariant in shared/types/panel.ts.
          onAddTab: isFleetScope ? undefined : onAddTab,
          onTabReorder,
          ...(isFleetScope ? { isInputLocked: true, isFleetScope: true } : undefined),
          ...(titleOverride !== undefined ? { title: titleOverride } : undefined),
        },
      }),
    [
      terminal,
      isFocused,
      isMaximized,
      lifecycle.isTrashing,
      gridPanelCount,
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
      onAddTab,
      onTabReorder,
      isFleetScope,
      titleOverride,
    ]
  );

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
        onAddTab={onAddTab}
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
}, gridPanelPropsAreEqual);
