import { create } from "zustand";
import type {
  HostConnection,
  HostListEntry,
  HostMetricsSummary,
  OperationId,
  OperationOutcome,
  OperationProgress,
} from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import { formatErrorMessage } from "@shared/utils/errorMessage";

export interface HostInstallState {
  connection: HostConnection;
  progress: OperationProgress | null;
  /** Null while running. */
  outcome: OperationOutcome | null;
}

interface RemoteHostsStoreState {
  hosts: HostListEntry[];
  loaded: boolean;
  loadError: string | null;
  /** Installs and updates this client started, by operation id. */
  installs: Record<OperationId, HostInstallState>;

  setHosts: (hosts: HostListEntry[]) => void;
  setLoadError: (message: string | null) => void;
  /**
   * Reads the whole list with `read`. Its answer, or its failure, is dropped
   * when a fuller list landed after it was asked for: a read made before
   * Remote Hosts started can answer empty after the event that listed them.
   */
  loadHosts: (read: () => Promise<HostListEntry[]>) => Promise<void>;
  trackInstall: (opId: OperationId, connection: HostConnection) => void;
  applyEvent: (event: RemoteHostsEvent) => void;
  /** A host's latest report, as host metrics pushes it. */
  applySummary: (summary: HostMetricsSummary) => void;
  reset: () => void;
}

function initial(): Pick<RemoteHostsStoreState, "hosts" | "loaded" | "loadError" | "installs"> {
  return { hosts: [], loaded: false, loadError: null, installs: {} };
}

/** Bumped by every whole list, from any source, and by a reset; never goes back. */
let listEpoch = 0;

/** The Settings → Hosts view of this machine's host list. Device-owned, never per project. */
export const useRemoteHostsStore = create<RemoteHostsStoreState>((set) => ({
  ...initial(),

  setHosts: (hosts) => {
    listEpoch += 1;
    set({ hosts, loaded: true, loadError: null });
  },

  setLoadError: (loadError) => set({ loadError, loaded: true }),

  loadHosts: async (read) => {
    const askedAt = ++listEpoch;
    try {
      const hosts = await read();
      if (askedAt === listEpoch) set({ hosts, loaded: true, loadError: null });
    } catch (error) {
      if (askedAt === listEpoch) {
        set({ loadError: formatErrorMessage(error, "Couldn't load the host list"), loaded: true });
      }
    }
  },

  trackInstall: (opId, connection) =>
    set((state) => ({
      installs: { ...state.installs, [opId]: { connection, progress: null, outcome: null } },
    })),

  applyEvent: (event) =>
    set((state) => {
      switch (event.type) {
        case "hosts-changed":
          listEpoch += 1;
          return { hosts: event.hosts, loaded: true, loadError: null };
        case "connection-changed": {
          const up = event.connection.status === "connected";
          const hosts = state.hosts.map((entry) =>
            entry.descriptor.id === event.hostId
              ? // A summary from before a drop says nothing about the host now (as the host list has it).
                { ...entry, connection: event.connection, summary: up ? entry.summary : null }
              : entry
          );
          return { hosts };
        }
        case "install-progress": {
          const current = state.installs[event.opId];
          return {
            installs: {
              ...state.installs,
              [event.opId]: {
                connection: current?.connection ?? event.connection,
                progress: event.progress,
                outcome: current?.outcome ?? null,
              },
            },
          };
        }
        case "install-settled": {
          const current = state.installs[event.opId];
          return {
            installs: {
              ...state.installs,
              [event.opId]: {
                connection: current?.connection ?? event.connection,
                progress: current?.progress ?? null,
                outcome: event.outcome,
              },
            },
          };
        }
        default:
          return {};
      }
    }),

  applySummary: (summary) =>
    set((state) => {
      if (!state.hosts.some((entry) => entry.descriptor.id === summary.hostId)) return {};
      return {
        hosts: state.hosts.map((entry) =>
          entry.descriptor.id === summary.hostId ? { ...entry, summary } : entry
        ),
      };
    }),

  reset: () => {
    listEpoch += 1;
    set(initial());
  },
}));
