import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import type { TourPlayer } from "./TourPlayer";
import type { TourPlayerState } from "./tourTypes";

export const TourPlayerContext = createContext<TourPlayer | null>(null);

export function useTourPlayer(): TourPlayer {
  const player = useContext(TourPlayerContext);
  if (!player) throw new Error("useTourPlayer must be used inside a TourPlayerContext");
  return player;
}

export function useTourPlayerState(player: TourPlayer): TourPlayerState {
  return useSyncExternalStore(player.subscribe, player.getState);
}

/** Current timeline position. Re-renders every frame while playing — use sparingly. */
export function useTourTime(): number {
  const player = useTourPlayer();
  return useSyncExternalStore(player.subscribeTime, player.getTime);
}

/**
 * True once the timeline has passed a cue (plus an optional offset in seconds).
 * Only flips on the boundary, so a scene re-renders a handful of times per
 * chapter rather than every frame — the motion itself is CSS transitions.
 * An unknown cue never fires, which keeps a scene inert rather than broken.
 */
export function useCue(id: string, offset = 0): boolean {
  const player = useTourPlayer();
  const subscribe = useCallback(
    (listener: () => void) => {
      const offTime = player.subscribeTime(listener);
      const offState = player.subscribe(listener);
      return () => {
        offTime();
        offState();
      };
    },
    [player]
  );
  const getSnapshot = useCallback(() => {
    const at = player.timing.cues[id];
    return at !== undefined && player.getTime() >= at + offset;
  }, [player, id, offset]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Seconds elapsed since a cue fired, or null before it. Per-frame — for typing only. */
export function useSecondsSinceCue(id: string): number | null {
  const player = useTourPlayer();
  const time = useTourTime();
  const at = player.timing.cues[id];
  return at === undefined || time < at ? null : time - at;
}

export interface TimelinePoint {
  cue: string;
  offset?: number;
}

/**
 * Index of the most recent point the timeline has passed (by time, not array
 * order), or -1 before the first. Re-renders only when that index changes.
 * `points` must be referentially stable — declare it at module scope.
 */
export function useTimelineIndex(points: readonly TimelinePoint[]): number {
  const player = useTourPlayer();
  const subscribe = useCallback(
    (listener: () => void) => {
      const offTime = player.subscribeTime(listener);
      const offState = player.subscribe(listener);
      return () => {
        offTime();
        offState();
      };
    },
    [player]
  );
  const getSnapshot = useCallback(() => {
    const time = player.getTime();
    let best = -1;
    let bestAt = -Infinity;
    points.forEach((point, i) => {
      const cue = player.timing.cues[point.cue];
      if (cue === undefined) return;
      const at = cue + (point.offset ?? 0);
      if (time >= at && at >= bestAt) {
        best = i;
        bestAt = at;
      }
    });
    return best;
  }, [player, points]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
