import type { TourRegistration } from "./tourDefinition";
import { DAINTREE_TOUR_REGISTRATION } from "./daintreeTourSummary";

const tours = new Map<string, TourRegistration>();
const listeners = new Set<() => void>();
let registeredIds: ReadonlySet<string> = new Set();

function publish(): void {
  registeredIds = new Set(tours.keys());
  for (const listener of listeners) listener();
}

/** Makes a tour playable by id. Returns the cleanup that withdraws it again. */
export function registerTour(registration: TourRegistration): () => void {
  const { id } = registration.summary;
  if (tours.has(id)) throw new Error(`A tour with id "${id}" is already registered`);
  tours.set(id, registration);
  publish();
  return () => {
    if (tours.get(id) !== registration) return;
    tours.delete(id);
    publish();
  };
}

export function getTour(tourId: string): TourRegistration | undefined {
  return tours.get(tourId);
}

/** The ids playable right now, replaced on every change for `useSyncExternalStore`. */
export function getRegisteredTourIdsSnapshot(): ReadonlySet<string> {
  return registeredIds;
}

export function subscribeToTourRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

registerTour(DAINTREE_TOUR_REGISTRATION);
