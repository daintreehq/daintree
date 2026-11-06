/**
 * An app modal is a `dialog` or an `alertdialog` that sets `aria-modal`. A
 * destructive AppDialog without a preview is an alertdialog, and it owns input
 * exactly as a plain dialog does. Every check that asks "is a modal open, do
 * the keys belong to it" shares this selector so none of them can drift.
 *
 * A page's dialog over one pane is not `aria-modal` (see `paneDialog`).
 */
export const APP_MODAL_SELECTOR =
  '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';

/**
 * Existence, not ancestry: Radix portals modal content outside the subtree of
 * whatever holds focus, so `closest()` from the focused element misses it.
 */
export function hasAppModal(): boolean {
  return document.querySelector(APP_MODAL_SELECTOR) !== null;
}

/** Is the target inside an app modal's own subtree? */
export function isInAppModal(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && target.closest(APP_MODAL_SELECTOR) !== null;
}
