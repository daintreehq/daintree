/**
 * Focus hand-off for the copy-tree toolbar dropdown (#11733). Kept out of
 * `Toolbar.tsx` so the close-time restoration can be exercised against a real
 * DOM — the toolbar itself is too large to mount in jsdom.
 */

// The panel portals out of the toolbar, so "is focus still inside it?" can't be
// answered by a DOM ancestor check from the trigger. The marker attribute is
// the panel component's half of that contract.
const COPY_TREE_PANEL_SELECTOR = "[data-copy-tree-panel]";

export function isInsideCopyTreePanel(node: Element | null): boolean {
  return node instanceof HTMLElement && node.closest(COPY_TREE_PANEL_SELECTOR) !== null;
}

/**
 * Hand focus back to the trigger when closing the panel would otherwise strand
 * it — but never fight a destination the user chose.
 *
 * Both reads matter. The first happens at close time, and can only rule the
 * restore OUT: the dismiss path runs off `mousedown`, which fires before the
 * browser's default focus transfer, so focus still sitting in the panel here
 * says nothing about where it is headed.
 *
 * The second runs a frame later, once focus has settled, and counts the exiting
 * panel as "nowhere". Closing does not unmount the body: `FixedDropdown` plays
 * an exit transition first, so a frame later the focused row is still in the
 * document, and it is the unmount at the end of that window — not this frame —
 * that would otherwise drop the user on `<body>`.
 */
export function restoreCopyTreeTriggerFocus(trigger: HTMLElement | null): void {
  const active = document.activeElement;
  if (!isInsideCopyTreePanel(active) && active !== null && active !== document.body) return;

  requestAnimationFrame(() => {
    const settled = document.activeElement;
    if (settled === null || settled === document.body || isInsideCopyTreePanel(settled)) {
      trigger?.focus();
    }
  });
}
