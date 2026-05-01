import type { ReactElement, ReactNode, RefObject } from "react";
import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";

export interface TitleEditingContextValue {
  isEditingTitle: boolean;
  editingValue: string;
  startEditing: () => void;
  stopEditing: () => void;
  setEditingValue: (value: string) => void;
  handleTitleDoubleClick: (e: React.MouseEvent) => void;
  handleTitleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  handleTitleBlur: () => void;
  /**
   * Timestamp (ms) when editing most recently started. Consumers use this to
   * suppress spurious blur events that fire while overlay-restoration logic
   * (e.g. Radix's `onCloseAutoFocus`) is racing the input's mount.
   */
  editingStartedAtRef: RefObject<number>;
}

const TitleEditingContext = createContext<TitleEditingContextValue | null>(null);

export interface TitleEditingProviderProps {
  children: ReactNode;
  id?: string;
  title: string;
  onTitleChange?: (newTitle: string) => void;
}

export function TitleEditingProvider({
  children,
  id,
  title,
  onTitleChange,
}: TitleEditingProviderProps): ReactElement {
  const [isEditingTitle, setIsEditingTitleState] = useState(false);
  const [editingValue, setEditingValue] = useState(title);
  const editingStartedAtRef = useRef(0);

  const setIsEditingTitle = useCallback((next: boolean) => {
    if (next) editingStartedAtRef.current = Date.now();
    setIsEditingTitleState(next);
  }, []);

  // Sync editing value with title when not editing
  useEffect(() => {
    if (!isEditingTitle) {
      setEditingValue(title);
    }
  }, [title, isEditingTitle]);

  const startEditing = useCallback(() => {
    if (onTitleChange) {
      setEditingValue(title);
      setIsEditingTitle(true);
    }
  }, [title, onTitleChange, setIsEditingTitle]);

  // Listen for rename events from context menu
  useEffect(() => {
    if (!id || !onTitleChange) return;

    const handleRenameEvent = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as unknown;
      if (!detail || typeof (detail as { id?: unknown }).id !== "string") return;
      if ((detail as { id: string }).id === id) {
        setEditingValue(title);
        setIsEditingTitle(true);
      }
    };

    const controller = new AbortController();
    window.addEventListener("daintree:rename-terminal", handleRenameEvent, {
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [id, title, onTitleChange, setIsEditingTitle]);

  const stopEditing = useCallback(() => {
    setIsEditingTitle(false);
  }, []);

  const handleTitleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onTitleChange) {
        startEditing();
      }
    },
    [onTitleChange, startEditing]
  );

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const trimmed = editingValue.trim();
        if (trimmed && trimmed !== title) {
          onTitleChange?.(trimmed);
        }
        stopEditing();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setEditingValue(title);
        stopEditing();
      }
    },
    [editingValue, title, onTitleChange, stopEditing]
  );

  const handleTitleBlur = useCallback(() => {
    const trimmed = editingValue.trim();
    if (trimmed && trimmed !== title) {
      onTitleChange?.(trimmed);
    }
    stopEditing();
  }, [editingValue, title, onTitleChange, stopEditing]);

  const value: TitleEditingContextValue = {
    isEditingTitle,
    editingValue,
    startEditing,
    stopEditing,
    setEditingValue,
    handleTitleDoubleClick,
    handleTitleKeyDown,
    handleTitleBlur,
    editingStartedAtRef,
  };

  return <TitleEditingContext.Provider value={value}>{children}</TitleEditingContext.Provider>;
}

export function useTitleEditing(): TitleEditingContextValue {
  const context = useContext(TitleEditingContext);
  if (!context) {
    throw new Error("useTitleEditing must be used within a TitleEditingProvider");
  }
  return context;
}

export function useTitleEditingOptional(): TitleEditingContextValue | null {
  return useContext(TitleEditingContext);
}
