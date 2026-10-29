/**
 * Marks a live dialog that blocks one pane rather than the app: a page's
 * `alert()`, `confirm()` or `prompt()` over its Browser or dev preview pane.
 *
 * It is deliberately not `aria-modal`. The checks that read that as "a dialog
 * owns input" (type-anywhere, the `modalOpen` keybinding context, Escape
 * ownership, the fleet's Enter and Escape) apply it to the whole window, and a
 * pane-sized dialog that did so took the keyboard from every other pane
 * (#15037). Each of them asks `isInPaneDialog` about the key's target instead,
 * so this dialog owns the keyboard only while focus is inside it.
 *
 * Absent once the dialog is answered, while its card fades out.
 */
export const PANE_DIALOG_ATTR = "data-pane-dialog";

// Where the dialog puts the keyboard when it opens: a prompt's field, otherwise OK.
const ENTRY_SELECTOR = 'input:not([type="hidden"]), [data-confirm-role="confirm"]';

export function isInPaneDialog(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && target.closest(`[${PANE_DIALOG_ATTR}]`) !== null;
}

/**
 * Hands the keyboard to the pane dialog inside `container`, if one is up. False
 * when there is none, or the browser refused the focus (a pane parked in the
 * dock's hidden container), so the caller can focus what it meant to.
 */
export function focusPaneDialog(container: Element): boolean {
  const dialog = container.querySelector<HTMLElement>(`[${PANE_DIALOG_ATTR}]`);
  if (!dialog) return false;
  if (dialog.contains(document.activeElement)) return true;
  const entry = dialog.querySelector<HTMLElement>(ENTRY_SELECTOR) ?? dialog;
  entry.focus({ preventScroll: true });
  return dialog.contains(document.activeElement);
}
