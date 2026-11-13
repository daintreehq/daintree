import { useCallback, useState } from "react";

export interface RetainedDialog {
  isOpen: boolean;
  /** Open, or closed but still playing its exit: the only time to mount it. */
  isMounted: boolean;
  open: () => void;
  close: () => void;
  /** The dialog's `onCloseComplete`: unmounts it once its exit has finished. */
  onCloseComplete: () => void;
  /** Closes and unmounts at once, for a dialog that could not render at all. */
  reset: () => void;
}

/**
 * Mounts a dialog only while it is in use. A closed dialog that stays mounted
 * keeps every store subscription it holds, so a host that is always on screen
 * pays for the dialog on every store write. Unmounting only after the exit
 * completes keeps the close animation and the focus hand-back intact.
 */
export function useRetainedDialog(): RetainedDialog {
  const [isOpen, setIsOpen] = useState(false);
  const [isRetained, setIsRetained] = useState(false);

  const open = useCallback(() => {
    setIsOpen(true);
    setIsRetained(true);
  }, []);
  const close = useCallback(() => setIsOpen(false), []);
  const onCloseComplete = useCallback(() => setIsRetained(false), []);
  const reset = useCallback(() => {
    setIsOpen(false);
    setIsRetained(false);
  }, []);

  return { isOpen, isMounted: isOpen || isRetained, open, close, onCloseComplete, reset };
}
