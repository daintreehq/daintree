import type { HostMetricsSummary } from "../../../shared/types/remoteHosts.js";
import { elapsedSince, type ElapsedStamp } from "../link/elapsed.js";
import type { SummaryFrameTiming } from "../link/messages.js";
import { DEFAULT_PING_INTERVAL_MS } from "../link/session.js";
import { HOST_METRICS_INTERVAL_MS } from "./sampler.js";

/** Three missed samples; past this the figures describe a machine that may have changed. */
export const HOST_LOAD_STALE_MS = 3 * HOST_METRICS_INTERVAL_MS;

/**
 * How high a frame's age bound may read before its sample is stale. The bound
 * runs from when the ping the frame names left this Shell, and the host names
 * the newest ping it had, which can have left up to a ping interval (and its
 * trip) before the host posted: a sample within {@link HOST_LOAD_STALE_MS} can
 * bound that much higher without being any older. A fresh sample is still at
 * most this old by this Shell's clocks alone, though from here a frame held in
 * transit looks the same as that slack; one this Shell knows is older than the
 * limit is stale whatever its bound says.
 */
export const HOST_LOAD_BOUND_STALE_MS = HOST_LOAD_STALE_MS + DEFAULT_PING_INTERVAL_MS;

/**
 * When this Shell came by a summary, on its own clocks, and what the frame
 * proved about the sample's age then (#14462). Every age here is measured on
 * one machine's clocks, never by subtracting one machine's time from another's.
 */
export interface SummaryReceipt {
  /** This Shell's wall time at receipt: provenance, never subtracted from the host's. */
  receivedAt: number;
  at: ElapsedStamp;
  /** The sample's age by the host's own clocks when it posted the frame: at least this old. */
  hostAgeMs: number | null;
  /** At most this old at receipt; null when the frame didn't let it be bounded. */
  maxAgeMs: number | null;
  /** The frame carried timing: a host that can bound its age, so its timestamp is never the fallback. */
  timed: boolean;
}

/**
 * A frame's age is at most the host's own age for its sample plus everything
 * since the ping it names left here: the host had that ping before it posted,
 * so the frame's whole trip, queues included, falls inside that interval.
 */
export function receiveSummary(
  timing: SummaryFrameTiming | undefined,
  pingSentAt: (nonce: number) => ElapsedStamp | null,
  at: ElapsedStamp
): SummaryReceipt {
  const hostAgeMs = timing?.sampleAgeMs ?? null;
  const ping = timing?.afterPing != null ? pingSentAt(timing.afterPing) : null;
  return {
    receivedAt: at.wall,
    at,
    hostAgeMs,
    maxAgeMs: hostAgeMs !== null && ping ? hostAgeMs + elapsedSince(ping, at) : null,
    timed: timing !== undefined,
  };
}

export type SampleStaleReason = "age-limit" | "clock-uncertain";

export interface SampleFreshness {
  /** How old the sample is at most; null when that can't be said. */
  ageMs: number | null;
  stale: boolean;
  staleReason: SampleStaleReason | null;
  receivedAt: number | null;
}

/**
 * Whether a sample can be trusted now. A bounded age decides it, against the
 * limit that allows for the ping it is taken from, unless the host and this
 * Shell already know the sample is older than the limit itself. Without a
 * bound, a sample known to be too old is stale for its age. A host that times its frames but couldn't bound this
 * one, as before any ping reached it or after a delay longer than the pings
 * remembered, is clock-uncertain. Only an older host's timestamp is left as
 * a fallback, fresh when it is near this Shell's clock as it always was, and
 * clock-uncertain when it isn't: an old reading and two clocks that disagree
 * look the same from here.
 */
export function sampleFreshness(
  summary: HostMetricsSummary,
  receipt: SummaryReceipt | null,
  now: ElapsedStamp
): SampleFreshness {
  const receivedAt = receipt?.receivedAt ?? null;
  const since = receipt ? elapsedSince(receipt.at, now) : 0;
  const atLeast = (receipt?.hostAgeMs ?? 0) + since;
  if (receipt?.maxAgeMs != null) {
    const ageMs = receipt.maxAgeMs + since;
    const stale = ageMs > HOST_LOAD_BOUND_STALE_MS || atLeast > HOST_LOAD_STALE_MS;
    return { ageMs, stale, staleReason: stale ? "age-limit" : null, receivedAt };
  }
  if (atLeast > HOST_LOAD_STALE_MS) {
    return { ageMs: null, stale: true, staleReason: "age-limit", receivedAt };
  }
  const wallAge = Number.isFinite(summary.sampledAt) ? now.wall - summary.sampledAt : Number.NaN;
  if (
    receipt?.timed !== true &&
    Number.isFinite(wallAge) &&
    Math.abs(wallAge) <= HOST_LOAD_STALE_MS
  ) {
    return {
      ageMs: Math.max(0, wallAge, atLeast),
      stale: false,
      staleReason: null,
      receivedAt,
    };
  }
  return { ageMs: null, stale: true, staleReason: "clock-uncertain", receivedAt };
}
