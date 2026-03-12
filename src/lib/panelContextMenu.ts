/**
 * Programmatically opens a Radix context menu for the panel identified by terminalId.
 * Dispatches a synthetic contextmenu MouseEvent on the trigger element found via
 * data-context-trigger attribute. Radix requires bubbles:true and valid coordinates.
 */
export function openPanelContextMenu(terminalId: string): boolean {
  const triggerEl = document.querySelector(`[data-context-trigger="${terminalId}"]`);
  if (!triggerEl || !(triggerEl instanceof HTMLElement)) return false;

  const rect = triggerEl.getBoundingClientRect();

  // display:contents elements may return a zero rect; fall back to first child
  let clientX = rect.left + rect.width / 2;
  let clientY = rect.top + rect.height / 2;
  if (rect.width === 0 && rect.height === 0 && triggerEl.firstElementChild) {
    const childRect = triggerEl.firstElementChild.getBoundingClientRect();
    clientX = childRect.left + childRect.width / 2;
    clientY = childRect.top + childRect.height / 2;
  }

  triggerEl.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
    })
  );
  return true;
}
