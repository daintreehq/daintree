import { useCallback, useState, useEffect, useRef, useMemo } from "react";
import { useDockStore, useTerminalStore, type TerminalInstance } from "@/store";
import { getTerminalAnimationDuration } from "@/lib/animationUtils";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { getPanelComponent, type PanelComponentProps } from "@/registry";
import { ContentPanel } from "@/components/Panel";

export interface GridPanelProps {
  terminal: TerminalInstance;
  isFocused: boolean;
  isMaximized?: boolean;
  gridPanelCount?: number;
  gridCols?: number;
}

export function GridPanel({
  terminal,
  isFocused,
  isMaximized = false,
  gridPanelCount,
  gridCols,
}: GridPanelProps) {
  const setFocused = useTerminalStore((state) => state.setFocused);
  const trashTerminal = useTerminalStore((state) => state.trashTerminal);
  const removeTerminal = useTerminalStore((state) => state.removeTerminal);
  const toggleMaximize = useTerminalStore((state) => state.toggleMaximize);
  const updateTitle = useTerminalStore((state) => state.updateTitle);
  const moveTerminalToDock = useTerminalStore((state) => state.moveTerminalToDock);
  const dockBehavior = useDockStore((state) => state.behavior);
  const dockMode = useDockStore((state) => state.mode);
  const setDockMode = useDockStore((state) => state.setMode);

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
          }
        }, duration);
      }
    },
    [removeTerminal, trashTerminal, terminal.id]
  );

  const handleToggleMaximize = useCallback(() => {
    toggleMaximize(terminal.id, gridCols, gridPanelCount);
  }, [toggleMaximize, terminal.id, gridCols, gridPanelCount]);

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      updateTitle(terminal.id, newTitle);
    },
    [updateTitle, terminal.id]
  );

  const handleMinimize = useCallback(() => {
    moveTerminalToDock(terminal.id);
    if (dockBehavior === "manual" && dockMode !== "expanded") {
      setDockMode("expanded");
    }
  }, [dockBehavior, dockMode, moveTerminalToDock, setDockMode, terminal.id]);

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
      isMaximized,
      location: "grid" as const,
      isTrashing,
      gridPanelCount,

      // Actions
      onFocus: handleFocus,
      onClose: handleClose,
      onToggleMaximize: handleToggleMaximize,
      onTitleChange: handleTitleChange,
      onMinimize: handleMinimize,

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

      // Notes-specific
      notePath: (terminal as any).notePath,
      noteId: (terminal as any).noteId,
      scope: (terminal as any).scope,
      createdAt: (terminal as any).createdAt,
    }),
    [
      terminal,
      isFocused,
      isMaximized,
      isTrashing,
      gridPanelCount,
      handleFocus,
      handleClose,
      handleToggleMaximize,
      handleTitleChange,
      handleMinimize,
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
