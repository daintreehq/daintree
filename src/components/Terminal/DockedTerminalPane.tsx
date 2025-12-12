import { useCallback, useState, useEffect, useRef } from "react";
import { useTerminalStore, type TerminalInstance } from "@/store";
import { getTerminalAnimationDuration } from "@/lib/animationUtils";
import { TerminalPane } from "./TerminalPane";

export interface DockedTerminalPaneProps {
  terminal: TerminalInstance;
  onPopoverClose?: () => void;
}

export function DockedTerminalPane({ terminal, onPopoverClose }: DockedTerminalPaneProps) {
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

  return (
    <TerminalPane
      id={terminal.id}
      title={terminal.title}
      type={terminal.type}
      worktreeId={terminal.worktreeId}
      cwd={terminal.cwd}
      isFocused={isFocused}
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
      location="dock"
      restartKey={terminal.restartKey}
      restartError={terminal.restartError}
      onFocus={handleFocus}
      onClose={handleClose}
      onRestore={handleRestore}
      onMinimize={handleMinimize}
      onTitleChange={handleTitleChange}
      isTrashing={isTrashing}
    />
  );
}
