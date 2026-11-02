const dragCancelEscapes = new WeakSet<object>();

/** Marks an event as a drag recovery's Escape, which no key binding should act on. */
export function markDragCancelEscape<T extends object>(event: T): T {
  dragCancelEscapes.add(event);
  return event;
}

/**
 * True for the Escape a drag recovery sends. It has no `key`, so ordinary
 * Escape actions already skip it; a listener that matches on `code` alone, such
 * as a push-to-talk release, checks this instead.
 */
export function isDragCancelEscape(event: object): boolean {
  return dragCancelEscapes.has(event);
}

/**
 * Cancels a live pointer drag whose release never reached the host (#11291) the
 * way dnd-kit's pointer sensors expect: a document keydown with code "Escape".
 * Dispatched on body, not document: capture-phase key handlers cast
 * event.target to HTMLElement (`.closest`), which a Document target would
 * break. The matching keyup releases it for anything tracking held keys
 * (`useDoubleShift`), which would otherwise read Escape as still down.
 */
export function dispatchDragCancelEscape(): void {
  for (const type of ["keydown", "keyup"] as const) {
    document.body.dispatchEvent(
      markDragCancelEscape(
        new KeyboardEvent(type, { code: "Escape", bubbles: true, cancelable: true })
      )
    );
  }
}
