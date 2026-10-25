import { describe, expect, it } from "vitest";
import type { HostMetricsSummary } from "../../../../shared/types/remoteHosts.js";
import { elapsedSince, type ElapsedStamp } from "../../link/elapsed.js";
import {
  HOST_LOAD_STALE_MS,
  receiveSummary,
  sampleFreshness,
  type SummaryReceipt,
} from "../summaryReceipt.js";

const at = (wall: number, mono = wall): ElapsedStamp => ({ wall, mono });

function summary(sampledAt: number): HostMetricsSummary {
  return { sampledAt } as HostMetricsSummary;
}

/** Pings this Shell sent, by nonce. */
const pings = new Map<number, ElapsedStamp>([
  [3, at(10_000)],
  [4, at(15_000)],
]);
const pingSentAt = (nonce: number) => pings.get(nonce) ?? null;

/** A frame from an older host, which times nothing. */
const legacy = (received = at(1_000)): SummaryReceipt => ({
  receivedAt: received.wall,
  at: received,
  hostAgeMs: null,
  maxAgeMs: null,
  timed: false,
});

describe("elapsedSince", () => {
  it("counts sleep, which the monotonic clock misses, through the wall clock", () => {
    expect(elapsedSince(at(0, 0), at(60_000, 1_000))).toBe(60_000);
  });

  it("ignores a wall clock stepped back, through the monotonic clock", () => {
    expect(elapsedSince(at(100_000, 0), at(40_000, 2_000))).toBe(2_000);
  });

  it("is never negative", () => {
    expect(elapsedSince(at(5, 5), at(1, 1))).toBe(0);
  });
});

describe("receiveSummary (#14462)", () => {
  it("bounds a frame's age by the host's own age plus the time since the ping it followed", () => {
    const receipt = receiveSummary({ sampleAgeMs: 800, afterPing: 4 }, pingSentAt, at(15_300));
    expect(receipt).toEqual({
      receivedAt: 15_300,
      at: at(15_300),
      hostAgeMs: 800,
      maxAgeMs: 1_100,
      timed: true,
    });
  });

  it("counts a frame's delay in transit against it", () => {
    // Posted a moment after ping 3 reached the host, but held up on the way for 20s.
    const receipt = receiveSummary({ sampleAgeMs: 100, afterPing: 3 }, pingSentAt, at(30_100));
    expect(receipt.maxAgeMs).toBe(20_200);
  });

  it("leaves the age unbounded for a ping it never sent or has forgotten", () => {
    const receipt = receiveSummary({ sampleAgeMs: 100, afterPing: 99 }, pingSentAt, at(16_000));
    expect(receipt).toMatchObject({ hostAgeMs: 100, maxAgeMs: null, timed: true });
  });

  it("never takes a host age it couldn't say for zero", () => {
    const receipt = receiveSummary({ sampleAgeMs: null, afterPing: 4 }, pingSentAt, at(15_300));
    expect(receipt).toMatchObject({ hostAgeMs: null, maxAgeMs: null, timed: true });
  });

  it("leaves it unbounded before any ping reached the host, and for an older host", () => {
    expect(
      receiveSummary({ sampleAgeMs: 100, afterPing: null }, pingSentAt, at(1)).maxAgeMs
    ).toBeNull();
    expect(receiveSummary(undefined, pingSentAt, at(1))).toEqual({
      receivedAt: 1,
      at: at(1),
      hostAgeMs: null,
      maxAgeMs: null,
      timed: false,
    });
  });
});

