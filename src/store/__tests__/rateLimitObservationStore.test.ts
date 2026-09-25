// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RATE_LIMIT_OBSERVATION_TTL_MS,
  cleanupRateLimitObservationListeners,
  isRateLimitObservationLive,
  setupRateLimitObservationListeners,
  useRateLimitObservationStore,
} from "../rateLimitObservationStore";

let pushListener: ((payload: unknown) => void) | null = null;
const unsubscribe = vi.fn();

beforeEach(() => {
  pushListener = null;
  Object.defineProperty(window, "electron", {
    value: {
      events: {
        on: vi.fn((name: string, listener: (payload: unknown) => void) => {
          expect(name).toBe("agent:rate-limit-observed");
          pushListener = listener;
          return unsubscribe;
        }),
      },
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanupRateLimitObservationListeners();
  useRateLimitObservationStore.setState({ observedAtByTerminalId: {} });
  unsubscribe.mockClear();
});

describe("rateLimitObservationStore (#12797)", () => {
  it("records a pushed observation against its pane", () => {
    setupRateLimitObservationListeners();
    const now = Date.now();
    pushListener!({ terminalId: "t1", observedAt: now, timestamp: now });
    expect(useRateLimitObservationStore.getState().observedAtByTerminalId).toEqual({ t1: now });
  });

  it("drops malformed payloads", () => {
    setupRateLimitObservationListeners();
    pushListener!({ terminalId: "", observedAt: 1 });
    pushListener!({ terminalId: "t1", observedAt: Number.NaN });
    pushListener!(null);
    expect(useRateLimitObservationStore.getState().observedAtByTerminalId).toEqual({});
  });

  it("prunes expired entries on write so the map stays bounded", () => {
    const { recordObservation } = useRateLimitObservationStore.getState();
    recordObservation("old", 0, 0);
    recordObservation("new", RATE_LIMIT_OBSERVATION_TTL_MS, RATE_LIMIT_OBSERVATION_TTL_MS);
    expect(Object.keys(useRateLimitObservationStore.getState().observedAtByTerminalId)).toEqual([
      "new",
    ]);
  });

  it("never lets an older observation overwrite a newer one", () => {
    const { recordObservation } = useRateLimitObservationStore.getState();
    recordObservation("t1", 200, 200);
    recordObservation("t1", 100, 200);
    expect(useRateLimitObservationStore.getState().observedAtByTerminalId.t1).toBe(200);
  });

  it("expires after the retention window", () => {
    expect(isRateLimitObservationLive(undefined, 0)).toBe(false);
    expect(isRateLimitObservationLive(0, RATE_LIMIT_OBSERVATION_TTL_MS - 1)).toBe(true);
    expect(isRateLimitObservationLive(0, RATE_LIMIT_OBSERVATION_TTL_MS)).toBe(false);
  });

  it("subscribes once and unsubscribes on cleanup", () => {
    const cleanup = setupRateLimitObservationListeners();
    setupRateLimitObservationListeners();
    expect(window.electron.events.on).toHaveBeenCalledTimes(1);
    cleanup();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
