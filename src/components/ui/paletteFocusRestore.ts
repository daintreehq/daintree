/**
 * One-shot opt-out from a palette's close-time focus restoration.
 *
 * A palette normally returns the keyboard to whatever opened it, which is right
 * for Escape and for a backdrop click. It is wrong when the palette's whole
 * purpose was to *move* focus somewhere: the fleet overview focuses the run you
 * picked, and the restore then fires from the exit animation ~100ms later and
 * silently hands the keyboard back to the panel you were trying to leave.
 *
 * Its own module rather than a `let` beside the component so the flag is only
 * ever reached through these two functions — module-scope mutable state read
 * inside a component file is exactly what the React Compiler lint flags, and
 * function accessors are how `panelFocusRegistry` handles the same shape.
 *
 * Callers must arm this ONLY on a path that actually closes the palette.
 * Arming it and then leaving the dialog open leaks the flag into whichever
 * palette closes next.
 */
let suppressNextRestore = false;

export function suppressPaletteFocusRestore(): void {
  suppressNextRestore = true;
}

/** Reads and clears the flag. Returns whether restoration should be skipped. */
export function consumePaletteFocusRestoreSuppression(): boolean {
  const suppressed = suppressNextRestore;
  suppressNextRestore = false;
  return suppressed;
}

/**
 * One-shot hand-off of a palette's close-time focus restoration to the caller,
 * for a pick whose outcome decides it: a switch that moves the window takes
 * the keyboard with it, one that fails or is cancelled should give it back.
 * `receive` gets the restore when the palette would have run it, and calls it
 * (or not) once it knows. Same arming rule as {@link suppressPaletteFocusRestore}.
 */
let deferredRestore: ((restore: () => void) => void) | null = null;

export function deferPaletteFocusRestore(receive: (restore: () => void) => void): void {
  deferredRestore = receive;
}

/** Reads and clears the hand-off. Null when the palette should restore as usual. */
export function consumeDeferredPaletteFocusRestore(): ((restore: () => void) => void) | null {
  const receive = deferredRestore;
  deferredRestore = null;
  return receive;
}
