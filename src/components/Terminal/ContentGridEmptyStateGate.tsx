import { lazyWhenLoaded } from "@/lib/lazyWithPreload";

/**
 * The empty grid's launcher, loaded only when a grid is actually empty. A
 * project that restores its panels never draws it, so a cold boot doesn't load
 * it, its pulse strip or its tour card. Draws nothing for the moment its chunk
 * takes on a first empty canvas, which is under the 400ms a wait may stay
 * silent for.
 */
export const ContentGridEmptyStateGate = lazyWhenLoaded(
  () => import("./ContentGridEmptyState"),
  (m) => m.ContentGridEmptyState
);
