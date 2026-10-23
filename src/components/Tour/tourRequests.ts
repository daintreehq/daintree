import { OPEN_TOUR_EVENT, type TourEventDetail } from "./tourEvents";
import { getTour, subscribeToTourRegistry } from "./tourRegistry";

/**
 * What asking for a tour came to. `started`: the dialog is playing it (or
 * already was). `unavailable`: nothing registered the tour in time, or no tour
 * host is mounted in this view. `failed`: it was registered but couldn't be
 * loaded. `superseded`: a later request won before this one opened. How the
 * run itself ends is a separate outcome, saved with the tour's progress.
 */
export type TourStartResult =
  /** `runId` is what the run's outcome is saved under, so a caller can tell it from an older run's. */
  | { status: "started"; tourId: string; runId: string }
  | { status: "unavailable"; tourId: string; reason: "not-registered" | "no-host" }
  | { status: "failed"; tourId: string; reason: string }
  | { status: "superseded"; tourId: string };

/**
 * How long a request waits for its tour to be registered. A plugin's tours
 * reach a view shortly after it loads, so a request made during activation
 * still finds them; a tour that never arrives is reported, not waited on.
 */
export const TOUR_REGISTRATION_TIMEOUT_MS = 5_000;

/**
 * Backstop for a host that took the request and never answered. Plugin tour
 * modules have their own 10s import deadline, and the two bounds together stay
 * inside the 30s a plugin's dispatch waits on the renderer.
 */
export const TOUR_ACK_TIMEOUT_MS = 15_000;

let nextRequestId = 0;
// Bumped by every request, so one still waiting for its tour to register can
// tell a newer one has come since.
let requestGeneration = 0;
// Every tour opened in this view, however it was asked for: a request that
// waited must not open over one the person chose meanwhile.
let opens = 0;
let countingOpens = false;
let hosts = 0;

function countOpens(): void {
  if (countingOpens) return;
  countingOpens = true;
  window.addEventListener(OPEN_TOUR_EVENT, () => {
    opens++;
  });
}
const pending = new Map<number, (result: TourStartResult) => void>();

/** Called by a mounted tour host; returns its unregister. */
export function registerTourHost(): () => void {
  hosts++;
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    hosts--;
  };
}

/** The host's answer to request `requestId`. Later answers for the same request are ignored. */
export function settleTourRequest(requestId: number, result: TourStartResult): void {
  const resolve = pending.get(requestId);
  if (!resolve) return;
  pending.delete(requestId);
  resolve(result);
}

function firstRegistered(candidates: readonly string[]): string | undefined {
  return candidates.find((id) => getTour(id) !== undefined);
}

/**
 * The first candidate to register within `timeoutMs`, `undefined` if none
 * does, or `null` when any tour is opened meanwhile — the person has moved on,
 * and a late registration must not open over what they chose.
 */
function waitForRegistration(
  candidates: readonly string[],
  timeoutMs: number
): Promise<string | undefined | null> {
  const found = firstRegistered(candidates);
  if (found !== undefined || timeoutMs <= 0) return Promise.resolve(found);
  return new Promise((resolve) => {
    const unsubscribe = subscribeToTourRegistry(() => {
      const id = firstRegistered(candidates);
      if (id === undefined) return;
      finish(id);
    });
    const onOpen = () => finish(null);
    window.addEventListener(OPEN_TOUR_EVENT, onOpen);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    function finish(id: string | undefined | null) {
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener(OPEN_TOUR_EVENT, onOpen);
      resolve(id);
    }
  });
}

/**
 * Open a tour and report whether it started. `candidates` are tried in order,
 * so a plugin's own local id can be preferred over the same string read as a
 * qualified id; the first one registered within the readiness bound is opened.
 */
export async function requestTour(
  candidates: readonly string[],
  options: { registrationTimeoutMs?: number } = {}
): Promise<TourStartResult> {
  const fallbackId = candidates[0] ?? "";
  countOpens();
  const generation = ++requestGeneration;
  const opensBefore = opens;
  const tourId = await waitForRegistration(
    candidates,
    options.registrationTimeoutMs ?? TOUR_REGISTRATION_TIMEOUT_MS
  );
  if (tourId === null || generation !== requestGeneration || opens !== opensBefore) {
    return { status: "superseded", tourId: tourId ?? fallbackId };
  }
  if (tourId === undefined) {
    return { status: "unavailable", tourId: fallbackId, reason: "not-registered" };
  }
  if (hosts === 0) return { status: "unavailable", tourId, reason: "no-host" };
  const requestId = ++nextRequestId;
  return new Promise<TourStartResult>((resolve) => {
    const timer = setTimeout(
      () =>
        settleTourRequest(requestId, {
          status: "failed",
          tourId,
          reason: "The tour host didn't answer",
        }),
      TOUR_ACK_TIMEOUT_MS
    );
    pending.set(requestId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    window.dispatchEvent(
      new CustomEvent<TourEventDetail>(OPEN_TOUR_EVENT, { detail: { tourId, requestId } })
    );
  });
}
