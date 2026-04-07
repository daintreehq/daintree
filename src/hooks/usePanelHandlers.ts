import { useCallback } from "react";
import { usePanelStore } from "@/store";
import { getTerminalAnimationDuration } from "@/lib/animationUtils";
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
  const setFocused = usePanelStore((state) => state.setFocused);
  const trashPanelGroup = usePanelStore((state) => state.trashPanelGroup);
  const removePanel = usePanelStore((state) => state.removePanel);
  const updateTitle = usePanelStore((state) => state.updateTitle);

  const handleFocus = useCallback(() => {
    setFocused(terminalId);
  }, [setFocused, terminalId]);

  const handleClose = useCallback(
    (force?: boolean) => {
      if (force) {
        removePanel(terminalId);
        onAfterClose?.();
      } else {
        const duration = getTerminalAnimationDuration();
        lifecycle.setIsTrashing(true);
        lifecycle.timeoutRef.current = setTimeout(() => {
          try {
            trashPanelGroup(terminalId);
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
    [removePanel, trashPanelGroup, terminalId, onAfterClose, lifecycle]
  );

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      updateTitle(terminalId, newTitle);
    },
    [updateTitle, terminalId]
  );

  return { handleFocus, handleClose, handleTitleChange };
}
