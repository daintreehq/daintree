/**
 * Puts the keyboard in this pane's own search field, query selected so typing
 * replaces it. Scoped to the pane: another pane earlier in the document with
 * its bar open would otherwise take the focus (#16877).
 */
export function focusPaneSearchInput(container: ParentNode | null | undefined): void {
  const input = container?.querySelector<HTMLInputElement>("[data-terminal-search-input]");
  if (!input) return;
  input.focus();
  input.select();
}
