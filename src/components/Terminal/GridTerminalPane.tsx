import { useCallback, useState, useEffect, useRef } from "react";
import { useTerminalStore, type TerminalInstance } from "@/store";
import { getTerminalAnimationDuration } from "@/lib/animationUtils";
import { TerminalPane } from "./TerminalPane";
import { ErrorBoundary } from "@/components/ErrorBoundary";

export interface GridTerminalPaneProps {
  terminal: TerminalInstance;
  isFocused: boolean;
  isMaximized?: boolean;
  gridTerminalCount?: number;
}

export function GridTerminalPane({
  terminal,
  isFocused,
  isMaximized = false,
  gridTerminalCount,
}: GridTerminalPaneProps) {
  const setFocused = useTerminalStore((state) => state.setFocused);
  const trashTerminal = useTerminalStore((state) => state.trashTerminal);
  const removeTerminal = useTerminalStore((state) => state.removeTerminal);
  const toggleMaximize = useTerminalStore((state) => state.toggleMaximize);
  const updateTitle = useTerminalStore((state) => state.updateTitle);
  const moveTerminalToDock = useTerminalStore((state) => state.moveTerminalToDock);

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
    toggleMaximize(terminal.id);
  }, [toggleMaximize, terminal.id]);

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      updateTitle(terminal.id, newTitle);
    },
    [updateTitle, terminal.id]
  );

  const handleMinimize = useCallback(() => {
    moveTerminalToDock(terminal.id);
  }, [moveTerminalToDock, terminal.id]);

  return (
    <ErrorBoundary
      variant="component"
      componentName="TerminalPane"
      resetKeys={[terminal.id, terminal.worktreeId].filter(
        (key): key is string => key !== undefined
      )}
      context={{ terminalId: terminal.id, worktreeId: terminal.worktreeId }}
    >
      <TerminalPane
        id={terminal.id}
        title={terminal.title}
        type={terminal.type}
        worktreeId={terminal.worktreeId}
        cwd={terminal.cwd}
        isFocused={isFocused}
        isMaximized={isMaximized}
        agentState={terminal.agentState}
        activity={
          terminal.activityHeadline
            ? {
                headline: terminal.activityHeadline,
                status: terminal.activityStatus ?? "working",
                type: terminal.activityType ?? "interactive",
              }
            : null
        }
        lastCommand={terminal.lastCommand}
        flowStatus={terminal.flowStatus}
        location="grid"
        restartKey={terminal.restartKey}
        restartError={terminal.restartError}
        onFocus={handleFocus}
        onClose={handleClose}
        onToggleMaximize={handleToggleMaximize}
        onTitleChange={handleTitleChange}
        onMinimize={handleMinimize}
        isTrashing={isTrashing}
        gridTerminalCount={gridTerminalCount}
      />
    </ErrorBoundary>
  );
}
