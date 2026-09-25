import type { TourRegistration } from "./tourDefinition";
import { DAINTREE_TOUR_REGISTRATION } from "./daintreeTourSummary";

const tours = new Map<string, TourRegistration>();
const registryListeners = new Set<() => void>();
const tourListeners = new Set<(tourId: string) => void>();
let registeredIds: ReadonlySet<string> = new Set();

function publish(tourId: string): void {
  registeredIds = new Set(tours.keys());
  for (const listener of registryListeners) listener();
  for (const listener of tourListeners) listener(tourId);
}

/** Makes a tour playable by id. Returns the cleanup that withdraws it again. */
export function registerTour(registration: TourRegistration): () => void {
  const { id } = registration.summary;
  if (tours.has(id)) throw new Error(`A tour with id "${id}" is already registered`);
  tours.set(id, registration);
  publish(id);
  return () => {
    if (tours.get(id) !== registration) return;
    tours.delete(id);
    publish(id);
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
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

/**
 * Called with a tour's id whenever it is registered or withdrawn, so whatever
 * holds that tour open can tell it is gone. Returns the unsubscribe.
 */
export function subscribeTours(listener: (tourId: string) => void): () => void {
  tourListeners.add(listener);
  return () => {
    tourListeners.delete(listener);
  };
}

registerTour(DAINTREE_TOUR_REGISTRATION);
