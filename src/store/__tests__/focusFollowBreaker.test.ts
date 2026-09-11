import { describe, it, expect } from "vitest";
import { createFocusFollowBreaker } from "../focusFollowBreaker";

function makeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// A→B→A→B: the two-state toggle the incident showed. Only the first hop is
// fresh; every later one revisits.
function promotion(n: number) {
  return n % 2 === 0
    ? { from: "wt-a", to: "wt-b", panelId: "term-b" }
    : { from: "wt-b", to: "wt-a", panelId: "term-a" };
}

function makeBreaker(clock: ReturnType<typeof makeClock>) {
  return createFocusFollowBreaker({
    threshold: 4,
    windowMs: 1_000,
    cooldownMs: 500,
    now: clock.now,
  });
}

function trip(breaker: ReturnType<typeof makeBreaker>) {
  for (let n = 0; n < 5; n++) breaker.record(promotion(n));
  expect(breaker.snapshot().tripped).toBe(true);
}

describe("createFocusFollowBreaker (#12370)", () => {
  it("allows revisits below the threshold and blocks the one that reaches it", () => {
    const clock = makeClock();
    const breaker = makeBreaker(clock);

    expect([0, 1, 2, 3].map((n) => breaker.record(promotion(n)))).toEqual([
      "allow",
      "allow",
      "allow",
      "allow",
    ]);
    expect(breaker.snapshot().tripped).toBe(false);

    expect(breaker.record(promotion(4))).toBe("tripped");
    const snap = breaker.snapshot();
    expect(snap.tripped).toBe(true);
    expect(snap.history.map((p) => p.to)).toEqual(["wt-b", "wt-a", "wt-b", "wt-a", "wt-b"]);
    expect(snap.history.map((p) => p.revisit)).toEqual([false, true, true, true, true]);
    expect(snap.history.every((p) => p.at === clock.now())).toBe(true);
  });

  it("does not count a one-way tour, however long", () => {
    const clock = makeClock();
    const breaker = makeBreaker(clock);

    for (let i = 1; i <= 12; i++) {
      expect(breaker.record({ from: `wt-${i}`, to: `wt-${i + 1}`, panelId: `t${i}` })).toBe(
        "allow"
      );
    }
    expect(breaker.snapshot().tripped).toBe(false);
    // Bounded at twice the threshold so a pathological tour cannot grow it.
    expect(breaker.snapshot().history).toHaveLength(8);
  });

  it("counts a return to either end of an earlier hop, so a three-way cycle still trips", () => {
    const clock = makeClock();
    const breaker = makeBreaker(clock);
    const cycle = [
      { from: "wt-a", to: "wt-b", panelId: "tb" },
      { from: "wt-b", to: "wt-c", panelId: "tc" },
      { from: "wt-c", to: "wt-a", panelId: "ta" },
    ];

    const outcomes = [0, 1, 2, 3, 4, 5].map((n) => breaker.record(cycle[n % 3]!));

    // Hops 1–2 are fresh; hop 3 returns to wt-a; hops 4–6 revisit too.
    expect(outcomes).toEqual(["allow", "allow", "allow", "allow", "allow", "tripped"]);
    expect(breaker.snapshot().history.map((p) => p.revisit)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
  });

  it("forgets promotions that fall outside the window", () => {
    const clock = makeClock();
    const breaker = makeBreaker(clock);

    for (let n = 0; n < 4; n++) breaker.record(promotion(n));
    clock.advance(1_001);
    // Everything above is now older than the window, so this hop is fresh.
    expect(breaker.record(promotion(4))).toBe("allow");
    expect(breaker.snapshot().history).toHaveLength(1);
    expect(breaker.snapshot().history[0]!.revisit).toBe(false);

    for (let n = 5; n < 8; n++) expect(breaker.record(promotion(n))).toBe("allow");
    expect(breaker.record(promotion(8))).toBe("tripped");
  });

  it("suppresses every attempt during the hold and extends the hold on each one", () => {
    const clock = makeClock();
    const breaker = makeBreaker(clock);
    trip(breaker);

    // Each attempt lands inside the previous attempt's cooldown, so the hold
    // never elapses even though 1.2 s > cooldownMs has passed since the trip.
    clock.advance(400);
    expect(breaker.record(promotion(5))).toBe("suppressed");
    expect(breaker.holdRemainingMs()).toBe(500);
    clock.advance(400);
    expect(breaker.record(promotion(6))).toBe("suppressed");
    clock.advance(400);
    expect(breaker.record(promotion(7))).toBe("suppressed");

    const snap = breaker.snapshot();
    expect(snap.tripped).toBe(true);
    expect(snap.suppressedCount).toBe(3);
    // Suppressed attempts are not added to the ring.
    expect(snap.history).toHaveLength(5);
  });

  it("reports how long the hold has left, and zero once it has lapsed or was never held", () => {
    const clock = makeClock();
    const breaker = makeBreaker(clock);
    expect(breaker.holdRemainingMs()).toBe(0);

    trip(breaker);
    expect(breaker.holdRemainingMs()).toBe(500);
    clock.advance(200);
    expect(breaker.holdRemainingMs()).toBe(300);
    clock.advance(400);
    expect(breaker.holdRemainingMs()).toBe(0);
  });

  it("releases after a quiet cooldown, reports the release once, and starts a fresh window", () => {
    const clock = makeClock();
    const breaker = makeBreaker(clock);
    trip(breaker);
    clock.advance(200);
    breaker.record(promotion(5));
    expect(breaker.snapshot().suppressedCount).toBe(1);

    clock.advance(501);
    expect(breaker.record(promotion(6))).toBe("recovered");
    const snap = breaker.snapshot();
    expect(snap.tripped).toBe(false);
    expect(snap.history).toHaveLength(1);
    expect(snap.history[0]!.revisit).toBe(false);
    // Still reports the hold that just ended, for the release log line.
    expect(snap.suppressedCount).toBe(1);

    // A second burst counts from the recovery promotion, not from zero.
    for (let n = 7; n < 10; n++) expect(breaker.record(promotion(n))).toBe("allow");
    expect(breaker.record(promotion(10))).toBe("tripped");
    expect(breaker.snapshot().suppressedCount).toBe(0);
  });

  it("reset clears the window, the hold, and the counters", () => {
    const clock = makeClock();
    const breaker = makeBreaker(clock);
    trip(breaker);

    breaker.reset();
    expect(breaker.snapshot()).toEqual({ tripped: false, history: [], suppressedCount: 0 });
    expect(breaker.holdRemainingMs()).toBe(0);
    expect(breaker.record(promotion(0))).toBe("allow");
  });
});
