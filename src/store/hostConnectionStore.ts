import { create } from "zustand";
import type { HostConnectionState, HostId } from "@shared/types/remoteHosts";

/**
 * The link between this view and the host it runs on, as last observed. Only
 * a remote view ever leaves the initial state: a local view has no host link,
 * and nothing here renders or gates for it.
 */
interface HostConnectionStoreState {
  /** The remote host this view is bound to; null for a view that runs on this machine. */
  hostId: HostId | null;
  hostName: string | null;
  connection: HostConnectionState | null;
  /** The link was up at least once for this view, so a drop is a loss, not a first dial. */
  everConnected: boolean;
  /** Epoch ms the link was last seen up. Only meaningful while it is not. */
  lastSeenAt: number | null;
  /** Mutations whose answer was lost with the link, being checked with the host. */
  checking: number;

  bindHost: (hostId: HostId, hostName: string | null) => void;
  setHostName: (hostName: string | null) => void;
  applyConnection: (connection: HostConnectionState, now?: number) => void;
  beginCheck: () => () => void;
  reset: () => void;
}

const INITIAL = {
  hostId: null,
  hostName: null,
  connection: null,
  everConnected: false,
  lastSeenAt: null,
  checking: 0,
} as const;

export const useHostConnectionStore = create<HostConnectionStoreState>((set, get) => ({
  ...INITIAL,

  bindHost: (hostId, hostName) => set({ hostId, hostName }),

  setHostName: (hostName) => set({ hostName }),

  applyConnection: (connection, now = Date.now()) =>
    set((state) => {
      if (connection.status === "connected") {
        return { connection, everConnected: true, lastSeenAt: null };
      }
      // The link's own record of its last received frame is the truth; this
      // view noticing the drop is only a stand-in until one is reported.
      const reported = connection.status === "unreachable" ? connection.lastSeenAt : null;
      const wasConnected = state.connection?.status === "connected";
      const lastSeenAt = reported ?? (wasConnected ? now : state.lastSeenAt);
      return { connection, lastSeenAt };
    }),

  beginCheck: () => {
    set((state) => ({ checking: state.checking + 1 }));
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      set({ checking: Math.max(0, get().checking - 1) });
    };
  },

  reset: () => set({ ...INITIAL }),
}));

export type HostBannerVariant =
  "reconnecting" | "connecting" | "unreachable" | "version-mismatch" | "disconnected" | "checking";

type BannerInputs = Pick<
  HostConnectionStoreState,
  "hostId" | "connection" | "everConnected" | "checking"
>;

/**
 * Which connection banner this view shows, or null for none. Always null for a
 * view that runs on this machine.
 */
export function selectHostBannerVariant(state: BannerInputs): HostBannerVariant | null {
  if (state.hostId === null || state.connection === null) return null;
  switch (state.connection.status) {
    case "connected":
      return state.checking > 0 ? "checking" : null;
    case "connecting":
      return state.everConnected ? "reconnecting" : "connecting";
    case "unreachable":
      return "unreachable";
    case "version-mismatch":
      return "version-mismatch";
    case "disconnected":
      return "disconnected";
    default:
      return null;
  }
}

/** Whether calls can reach this view's host right now. A local view always can. */
export function isHostLinkUp(state: Pick<HostConnectionStoreState, "hostId" | "connection">) {
  return state.hostId === null || state.connection?.status === "connected";
}