describe("sampleFreshness (#14462)", () => {
  const bounded = (maxAgeMs: number, received = at(1_000)): SummaryReceipt => ({
    receivedAt: received.wall,
    at: received,
    hostAgeMs: 0,
    maxAgeMs,
    timed: true,
  });

  it("is fresh with a bounded age, whichever way the host's clock is off", () => {
    for (const offset of [-60_000, 0, 60_000, 3_600_000]) {
      expect(sampleFreshness(summary(1_000 + offset), bounded(2_000), at(1_000))).toEqual({
        ageMs: 2_000,
        stale: false,
        staleReason: null,
        receivedAt: 1_000,
      });
    }
  });

  it("takes a bound of zero, as this machine's own sample has, for fresh", () => {
    expect(sampleFreshness(summary(1e12), bounded(0), at(1_000))).toMatchObject({
      ageMs: 0,
      stale: false,
    });
  });

  it("goes stale as a bounded sample ages on this Shell's clocks", () => {
    const receipt = bounded(4_000);
    expect(sampleFreshness(summary(1_000), receipt, at(12_000)).stale).toBe(false);
    expect(sampleFreshness(summary(1_000), receipt, at(12_001))).toEqual({
      ageMs: HOST_LOAD_STALE_MS + 1,
      stale: true,
      staleReason: "age-limit",
      receivedAt: 1_000,
    });
  });

  it("keeps ageing across sleep, and through a wall clock stepped back", () => {
    const receipt = bounded(1_000, at(1_000, 1_000));
    // Asleep for a minute: the monotonic clock barely moved.
    expect(sampleFreshness(summary(1_000), receipt, at(61_000, 1_500))).toMatchObject({
      stale: true,
      ageMs: 61_000,
    });
    // The wall clock stepped back an hour; the monotonic clock still counts.
    expect(sampleFreshness(summary(1_000), receipt, at(-3_599_000, 21_000))).toMatchObject({
      stale: true,
      ageMs: 21_000,
    });
  });

  it("keeps a cached sample stale when it arrives now, with no ping to bound it", () => {
    const cached: SummaryReceipt = {
      receivedAt: 1_000,
      at: at(1_000),
      hostAgeMs: 600_000,
      maxAgeMs: null,
      timed: true,
    };
    // Its timestamp looks fresh, as a host whose clock runs ten minutes slow would make it.
    expect(sampleFreshness(summary(995), cached, at(1_000))).toEqual({
      ageMs: null,
      stale: true,
      staleReason: "age-limit",
      receivedAt: 1_000,
    });
  });

  it("adds the host's age to the time held here, each too short alone", () => {
    const cached: SummaryReceipt = {
      receivedAt: 1_000,
      at: at(1_000),
      hostAgeMs: 10_000,
      maxAgeMs: null,
      timed: false,
    };
    expect(sampleFreshness(summary(7_000), cached, at(7_000))).toMatchObject({
      stale: true,
      staleReason: "age-limit",
      ageMs: null,
    });
  });

  it("never falls back to the timestamp of a host that times its frames", () => {
    // Before any ping reached it, or delayed past the pings remembered: its clock
    // may run as far ahead as the delay and look current.
    const unbounded: SummaryReceipt = { ...bounded(0), hostAgeMs: 100, maxAgeMs: null };
    expect(sampleFreshness(summary(1_000), unbounded, at(1_000))).toEqual({
      ageMs: null,
      stale: true,
      staleReason: "clock-uncertain",
      receivedAt: 1_000,
    });
  });

  it("calls an unbounded sample held too long here stale for its age, not its clock", () => {
    expect(
      sampleFreshness(summary(1e12), legacy(), at(1_000 + HOST_LOAD_STALE_MS + 1))
    ).toMatchObject({
      stale: true,
      staleReason: "age-limit",
      ageMs: null,
    });
  });

  it("falls back to an older host's timestamp near this clock, as before", () => {
    expect(sampleFreshness(summary(900), legacy(), at(1_000))).toEqual({
      ageMs: 100,
      stale: false,
      staleReason: null,
      receivedAt: 1_000,
    });
    expect(sampleFreshness(summary(900), null, at(1_000))).toMatchObject({
      ageMs: 100,
      stale: false,
      receivedAt: null,
    });
  });

  it("can't tell an older host's far timestamp from clocks that disagree", () => {
    for (const sampledAt of [1_000 - 60_000, 1_000 + 60_000, Number.NaN]) {
      expect(sampleFreshness(summary(sampledAt), legacy(), at(1_000))).toEqual({
        ageMs: null,
        stale: true,
        staleReason: "clock-uncertain",
        receivedAt: 1_000,
      });
    }
  });
});
