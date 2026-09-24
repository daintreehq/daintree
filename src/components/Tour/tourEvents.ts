export const OPEN_DAINTREE_TOUR_EVENT = "daintree:open-daintree-tour";

/** Fired once the tour is finished, so offers still on screen can withdraw. */
export const DAINTREE_TOUR_COMPLETED_EVENT = "daintree:daintree-tour-completed";

/** Kept dependency-free so actions can open the tour without pulling in its UI. */
export function openDaintreeTour(): void {
  window.dispatchEvent(new CustomEvent(OPEN_DAINTREE_TOUR_EVENT));
}
