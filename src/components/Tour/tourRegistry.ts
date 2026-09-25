import type { TourRegistration } from "./tourDefinition";
import { DAINTREE_TOUR_REGISTRATION } from "./daintreeTourSummary";

const tours = new Map<string, TourRegistration>();

/** Makes a tour playable by id. Returns the cleanup that withdraws it again. */
export function registerTour(registration: TourRegistration): () => void {
  const { id } = registration.summary;
  if (tours.has(id)) throw new Error(`A tour with id "${id}" is already registered`);
  tours.set(id, registration);
  return () => {
    if (tours.get(id) === registration) tours.delete(id);
  };
}

export function getTour(tourId: string): TourRegistration | undefined {
  return tours.get(tourId);
}

registerTour(DAINTREE_TOUR_REGISTRATION);
