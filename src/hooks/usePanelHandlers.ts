import { useCallback, useRef } from "react";
import { usePanelStore } from "@/store";
import { requestPanelClose } from "@/services/terminal/optimisticPanelClose";
import { logError } from "@/utils/logger";

export interface UsePanelHandlersConfig {
  terminalId: string;
  onAfterClose?: () => void;
  /**
   * Surface this panel renders on. Grid panels route their close through the
   * optimistic-close overlay (which only filters the grid). Dock panels are a
   * floating preview, so a plain close *dismisses* the preview non-destructively
   * via closeDockTerminal — collapsing it while the PTY keeps running, matching
   * Escape / click-outside / chip re-toggle (#11186). Alt+Click still force-closes
   * (removePanel) on either surface. Defaults to "grid".
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
  const closeDockTerminal = usePanelStore((state) => state.closeDockTerminal);
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
      // Dock preview dismissal: collapse the floating preview but leave the PTY
      // running (matches Escape / click-outside / chip re-toggle — #11186).
      // Intentionally runs BEFORE the trashedRef latch: the DockedPanel hook
      // instance survives collapse/reopen cycles, so latching here would let the
      // X dismiss only once per mount. closeDockTerminal is an idempotent pure
      // setter, so it needs no double-fire guard. Alt+Click (force) falls through
      // to the destructive removePanel path below.
      if (surface === "dock" && !force) {
        closeDockTerminal(terminalId);
        onAfterClose?.();
        return;
      }

      if (trashedRef.current) return;
      trashedRef.current = true;

      if (force) {
        removePanel(terminalId);
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
    [
      removePanel,
      trashPanelGroup,
      closeDockTerminal,
      getPanelGroup,
      terminalId,
      onAfterClose,
      surface,
    ]
  );

  const handleTitleChange = useCallback(
    (newTitle: string) => {
      updateTitle(terminalId, newTitle);
    },
    [updateTitle, terminalId]
  );

  return { handleFocus, handleClose, handleTitleChange };
}
