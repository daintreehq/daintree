let openDialogs = 0;

/**
 * Held while an agent CLI sign-in dialog is open in this view, the person's
 * own or one an assistant opened (#18197), so an assistant's sign-in is never
 * opened over it. The call lets go of it, once.
 */
export function holdSignInDialog(): () => void {
  openDialogs++;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    openDialogs--;
  };
}

/** Whether a sign-in dialog is open in this view. */
export function signInDialogOpen(): boolean {
  return openDialogs > 0;
}
