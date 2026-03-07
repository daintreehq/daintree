import { create } from "zustand";
import type { CliAvailability } from "@shared/types";
import { cliAvailabilityClient } from "@/clients";
import { getAgentIds } from "@/config/agents";
import { isElectronAvailable } from "@/hooks/useElectron";

interface CliAvailabilityState {
  availability: CliAvailability;
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  isInitialized: boolean;
}

interface CliAvailabilityActions {
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
}

type CliAvailabilityStore = CliAvailabilityState & CliAvailabilityActions;

function defaultAvailability(): CliAvailability {
  return Object.fromEntries(getAgentIds().map((id) => [id, false])) as CliAvailability;
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

  initialize: () => {
    if (get().isInitialized) return Promise.resolve();
    if (initPromise) return initPromise;

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
          set({ availability, isLoading: false, isInitialized: true });
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

  refresh: () => {
    // If init is still in-flight, join it rather than firing a duplicate IPC call.
    if (initPromise) return initPromise;
    if (refreshPromise) return refreshPromise;

    if (!isElectronAvailable()) return Promise.resolve();

    const myEpoch = epoch;
    refreshPromise = (async () => {
      try {
        set({ isRefreshing: true, error: null });
        const availability = await cliAvailabilityClient.refresh();
        if (epoch === myEpoch) {
          set({ availability, isRefreshing: false, error: null });
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
  });
}
