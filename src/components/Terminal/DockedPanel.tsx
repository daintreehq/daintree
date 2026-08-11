import { useCallback, useMemo, useSyncExternalStore } from "react";
import { usePanelStore } from "@/store";
import type { PanelInstance } from "@shared/types/panel";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  getPanelKindDefinitionsSnapshot,
  subscribeToPanelKindDefinitions,
  type PanelComponentProps,
} from "@/registry";
import { ContentPanel, PluginMissingPanel } from "@/components/Panel";
import { usePanelHandlers } from "@/hooks/usePanelHandlers";
import { buildPanelProps } from "@/utils/panelProps";
import { withViewTransition } from "@/lib/viewTransition";

export interface DockedPanelProps {
  terminal: PanelInstance;
  onPopoverClose?: () => void;
  onAddTab?: () => void;
  /** Show the inline "Move to grid" header control (single-panel dock only). */
  showRestoreControl?: boolean;
}

export function DockedPanel({
  terminal,
  onPopoverClose,
  onAddTab,
  showRestoreControl,
}: DockedPanelProps) {
  const moveTerminalToGrid = usePanelStore((state) => state.moveTerminalToGrid);
  const closeDockTerminal = usePanelStore((state) => state.closeDockTerminal);

  const { handleFocus, handleClose, handleTitleChange } = usePanelHandlers({
    terminalId: terminal.id,
    onAfterClose: onPopoverClose,
    surface: "dock",
  });

  const handleRestore = useCallback(() => {
    const gridElement = document.querySelector('[data-grid-container="true"]');
    // Move and close inside the transition callback so both land in the
    // after-snapshot, and only close when the move actually succeeded (it can
    // no-op for an already-gridded/missing panel) — matching the prior guard.
    withViewTransition(() => {
      if (moveTerminalToGrid(terminal.id)) onPopoverClose?.();
    }, gridElement);
  }, [moveTerminalToGrid, terminal.id, onPopoverClose]);

  const handleMinimize = useCallback(() => {
    closeDockTerminal(terminal.id);
  }, [closeDockTerminal, terminal.id]);

  const focusedId = usePanelStore((state) => state.focusedId);
  const isFocused = focusedId === terminal.id;

  const kind = terminal.kind ?? "terminal";
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
  const definition = definitions[kind];

  const panelProps: PanelComponentProps = useMemo(
    () =>
      buildPanelProps({
        terminal,
        isFocused,
        overrides: {
          location: "dock" as const,
          onFocus: handleFocus,
          onClose: handleClose,
          onRestore: handleRestore,
          onMinimize: handleMinimize,
          onTitleChange: handleTitleChange,
          onAddTab,
          showRestoreControl,
        },
      }),
    [
      terminal,
      isFocused,
      handleFocus,
      handleClose,
      handleRestore,
      handleMinimize,
      handleTitleChange,
      onAddTab,
      showRestoreControl,
    ]
  );

  if (!definition) {
    const isPluginOwned = Boolean(terminal.pluginId) || kind.includes(".");
    if (!isPluginOwned) {
      console.warn(`[DockedPanel] No component registered for kind: ${kind}`);
    }
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
}
