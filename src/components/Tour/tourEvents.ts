import { DAINTREE_TOUR_ID } from "@shared/utils/tourIds";

export const OPEN_TOUR_EVENT = "daintree:open-tour";

/** Fired once a tour is finished, so offers still on screen can withdraw. */
export const TOUR_COMPLETED_EVENT = "daintree:tour-completed";

/** Fired once per run when a tour that opened stops playing, with how it ended. */
export const TOUR_OUTCOME_EVENT = "daintree:tour-outcome";

export interface TourEventDetail {
  tourId: string;
  /** Set by `requestTour`, which waits for the host to answer it. */
  requestId?: number;
}

/** Kept dependency-free so actions can open a tour without pulling in its UI. */
export function openTour(tourId: string = DAINTREE_TOUR_ID): void {
  window.dispatchEvent(new CustomEvent<TourEventDetail>(OPEN_TOUR_EVENT, { detail: { tourId } }));
}

/** For click handlers, which would otherwise hand `openTour` their event as the id. */
export function openDaintreeTour(): void {
  openTour(DAINTREE_TOUR_ID);
}

export function tourIdOf(event: Event): string {
  const detail: unknown = event instanceof CustomEvent ? event.detail : null;
  return typeof detail === "object" &&
    detail !== null &&
    "tourId" in detail &&
    typeof detail.tourId === "string"
    ? detail.tourId
    : DAINTREE_TOUR_ID;
}

export function requestIdOf(event: Event): number | null {
  const detail: unknown = event instanceof CustomEvent ? event.detail : null;
  return typeof detail === "object" &&
    detail !== null &&
    "requestId" in detail &&
    typeof detail.requestId === "number"
    ? detail.requestId
    : null;
}
