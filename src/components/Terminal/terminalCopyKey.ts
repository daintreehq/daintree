/**
 * Whether Cmd+C pressed on `target` belongs to text the user selected there
 * rather than to the terminal's selection. A field keeps its selection in
 * `selectionStart`/`selectionEnd`, never in `window.getSelection()`, so a
 * search query or a rename selected while the buffer also held a selection
 * used to copy the buffer instead (#16877).
 */
export function targetOwnsCopy(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    // Null for input types that have no text selection (checkbox, number).
    const { selectionStart, selectionEnd } = target;
    if (selectionStart !== null && selectionEnd !== null && selectionStart !== selectionEnd) {
      return true;
    }
  }
  return (window.getSelection()?.toString() ?? "").length > 0;
}
