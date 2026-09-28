import { create } from "zustand";
import type {
  HostConnection,
  HostListEntry,
  OperationId,
  OperationOutcome,
  OperationProgress,
} from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";

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
  trackInstall: (opId: OperationId, connection: HostConnection) => void;
  applyEvent: (event: RemoteHostsEvent) => void;
  reset: () => void;
}

function initial(): Pick<RemoteHostsStoreState, "hosts" | "loaded" | "loadError" | "installs"> {
  return { hosts: [], loaded: false, loadError: null, installs: {} };
}

/** The Settings → Hosts view of this machine's host list. Device-owned, never per project. */
export const useRemoteHostsStore = create<RemoteHostsStoreState>((set) => ({
  ...initial(),

  setHosts: (hosts) => set({ hosts, loaded: true, loadError: null }),

  setLoadError: (loadError) => set({ loadError, loaded: true }),

  trackInstall: (opId, connection) =>
    set((state) => ({
      installs: { ...state.installs, [opId]: { connection, progress: null, outcome: null } },
    })),

  applyEvent: (event) =>
    set((state) => {
      switch (event.type) {
        case "hosts-changed":
          return { hosts: event.hosts, loaded: true, loadError: null };
        case "connection-changed": {
          const hosts = state.hosts.map((entry) =>
            entry.descriptor.id === event.hostId
              ? { ...entry, connection: event.connection }
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

  reset: () => set(initial()),
}));
