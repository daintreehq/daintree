import { create } from "zustand";
import type { AgentRateLimitObservedPayload } from "@shared/types/ipc/agent";

/**
 * How long a pane keeps its "rate limit seen" chip. A retention window, not the
 * provider's reset time — nothing here parses when the limit lifts.
 */
export const RATE_LIMIT_OBSERVATION_TTL_MS = 15 * 60_000;

interface RateLimitObservationState {
  /**
   * When each pane last showed an agent rate-limit banner (#12797), keyed by
   * terminal. Ephemeral: never persisted, and expired entries are dropped on
   * every write so the map stays bounded by panes seen in the last window.
   */
  observedAtByTerminalId: Record<string, number>;
  recordObservation: (terminalId: string, observedAt: number, now?: number) => void;
}

export const useRateLimitObservationStore = create<RateLimitObservationState>((set) => ({
  observedAtByTerminalId: {},
  recordObservation: (terminalId, observedAt, now = Date.now()) =>
    set((state) => {
      const next: Record<string, number> = {};
      for (const [id, at] of Object.entries(state.observedAtByTerminalId)) {
        if (at + RATE_LIMIT_OBSERVATION_TTL_MS > now) next[id] = at;
      }
      const previous = next[terminalId];
      if (previous === undefined || observedAt > previous) next[terminalId] = observedAt;
      return { observedAtByTerminalId: next };
    }),
}));

export function isRateLimitObservationLive(observedAt: number | undefined, now: number): boolean {
  return observedAt !== undefined && observedAt + RATE_LIMIT_OBSERVATION_TTL_MS > now;
}

function isValidPayload(payload: unknown): payload is AgentRateLimitObservedPayload {
  if (!payload || typeof payload !== "object") return false;
  if (!("terminalId" in payload) || !("observedAt" in payload)) return false;
  return (
    typeof payload.terminalId === "string" &&
    payload.terminalId.length > 0 &&
    typeof payload.observedAt === "number" &&
    Number.isFinite(payload.observedAt)
  );
}

let observationsUnsubscribe: (() => void) | null = null;

/** Push-only: an observation made before this view existed is not replayed. */
export function setupRateLimitObservationListeners(): () => void {
  if (typeof window === "undefined") return () => {};
  if (observationsUnsubscribe !== null) return cleanupRateLimitObservationListeners;

  observationsUnsubscribe = window.electron.events.on("agent:rate-limit-observed", (payload) => {
    if (!isValidPayload(payload)) return;
    useRateLimitObservationStore
      .getState()
      .recordObservation(payload.terminalId, payload.observedAt);
  });

  return cleanupRateLimitObservationListeners;
}

export function cleanupRateLimitObservationListeners(): void {
  if (observationsUnsubscribe) {
    observationsUnsubscribe();
    observationsUnsubscribe = null;
  }
}
