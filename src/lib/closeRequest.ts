/**
 * Cmd+W (`terminal.close`) closes the innermost thing the keyboard is in. A
 * surface inside an overlay that holds something closable of its own — the
 * canopy panel's agent pane, with its terminal — marks itself with this
 * attribute and listens for `CLOSE_REQUEST_EVENT`; cancelling the event says it
 * took the close, so the overlay around it stays open.
 */
export const CLOSE_OWNER_ATTR = "data-close-owner";

export const CLOSE_REQUEST_EVENT = "daintree:close-request";

/**
 * Offers Cmd+W to the close-owning surface the keyboard is in, if any. True
 * when one took it.
 */
export function requestOwnedClose(active: Element | null): boolean {
  const owner = active?.closest(`[${CLOSE_OWNER_ATTR}]`);
  if (!owner) return false;
  const request = new Event(CLOSE_REQUEST_EVENT, { cancelable: true });
  owner.dispatchEvent(request);
  return request.defaultPrevented;
}
