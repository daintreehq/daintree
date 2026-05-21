import { useCallback, useRef } from "react";
import { usePanelStore } from "@/store";
import { requestPanelClose } from "@/services/terminal/optimisticPanelClose";
import { logError } from "@/utils/logger";

export interface UsePanelHandlersConfig {
  terminalId: string;
  onAfterClose?: () => void;
  /**
   * Surface this panel renders on. The optimistic-close overlay only filters
   * the grid, so dock panels close canonically and synchronously instead of
   * routing through the coordinator (where they'd just sit visible until the
   * deferred commit). Defaults to "grid".
   */
  surface?: "grid" | "dock";
}

export interface PanelHandlers {
  handleFocus: () => void;
  handleClose: (force?: boolean) => void;
  handleTitleChange: (newTitle: string) => void;
}

export function usePanelHandlers({
  terminalId,
  onAfterClose,
  surface = "grid",
}: UsePanelHandlersConfig): PanelHandlers {
  const setFocused = usePanelStore((state) => state.setFocused);
  const trashPanelGroup = usePanelStore((state) => state.trashPanelGroup);
  const removePanel = usePanelStore((state) => state.removePanel);
  const getPanelGroup = usePanelStore((state) => state.getPanelGroup);
  const updateTitle = usePanelStore((state) => state.updateTitle);

  // Synchronous guard against rapid Cmd+W double-fires. useState would batch
  // and read stale on the second tick; refs mutate atomically.
  const trashedRef = useRef(false);

  const handleFocus = useCallback(() => {
    setFocused(terminalId);
  }, [setFocused, terminalId]);

  const handleClose = useCallback(
    (force?: boolean) => {
      if (trashedRef.current) return;
      trashedRef.current = true;

      if (force) {
        removePanel(terminalId);
        onAfterClose?.();
        return;
      }

      // Dock panels aren't covered by the grid's optimistic-hide overlay, so
      // close them canonically and synchronously — there's nothing to defer to.
      if (surface === "dock") {
        try {
          trashPanelGroup(terminalId);
        } catch (error) {
          logError("Failed to trash terminal", error);
        }
        onAfterClose?.();
        return;
      }

      // Optimistic close: hide the panel(s) from the grid now, run the
      // canonical trash after the removal has painted. The X button closes the
      // whole tab group, so hide every panel in it.
      const group = getPanelGroup(terminalId);
      requestPanelClose({
        hideIds: group ? [...group.panelIds] : [terminalId],
        commit: () => {
          try {
            trashPanelGroup(terminalId);
          } catch (error) {
            logError("Failed to trash terminal", error);
          }
        },
      });
      onAfterClose?.();
    },
    [removePanel, trashPanelGroup, getPanelGroup, terminalId, onAfterClose, surface]
  );

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      updateTitle(terminalId, newTitle);
    },
    [updateTitle, terminalId]
  );

  return { handleFocus, handleClose, handleTitleChange };
}
