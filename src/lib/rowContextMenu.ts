/** Whether a keyboard event is the "open the context menu" gesture: the Menu key or Shift+F10. */
export function isRowMenuKey(event: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  if (event.key === "ContextMenu") return true;
  return event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/**
 * Opens a row's context menu from the keyboard, anchored to the row.
 *
 * Radix's ContextMenu derives its position from the `contextmenu` event and has
 * no imperative open, so the Menu key and Shift+F10 are replayed as a synthetic
 * event on the row's own node. Returns false when there is no row to anchor to,
 * leaving the keypress for whoever else wants it.
 */
export function openRowMenuFromKeyboard(row: HTMLElement | null): boolean {
  if (row === null) return false;
  const rect = row.getBoundingClientRect();
  row.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 8,
      clientY: rect.top + rect.height / 2,
    })
  );
  return true;
}
