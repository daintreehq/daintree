import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/**
 * Whether the console row holding this content has keyboard focus. A row owns
 * the keyboard, so the tooltips inside it (a source's full path, why a value
 * is unavailable) open with the row's focus rather than adding tab stops.
 */
export const RowKeyboardFocusContext = createContext(false);

/**
 * Open state for a tooltip that opens on hover or with its row's keyboard
 * focus. Escape dismisses it whichever opened it (WCAG 1.4.13), and it stays
 * dismissed until the row's focus ends or the pointer comes back.
 *
 * The pointer is tracked on the trigger itself because the tooltip reports a
 * close the same way for Escape and for the pointer leaving: a close while the
 * pointer is still over the trigger, or while only focus holds it open, can
 * only be a dismissal.
 */
export function useRowFocusTooltip(): {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerProps: { onPointerEnter: () => void; onPointerLeave: () => void };
} {
  const rowFocused = useContext(RowKeyboardFocusContext);
  const [isHovered, setIsHovered] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const pointerInsideRef = useRef(false);

  useEffect(() => {
    if (!rowFocused) setDismissed(false);
  }, [rowFocused]);

  const onOpenChange = useCallback((next: boolean) => {
    if (next) {
      setIsHovered(true);
      return;
    }
    if (pointerInsideRef.current) setDismissed(true);
    setIsHovered(false);
  }, []);

  const onPointerEnter = useCallback(() => {
    pointerInsideRef.current = true;
    setDismissed(false);
  }, []);
  const onPointerLeave = useCallback(() => {
    pointerInsideRef.current = false;
  }, []);

  // Escape with only focus holding it open arrives as a close with the
  // pointer away and no hover to end.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && rowFocused && !isHovered) setDismissed(true);
      onOpenChange(next);
    },
    [onOpenChange, rowFocused, isHovered]
  );

  return {
    open: !dismissed && (rowFocused || isHovered),
    onOpenChange: handleOpenChange,
    triggerProps: { onPointerEnter, onPointerLeave },
  };
}
