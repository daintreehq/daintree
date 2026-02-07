import { useCallback, useMemo } from "react";
import { useTerminalStore, type TerminalInstance } from "@/store";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { getPanelComponent, type PanelComponentProps } from "@/registry";
import { ContentPanel, triggerPanelTransition } from "@/components/Panel";
import type { TabInfo } from "@/components/Panel/TabButton";
import { usePanelLifecycle } from "@/hooks/usePanelLifecycle";
import { usePanelHandlers } from "@/hooks/usePanelHandlers";
import { buildPanelProps } from "@/utils/panelProps";

export interface GridPanelProps {
  terminal: TerminalInstance;
  isFocused: boolean;
  isMaximized?: boolean;
  gridPanelCount?: number;
  gridCols?: number;
  // Tab support
  tabs?: TabInfo[];
  groupId?: string;
  onTabClick?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabRename?: (tabId: string, newTitle: string) => void;
  onAddTab?: () => void;
  onTabReorder?: (newOrder: string[]) => void;
}

export function GridPanel({
  terminal,
  isFocused,
  isMaximized = false,
  gridPanelCount,
  gridCols,
  tabs,
  groupId,
  onTabClick,
  onTabClose,
  onTabRename,
  onAddTab,
  onTabReorder,
}: GridPanelProps) {
  const toggleMaximize = useTerminalStore((state) => state.toggleMaximize);
  const getPanelGroup = useTerminalStore((state) => state.getPanelGroup);
  const moveTerminalToDock = useTerminalStore((state) => state.moveTerminalToDock);

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
  const registration = getPanelComponent(kind);

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
          onFocus: handleFocus,
          onClose: handleClose,
          onToggleMaximize: handleToggleMaximize,
          onTitleChange: handleTitleChange,
          onMinimize: handleMinimize,
          tabs,
          groupId,
          onTabClick,
          onTabClose,
          onTabRename,
          onAddTab,
          onTabReorder,
        },
      }),
    [
      terminal,
      isFocused,
      isMaximized,
      lifecycle.isTrashing,
      gridPanelCount,
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
    ]
  );

  if (!registration) {
    console.warn(`[GridPanel] No component registered for kind: ${kind}`);
    return (
      <ContentPanel
        id={terminal.id}
        title={terminal.title}
        kind={kind}
        isFocused={isFocused}
        isMaximized={isMaximized}
        location="grid"
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
        <div className="flex flex-1 items-center justify-center bg-canopy-bg-secondary text-canopy-text-muted">
          <div className="text-center">
            <p className="text-sm font-medium">Unknown Panel Type</p>
            <p className="text-xs mt-1 text-canopy-text/50">Kind: {kind}</p>
            <p className="text-xs mt-2 text-canopy-text/40">
              No component registered for this panel kind
            </p>
          </div>
        </div>
      </ContentPanel>
    );
  }

  const PanelComponent = registration.component;
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
}
