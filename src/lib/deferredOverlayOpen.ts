interface LazyOverlay {
  isLoaded: () => boolean;
  preload: () => Promise<unknown>;
}

export interface DeferredOverlayOpener {
  /**
   * Opens an overlay a menu pick asked for, from the menu's close-focus hook.
   * Loaded, it claims the close (no focus return) and opens at once. Still
   * loading, the menu hands focus back as usual and the overlay opens once its
   * chunk lands, unless the user has moved on by then.
   */
  open: (overlay: LazyOverlay, closeEvent: Event, onOpen: () => void) => void;
  /** Drops a pick still waiting on its chunk. */
  cancel: () => void;
}

/**
 * A pick waiting on its chunk is dropped by Escape, a pointer press, focus
 * leaving wherever the menu returned it, a later pick, or `cancel()`. A failed
 * load opens nothing, so the lazy component never renders a rejected import.
 */
export function createDeferredOverlayOpener(): DeferredOverlayOpener {
  let generation = 0;
  let detach: (() => void) | null = null;

  const cancel = () => {
    generation += 1;
    detach?.();
    detach = null;
  };

  const open: DeferredOverlayOpener["open"] = (overlay, closeEvent, onOpen) => {
    cancel();
    if (overlay.isLoaded()) {
      closeEvent.preventDefault();
      onOpen();
      return;
    }
    const mine = generation;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", cancel, true);
    detach = () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", cancel, true);
    };
    // The menu returns focus during this close; a task later is where it landed.
    let returnedTo: Element | null = null;
    const focusSettled = new Promise<void>((resolve) =>
      setTimeout(() => {
        returnedTo = document.activeElement;
        resolve();
      }, 0)
    );
    Promise.all([overlay.preload(), focusSettled]).then(
      () => {
        if (generation !== mine) return;
        const focusStayed = document.activeElement === returnedTo;
        cancel();
        if (focusStayed) onOpen();
      },
      () => {
        if (generation === mine) cancel();
      }
    );
  };

  return { open, cancel };
}
