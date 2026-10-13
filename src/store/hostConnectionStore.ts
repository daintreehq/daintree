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
  /**
   * Round trip to the host, smoothed across pings so one slow reply doesn't
   * jump the reading; null until a ping answers on the current link.
   */
  latencyMs: number | null;
  /** The round trip is high enough that typing visibly trails the keys; held until it clearly recovers. */
  latencySlow: boolean;
  /** The last reply that came in well above the smoothed reading, awaiting a second to confirm it. */
  latencyRise: number | null;

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
  latencyMs: null,
  latencySlow: false,
  latencyRise: null,
} as const;

/** Weight of each new ping in the smoothed round trip: a few pings to settle. */
const LATENCY_SMOOTHING = 0.25;
/** A reply this far above the reading is a rise, not noise, once a second one agrees. */
const LATENCY_RISE_FACTOR = 1.5;
/** Round trip past which typing visibly trails the keys. */
export const SLOW_LINK_MS = 150;
/** The slow reading lets go only below this, so a link hovering at the line doesn't flicker. */
const SLOW_LINK_RELEASE_MS = 120;

interface LatencyReading {
  latencyMs: number | null;
  latencySlow: boolean;
  latencyRise: number | null;
}

/**
 * One ping into the reading. A reply far above it is held rather than folded
 * in: a second high reply confirms the link got slower and the reading moves
 * straight to the lesser of the two, while a normal reply drops the spike as
 * if it never came, so one 600 ms hiccup neither creeps in nor lingers.
 */
function nextLatency(prev: LatencyReading, sample: number): LatencyReading {
  let latencyMs: number;
  let latencyRise: number | null = null;
  if (prev.latencyMs === null) {
    latencyMs = sample;
  } else if (sample > prev.latencyMs * LATENCY_RISE_FACTOR) {
    if (prev.latencyRise !== null) {
      latencyMs = Math.min(prev.latencyRise, sample);
    } else {
      latencyMs = prev.latencyMs;
      latencyRise = sample;
    }
  } else {
    latencyMs = prev.latencyMs + LATENCY_SMOOTHING * (sample - prev.latencyMs);
  }
  const latencySlow = prev.latencySlow
    ? latencyMs >= SLOW_LINK_RELEASE_MS
    : latencyMs >= SLOW_LINK_MS;
  return { latencyMs, latencySlow, latencyRise };
}

export const useHostConnectionStore = create<HostConnectionStoreState>((set, get) => ({
  ...INITIAL,

  bindHost: (hostId, hostName) => set({ hostId, hostName }),

  setHostName: (hostName) => set({ hostName }),

  applyConnection: (connection, now = Date.now()) =>
    set((state) => {
      if (connection.status === "connected") {
        // The link re-reports its state for other reasons (going quiet) with the
        // last ping still on it; only a reply with a new stamp is a new sample.
        const sample = connection.rttMs;
        const prevStamp =
          state.connection?.status === "connected" ? state.connection.rttSampledAt : undefined;
        const repeat =
          state.latencyMs !== null &&
          connection.rttSampledAt !== undefined &&
          connection.rttSampledAt === prevStamp;
        const reading = sample === null || repeat ? {} : nextLatency(state, sample);
        return { connection, everConnected: true, lastSeenAt: null, ...reading };
      }
      // The link's own record of its last received frame is the truth; this
      // view noticing the drop is only a stand-in until one is reported.
      const reported = connection.status === "unreachable" ? connection.lastSeenAt : null;
      const wasConnected = state.connection?.status === "connected";
      const lastSeenAt = reported ?? (wasConnected ? now : state.lastSeenAt);
      // A new link starts its reading afresh.
      return { connection, lastSeenAt, latencyMs: null, latencySlow: false, latencyRise: null };
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
