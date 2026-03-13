import { useCallback } from "react";
import { useTerminalStore } from "@/store";
import { getTerminalAnimationDuration } from "@/lib/animationUtils";
import { confirmAgentTrash } from "@/utils/agentTrashConfirm";
import type { PanelLifecycle } from "./usePanelLifecycle";

export interface UsePanelHandlersConfig {
  terminalId: string;
  lifecycle: PanelLifecycle;
  onAfterClose?: () => void;
}

export interface PanelHandlers {
  handleFocus: () => void;
  handleClose: (force?: boolean) => void;
  handleTitleChange: (newTitle: string) => void;
}

export function usePanelHandlers({
  terminalId,
  lifecycle,
  onAfterClose,
}: UsePanelHandlersConfig): PanelHandlers {
  const setFocused = useTerminalStore((state) => state.setFocused);
  const trashPanelGroup = useTerminalStore((state) => state.trashPanelGroup);
  const removeTerminal = useTerminalStore((state) => state.removeTerminal);
  const updateTitle = useTerminalStore((state) => state.updateTitle);

  const handleFocus = useCallback(() => {
    setFocused(terminalId);
  }, [setFocused, terminalId]);

  const handleClose = useCallback(
    (force?: boolean) => {
      if (force) {
        removeTerminal(terminalId);
        onAfterClose?.();
      } else {
        const state = useTerminalStore.getState();
        const group = state.getPanelGroup(terminalId);
        const panelsToCheck = group
          ? state.terminals.filter((t) => group.panelIds.includes(t.id))
          : state.terminals.filter((t) => t.id === terminalId);
        if (!confirmAgentTrash(panelsToCheck)) return;

        const duration = getTerminalAnimationDuration();
        lifecycle.setIsTrashing(true);
        lifecycle.timeoutRef.current = setTimeout(() => {
          try {
            trashPanelGroup(terminalId, { showUndoToast: true });
          } catch (error) {
            console.error("Failed to trash terminal:", error);
          } finally {
            if (lifecycle.mountedRef.current) {
              lifecycle.setIsTrashing(false);
            }
            onAfterClose?.();
          }
        }, duration);
      }
    },
    [removeTerminal, trashPanelGroup, terminalId, onAfterClose, lifecycle]
  );

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      updateTitle(terminalId, newTitle);
    },
    [updateTitle, terminalId]
  );

  return { handleFocus, handleClose, handleTitleChange };
}
