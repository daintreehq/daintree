import { useCallback, useState } from "react";
import { useTerminalStore } from "@/store";
import { getTerminalAnimationDuration } from "@/lib/animationUtils";

export interface UseTerminalActionsOptions {
  terminalId: string;
  onTrashComplete?: () => void;
}

export interface UseTerminalActionsReturn {
  onFocus: () => void;
  onClose: (force?: boolean) => void;
  onToggleMaximize: () => void;
  onTitleChange: (newTitle: string) => void;
  onMinimize: () => void;
  onRestore: () => void;
  isTrashing: boolean;
}

export function useTerminalActions({
  terminalId,
  onTrashComplete,
}: UseTerminalActionsOptions): UseTerminalActionsReturn {
  const setFocused = useTerminalStore((state) => state.setFocused);
  const trashTerminal = useTerminalStore((state) => state.trashTerminal);
  const removeTerminal = useTerminalStore((state) => state.removeTerminal);
  const toggleMaximize = useTerminalStore((state) => state.toggleMaximize);
  const updateTitle = useTerminalStore((state) => state.updateTitle);
  const moveTerminalToDock = useTerminalStore((state) => state.moveTerminalToDock);
  const moveTerminalToGrid = useTerminalStore((state) => state.moveTerminalToGrid);

  const [isTrashing, setIsTrashing] = useState(false);

  const onFocus = useCallback(() => {
    setFocused(terminalId);
  }, [setFocused, terminalId]);

  const onClose = useCallback(
    (force?: boolean) => {
      if (force) {
        removeTerminal(terminalId);
        onTrashComplete?.();
      } else {
        const duration = getTerminalAnimationDuration();
        setIsTrashing(true);
        setTimeout(() => {
          trashTerminal(terminalId);
          setIsTrashing(false);
          onTrashComplete?.();
        }, duration);
      }
    },
    [removeTerminal, trashTerminal, terminalId, onTrashComplete]
  );

  const onToggleMaximize = useCallback(() => {
    toggleMaximize(terminalId);
  }, [toggleMaximize, terminalId]);

  const onTitleChange = useCallback(
    (newTitle: string) => {
      updateTitle(terminalId, newTitle);
    },
    [updateTitle, terminalId]
  );

  const onMinimize = useCallback(() => {
    moveTerminalToDock(terminalId);
  }, [moveTerminalToDock, terminalId]);

  const onRestore = useCallback(() => {
    moveTerminalToGrid(terminalId);
  }, [moveTerminalToGrid, terminalId]);

  return {
    onFocus,
    onClose,
    onToggleMaximize,
    onTitleChange,
    onMinimize,
    onRestore,
    isTrashing,
  };
}
