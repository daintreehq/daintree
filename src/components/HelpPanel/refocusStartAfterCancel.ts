const MAX_FRAMES = 10;

/**
 * Cancel goes with the launching state it sits in, and the keyboard with it.
 * Once the launch is stopped, hand the keyboard to the Start button that takes
 * its place, ringed only when Cancel was pressed from the keyboard. Nothing
 * moves if focus has gone anywhere else meanwhile, or the surface has gone.
 */
export function refocusStartAfterCancel(
  cancel: () => Promise<unknown>,
  start: () => HTMLElement | null
): void {
  const pressed = document.activeElement;
  const ringed = pressed instanceof HTMLElement && pressed.matches(":focus-visible");
  void cancel().then(() => {
    const attempt = (frame: number) => {
      const focused = document.activeElement;
      const stranded = focused === null || focused === document.body;
      // Cancel still holding it means the launching state hasn't gone yet: wait for it.
      if (!stranded && focused !== pressed) return;
      const target = stranded ? start() : null;
      if (target) {
        target.focus({ preventScroll: true, focusVisible: ringed });
        return;
      }
      if (frame < MAX_FRAMES) requestAnimationFrame(() => attempt(frame + 1));
    };
    requestAnimationFrame(() => attempt(0));
  });
}
