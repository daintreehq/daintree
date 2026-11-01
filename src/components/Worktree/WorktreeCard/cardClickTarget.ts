/**
 * The card is the button: a click anywhere on its content selects the
 * worktree, and a click on a control does that control's thing and nothing
 * else (#15864). This is what tells the two apart, so no control has to
 * remember to stop propagation for the card to behave.
 *
 * Kept in step with the hover rule in `sidebar.css` that suppresses the card's
 * tint while one of these is under the pointer: the surface that answers a
 * click is the one that lights up.
 *
 * Status marks are `role="img"` and the activity age is a focusable
 * `role="group"`; neither is a control, so both select, which is why
 * `[tabindex]` is deliberately not in this list.
 */
export const CARD_CONTROL_SELECTOR = [
  "button:not([data-card-select-overlay])",
  "a[href]",
  "input",
  "select",
  "textarea",
  "summary",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  "[data-card-control]",
  "[data-worktree-row-drag-handle]",
].join(", ");

/**
 * True when a click or double-click on the card landed on its content rather
 * than on a control inside it.
 *
 * DOM containment comes first because React bubbles a portalled menu's,
 * popover's or dialog's events through the card's tree even though their
 * nodes live under `document.body`; a click in one of those is never a click
 * on the card. A control found above the card (a sortable wrapper's own
 * `role`) is not the card's, so it does not count either.
 */
export function isCardContentEvent(event: {
  target: EventTarget | null;
  currentTarget: EventTarget | null;
}): boolean {
  const card = event.currentTarget;
  const target = event.target;
  if (!(card instanceof Element) || !(target instanceof Element)) return false;
  if (!card.contains(target)) return false;
  const control = target.closest(CARD_CONTROL_SELECTOR);
  return control === null || !card.contains(control);
}

/**
 * A pointer click that ends a drag-to-select inside the card is the end of a
 * text selection, not a request to switch worktrees. A selection elsewhere in
 * the window has already collapsed by the time a click on the card arrives.
 */
export function hasTextSelectionWithin(card: Element): boolean {
  const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  const { anchorNode, focusNode } = selection;
  return (
    (anchorNode !== null && card.contains(anchorNode)) ||
    (focusNode !== null && card.contains(focusNode))
  );
}
