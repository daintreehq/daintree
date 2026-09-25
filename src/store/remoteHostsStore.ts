import { create } from "zustand";
import type {
  HostListEntry,
  OperationId,
  OperationOutcome,
  OperationProgress,
} from "@shared/types/remoteHosts";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";

export interface HostInstallState {
  sshTarget: string;
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
  trackInstall: (opId: OperationId, sshTarget: string) => void;
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

  trackInstall: (opId, sshTarget) =>
    set((state) => ({
      installs: { ...state.installs, [opId]: { sshTarget, progress: null, outcome: null } },
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
                sshTarget: current?.sshTarget ?? event.sshTarget,
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
                sshTarget: current?.sshTarget ?? event.sshTarget,
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
