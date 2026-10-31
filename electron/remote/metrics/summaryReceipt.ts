import type { HostMetricsSummary } from "../../../shared/types/remoteHosts.js";
import { elapsedSince, type ElapsedStamp } from "../link/elapsed.js";
import type { SummaryFrameTiming } from "../link/messages.js";
import { HOST_METRICS_INTERVAL_MS } from "./sampler.js";

/** Three missed samples; past this the figures describe a machine that may have changed. */
export const HOST_LOAD_STALE_MS = 3 * HOST_METRICS_INTERVAL_MS;

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

/** `earlier-link`: the sample came on a link that has since closed (#15736); `sampleFreshness` never says it. */
export type SampleStaleReason = "age-limit" | "clock-uncertain" | "earlier-link";

export interface SampleFreshness {
  /** How old the sample is at most; null when that can't be said. */
  ageMs: number | null;
  stale: boolean;
  staleReason: SampleStaleReason | null;
  receivedAt: number | null;
}

/**
 * Whether a sample can be trusted now. A bounded age decides it outright.
 * Without one, a sample the host or this Shell already knows is too old is
 * stale for its age. A host that times its frames but couldn't bound this
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
  if (receipt?.maxAgeMs != null) {
    const ageMs = receipt.maxAgeMs + since;
    const stale = ageMs > HOST_LOAD_STALE_MS;
    return { ageMs, stale, staleReason: stale ? "age-limit" : null, receivedAt };
  }
  const atLeast = (receipt?.hostAgeMs ?? 0) + since;
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
