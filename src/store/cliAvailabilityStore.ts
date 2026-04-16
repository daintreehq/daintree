import { create } from "zustand";
import type { CliAvailability, AgentAvailabilityState } from "@shared/types";
import { cliAvailabilityClient } from "@/clients";
import { getAgentIds } from "@/config/agents";
import { isElectronAvailable } from "@/hooks/useElectron";

interface CliAvailabilityState {
  availability: CliAvailability;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  isInitialized: boolean;
  lastCheckedAt: number | null;
  /**
   * True once a real availability result has been applied (from cache or IPC).
   * Distinct from `isInitialized`, which flips after the first IPC call
   * regardless of outcome. Consumers that hide UI during the initial
   * detection race should watch this instead.
   */
  hasRealData: boolean;
}

interface CliAvailabilityActions {
  initialize: () => Promise<void>;
  /**
   * Probe CLI availability again. Pass `force: true` for explicit user
   * gestures (e.g. the Refresh button in AgentSettings) so the 30s throttle
   * — which exists to absorb passive triggers like tray-open and focus —
   * does not swallow the request.
   */
  refresh: (force?: boolean) => Promise<void>;
}

type CliAvailabilityStore = CliAvailabilityState & CliAvailabilityActions;

function defaultAvailability(): CliAvailability {
  return Object.fromEntries(getAgentIds().map((id) => [id, "missing"])) as CliAvailability;
}

const CACHE_STORAGE_KEY = "daintree:cliAvailability:v1";
// Stale cache is still shown but triggers a synchronous refresh on init.
const CACHE_STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h
// Short-window throttle for mid-session refreshes (tray-open, visibility,
// focus). Keeps rapid triggers from spamming IPC; longer-term staleness is
// governed by CACHE_STALE_AFTER_MS during initialize.
const REFRESH_THROTTLE_MS = 30 * 1000;

const VALID_STATES: ReadonlySet<AgentAvailabilityState> = new Set<AgentAvailabilityState>([
  "ready",
  "installed",
  "missing",
]);

interface PersistedCache {
  availability: CliAvailability;
  lastCheckedAt: number;
}

function loadCache(): PersistedCache | null {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("availability" in parsed) ||
      !("lastCheckedAt" in parsed)
    ) {
      return null;
    }
    const availability = (parsed as PersistedCache).availability;
    const lastCheckedAt = (parsed as PersistedCache).lastCheckedAt;
    if (!availability || typeof availability !== "object" || typeof lastCheckedAt !== "number") {
      return null;
    }
    // Intersect cached agents with the currently registered set so that
    // deprecated / renamed agents don't leak back in.
    const current = getAgentIds();
    const sanitized: CliAvailability = {} as CliAvailability;
    let anyValid = false;
    for (const id of current) {
      const value = (availability as Record<string, unknown>)[id];
      if (typeof value === "string" && VALID_STATES.has(value as AgentAvailabilityState)) {
        (sanitized as Record<string, AgentAvailabilityState>)[id] = value as AgentAvailabilityState;
        anyValid = true;
      } else {
        (sanitized as Record<string, AgentAvailabilityState>)[id] = "missing";
      }
    }
    if (!anyValid) return null;
    return { availability: sanitized, lastCheckedAt };
  } catch {
    return null;
  }
}

function saveCache(availability: CliAvailability, lastCheckedAt: number) {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify({ availability, lastCheckedAt }));
  } catch {
    // Quota or access issues — cache is best-effort.
  }
}

let epoch = 0;
let initPromise: Promise<void> | null = null;
let refreshPromise: Promise<void> | null = null;

export const useCliAvailabilityStore = create<CliAvailabilityStore>()((set, get) => ({
  availability: defaultAvailability(),
  isLoading: true,
  isRefreshing: false,
  error: null,
  isInitialized: false,
  lastCheckedAt: null,
  hasRealData: false,

  initialize: () => {
    if (get().isInitialized) return Promise.resolve();
    if (initPromise) return initPromise;

    // Hydrate from localStorage before kicking off the IPC call. This kills
    // the first-paint toolbar flicker: cached pins render immediately and
    // only reconcile when the fresh result lands.
    //
    // Deliberately omit `lastCheckedAt` so the 30s refresh throttle only
    // kicks in after a successful *live* probe this session. Persisting
    // the cached timestamp would mute the first mid-session refresh after
    // a relaunch (and, with clock skew, could suppress refreshes
    // indefinitely).
    const cached = loadCache();
    if (cached) {
      set({
        availability: cached.availability,
        hasRealData: true,
      });
    }

    if (!isElectronAvailable()) {
      set({ isLoading: false, isInitialized: true });
      return Promise.resolve();
    }

    const myEpoch = epoch;
    initPromise = (async () => {
      try {
        set({ isLoading: true, error: null });
        const availability = await cliAvailabilityClient.refresh();
        if (epoch === myEpoch) {
          const now = Date.now();
          saveCache(availability, now);
          set({
            availability,
            isLoading: false,
            isInitialized: true,
            lastCheckedAt: now,
            hasRealData: true,
          });
        }
      } catch (e) {
        if (epoch === myEpoch) {
          set({
            error: e instanceof Error ? e.message : "Failed to check CLI availability",
            isLoading: false,
            isInitialized: true,
          });
        }
      } finally {
        if (epoch === myEpoch) {
          initPromise = null;
        }
      }
    })();

    return initPromise;
  },

  refresh: (force = false) => {
    // If init is still in-flight, join it rather than firing a duplicate IPC call.
    if (initPromise) return initPromise;

    // Skip if the last successful probe landed within the throttle window.
    // Failed refreshes do not set lastCheckedAt, so they stay retryable.
    // Explicit user gestures pass `force: true` to bypass the window.
    if (!force) {
      const { lastCheckedAt } = get();
      if (lastCheckedAt !== null && Date.now() - lastCheckedAt < REFRESH_THROTTLE_MS) {
        return Promise.resolve();
      }
    }

    if (refreshPromise) return refreshPromise;

    if (!isElectronAvailable()) return Promise.resolve();

    const myEpoch = epoch;
    refreshPromise = (async () => {
      try {
        set({ isRefreshing: true, error: null });
        const availability = await cliAvailabilityClient.refresh();
        if (epoch === myEpoch) {
          const now = Date.now();
          saveCache(availability, now);
          set({
            availability,
            isRefreshing: false,
            error: null,
            lastCheckedAt: now,
            hasRealData: true,
          });
        }
      } catch (e) {
        if (epoch === myEpoch) {
          set({
            error: e instanceof Error ? e.message : "Failed to refresh CLI availability",
            isRefreshing: false,
          });
        }
        throw e;
      } finally {
        if (epoch === myEpoch) {
          refreshPromise = null;
        }
      }
    })();

    return refreshPromise;
  },
}));

export function cleanupCliAvailabilityStore() {
  epoch++;
  initPromise = null;
  refreshPromise = null;
  useCliAvailabilityStore.setState({
    availability: defaultAvailability(),
    isLoading: true,
    isRefreshing: false,
    error: null,
    isInitialized: false,
    lastCheckedAt: null,
    hasRealData: false,
  });
}

export function isCliAvailabilityCacheStale(lastCheckedAt: number | null): boolean {
  if (lastCheckedAt === null) return true;
  return Date.now() - lastCheckedAt > CACHE_STALE_AFTER_MS;
}
