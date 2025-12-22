import { useCallback, useState, useEffect, useRef, useMemo } from "react";
import { useTerminalStore, type TerminalInstance } from "@/store";
import { getTerminalAnimationDuration } from "@/lib/animationUtils";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { getPanelComponent, type PanelComponentProps } from "@/registry";
import { ContentPanel } from "@/components/Panel";

export interface DockedPanelProps {
  terminal: TerminalInstance;
  onPopoverClose?: () => void;
}

export function DockedPanel({ terminal, onPopoverClose }: DockedPanelProps) {
  const setFocused = useTerminalStore((state) => state.setFocused);
  const trashTerminal = useTerminalStore((state) => state.trashTerminal);
  const removeTerminal = useTerminalStore((state) => state.removeTerminal);
  const updateTitle = useTerminalStore((state) => state.updateTitle);
  const moveTerminalToGrid = useTerminalStore((state) => state.moveTerminalToGrid);
  const closeDockTerminal = useTerminalStore((state) => state.closeDockTerminal);

  const [isTrashing, setIsTrashing] = useState(false);
  const mountedRef = useRef(true);
  const timeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleFocus = useCallback(() => {
    setFocused(terminal.id);
  }, [setFocused, terminal.id]);

  const handleClose = useCallback(
    (force?: boolean) => {
      if (force) {
        removeTerminal(terminal.id);
        onPopoverClose?.();
      } else {
        const duration = getTerminalAnimationDuration();
        setIsTrashing(true);
        timeoutRef.current = setTimeout(() => {
          try {
            trashTerminal(terminal.id);
          } catch (error) {
            console.error("Failed to trash terminal:", error);
          } finally {
            if (mountedRef.current) {
              setIsTrashing(false);
            }
            onPopoverClose?.();
          }
        }, duration);
      }
    },
    [removeTerminal, trashTerminal, terminal.id, onPopoverClose]
  );

  const handleRestore = useCallback(() => {
    onPopoverClose?.();
    moveTerminalToGrid(terminal.id);
  }, [moveTerminalToGrid, terminal.id, onPopoverClose]);

  const handleMinimize = useCallback(() => {
    closeDockTerminal();
  }, [closeDockTerminal]);

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      updateTitle(terminal.id, newTitle);
    },
    [updateTitle, terminal.id]
  );

  const focusedId = useTerminalStore((state) => state.focusedId);
  const isFocused = focusedId === terminal.id;

  // Get the registered component for this panel kind
  const kind = terminal.kind ?? "terminal";
  const registration = getPanelComponent(kind);

  // Build props for the panel component
  const panelProps: PanelComponentProps = useMemo(
    () => ({
      // Core identity
      id: terminal.id,
      title: terminal.title,
      worktreeId: terminal.worktreeId,

      // Container state
      isFocused,
      location: "dock" as const,
      isTrashing,

      // Actions
      onFocus: handleFocus,
      onClose: handleClose,
      onRestore: handleRestore,
      onMinimize: handleMinimize,
      onTitleChange: handleTitleChange,

      // Terminal-specific
      type: terminal.type,
      agentId: terminal.agentId,
      cwd: terminal.cwd,
      agentState: terminal.agentState,
      activity: terminal.activityHeadline
        ? {
            headline: terminal.activityHeadline,
            status: terminal.activityStatus ?? "working",
            type: terminal.activityType ?? "interactive",
          }
        : null,
      lastCommand: terminal.lastCommand,
      flowStatus: terminal.flowStatus,
      restartKey: terminal.restartKey,
      restartError: terminal.restartError,

      // Browser-specific
      initialUrl: terminal.browserUrl || "http://localhost:3000",
    }),
    [
      terminal,
      isFocused,
      isTrashing,
      handleFocus,
      handleClose,
      handleRestore,
      handleMinimize,
      handleTitleChange,
    ]
  );

  if (!registration) {
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
