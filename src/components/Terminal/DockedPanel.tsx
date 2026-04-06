import { useCallback, useMemo } from "react";
import { usePanelStore, type TerminalInstance } from "@/store";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { getPanelKindDefinition, type PanelComponentProps } from "@/registry";
import { ContentPanel, triggerPanelTransition } from "@/components/Panel";
import { usePanelLifecycle } from "@/hooks/usePanelLifecycle";
import { usePanelHandlers } from "@/hooks/usePanelHandlers";
import { buildPanelProps } from "@/utils/panelProps";

export interface DockedPanelProps {
  terminal: TerminalInstance;
  onPopoverClose?: () => void;
  onAddTab?: () => void;
}

export function DockedPanel({ terminal, onPopoverClose, onAddTab }: DockedPanelProps) {
  const moveTerminalToGrid = usePanelStore((state) => state.moveTerminalToGrid);
  const closeDockTerminal = usePanelStore((state) => state.closeDockTerminal);

  const lifecycle = usePanelLifecycle();
  const { handleFocus, handleClose, handleTitleChange } = usePanelHandlers({
    terminalId: terminal.id,
    lifecycle,
    onAfterClose: onPopoverClose,
  });

  const handleRestore = useCallback(() => {
    const moveSucceeded = moveTerminalToGrid(terminal.id);
    if (!moveSucceeded) return;

    const dockElement = document.querySelector("[data-dock-density]");
    if (dockElement) {
      const dockRect = dockElement.getBoundingClientRect();
      const sourceRect = {
        x: dockRect.x + dockRect.width / 2 - 50,
        y: dockRect.y + dockRect.height / 2 - 16,
        width: 100,
        height: 32,
      };

      const gridElement = document.querySelector('[data-grid-container="true"]');
      if (gridElement) {
        const gridRect = gridElement.getBoundingClientRect();
        const targetRect = {
          x: gridRect.x + gridRect.width * 0.1,
          y: gridRect.y + gridRect.height * 0.1,
          width: gridRect.width * 0.8,
          height: gridRect.height * 0.8,
        };

        triggerPanelTransition(terminal.id, "restore", sourceRect, targetRect);
      }
    }

    onPopoverClose?.();
  }, [moveTerminalToGrid, terminal.id, onPopoverClose]);

  const handleMinimize = useCallback(() => {
    closeDockTerminal();
  }, [closeDockTerminal]);

  const focusedId = usePanelStore((state) => state.focusedId);
  const isFocused = focusedId === terminal.id;

  const kind = terminal.kind ?? "terminal";
  const definition = getPanelKindDefinition(kind);

  const panelProps: PanelComponentProps = useMemo(
    () =>
      buildPanelProps({
        terminal,
        isFocused,
        isTrashing: lifecycle.isTrashing,
        overrides: {
          location: "dock" as const,
          onFocus: handleFocus,
          onClose: handleClose,
          onRestore: handleRestore,
          onMinimize: handleMinimize,
          onTitleChange: handleTitleChange,
          onAddTab,
        },
      }),
    [
      terminal,
      isFocused,
      lifecycle.isTrashing,
      handleFocus,
      handleClose,
      handleRestore,
      handleMinimize,
      handleTitleChange,
      onAddTab,
    ]
  );

  if (!definition) {
    console.warn(`[DockedPanel] No component registered for kind: ${kind}`);
    return (
      <ContentPanel
        id={terminal.id}
        title={terminal.title}
        kind={kind}
        isFocused={isFocused}
        location="dock"
        onFocus={handleFocus}
        onClose={handleClose}
        onRestore={handleRestore}
        onMinimize={handleMinimize}
        onTitleChange={handleTitleChange}
      >
        <div className="flex flex-1 items-center justify-center bg-surface-panel text-text-muted">
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
}
