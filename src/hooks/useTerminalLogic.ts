import { useState, useCallback, useEffect, useRef } from "react";
import type { RetryAction } from "@/store";
import { errorsClient } from "@/clients";

interface UseTerminalLogicOptions {
  id: string;
  title: string;
  onTitleChange?: (newTitle: string) => void;
  removeError: (errorId: string) => void;
  restartKey?: number;
}

export interface UseTerminalLogicReturn {
  // Title editing
  isEditingTitle: boolean;
  editingValue: string;
  titleInputRef: React.RefObject<HTMLInputElement | null>;
  setEditingValue: (value: string) => void;
  handleTitleDoubleClick: (e: React.MouseEvent) => void;
  handleTitleKeyDown: (e: React.KeyboardEvent) => void;
  handleTitleInputKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  handleTitleSave: () => void;
  handleTitleCancel: () => void;

  // Error handling
  handleErrorRetry: (
    errorId: string,
    action: RetryAction,
    args?: Record<string, unknown>
  ) => Promise<void>;

  // Exit handling
  isExited: boolean;
  exitCode: number | null;
  handleExit: (code: number) => void;
}

export function useTerminalLogic({
  id,
  title,
  onTitleChange,
  removeError,
  restartKey,
}: UseTerminalLogicOptions): UseTerminalLogicReturn {
  const [isExited, setIsExited] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editingValue, setEditingValue] = useState(title);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const cancelledRef = useRef(false);

  // Reset exit state when terminal ID or restartKey changes
  useEffect(() => {
    setIsExited(false);
    setExitCode(null);
  }, [id, restartKey]);

  // Sync editing value when title changes externally (and not editing)
  useEffect(() => {
    if (!isEditingTitle) {
      setEditingValue(title);
    }
  }, [title, isEditingTitle]);

  // Focus and select input when editing starts
  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  // Listen for rename events from context menu
  const canRename = Boolean(onTitleChange);
  useEffect(() => {
    if (!canRename) return;

    const handleRenameEvent = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      if (!detail || typeof (detail as { id?: unknown }).id !== "string") return;
      if ((detail as { id: string }).id === id) {
        setIsEditingTitle(true);
      }
    };

    const controller = new AbortController();
    window.addEventListener("canopy:rename-terminal", handleRenameEvent, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [id, canRename]);

  const handleTitleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onTitleChange) {
        setIsEditingTitle(true);
      }
    },
    [onTitleChange]
  );

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (onTitleChange && (e.key === "Enter" || e.key === "F2")) {
        e.preventDefault();
        e.stopPropagation();
        setIsEditingTitle(true);
      }
    },
    [onTitleChange]
  );

  const handleTitleSave = useCallback(() => {
    if (!isEditingTitle || cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    setIsEditingTitle(false);
    if (onTitleChange) {
      onTitleChange(editingValue);
    }
  }, [isEditingTitle, editingValue, onTitleChange]);

  const handleTitleCancel = useCallback(() => {
    cancelledRef.current = true;
    setIsEditingTitle(false);
    setEditingValue(title);
  }, [title]);

  const handleTitleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleTitleSave();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleTitleCancel();
      }
    },
    [handleTitleSave, handleTitleCancel]
  );

  const handleExit = useCallback((code: number) => {
    setIsExited(true);
    setExitCode(code);
  }, []);

  const handleErrorRetry = useCallback(
    async (errorId: string, action: RetryAction, args?: Record<string, unknown>) => {
      try {
        await errorsClient.retry(errorId, action, args);
        removeError(errorId);
      } catch (error) {
        console.error("Error retry failed:", error);
      }
    },
    [removeError]
  );

  return {
    // Title editing
    isEditingTitle,
    editingValue,
    titleInputRef,
    setEditingValue,
    handleTitleDoubleClick,
    handleTitleKeyDown,
    handleTitleInputKeyDown,
    handleTitleSave,
    handleTitleCancel,

    // Error handling
    handleErrorRetry,

    // Exit handling
    isExited,
    exitCode,
    handleExit,
  };
}
