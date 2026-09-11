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

// A→B→A→B: the two-state toggle the incident showed.
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

describe("createFocusFollowBreaker (#12370)", () => {
  it("allows promotions below the threshold and blocks the one that reaches it", () => {
    const clock = makeClock();
    const breaker = makeBreaker(clock);

    expect([0, 1, 2].map((n) => breaker.record(promotion(n)))).toEqual(["allow", "allow", "allow"]);
    expect(breaker.snapshot().tripped).toBe(false);

    expect(breaker.record(promotion(3))).toBe("tripped");
    const snap = breaker.snapshot();
    expect(snap.tripped).toBe(true);
    expect(snap.history.map((p) => p.to)).toEqual(["wt-b", "wt-a", "wt-b", "wt-a"]);
    expect(snap.history.every((p) => p.at === clock.now())).toBe(true);
  });

  it("forgets promotions that fall outside the window", () => {
    const clock = makeClock();
    const breaker = makeBreaker(clock);

    for (let n = 0; n < 3; n++) breaker.record(promotion(n));
    clock.advance(1_001);
    // The three above are now older than the window, so this one starts over.
    expect(breaker.record(promotion(3))).toBe("allow");
    expect(breaker.snapshot().history).toHaveLength(1);

    expect(breaker.record(promotion(4))).toBe("allow");
    expect(breaker.record(promotion(5))).toBe("allow");
    expect(breaker.record(promotion(6))).toBe("tripped");
  });

  it("suppresses every attempt during the hold and extends the hold on each one", () => {
    const clock = makeClock();
    const breaker = makeBreaker(clock);
    for (let n = 0; n < 4; n++) breaker.record(promotion(n));

    // Each attempt lands inside the previous attempt's cooldown, so the hold
    // never elapses even though 1.2 s > cooldownMs has passed since the trip.
    clock.advance(400);
    expect(breaker.record(promotion(4))).toBe("suppressed");
    clock.advance(400);
    expect(breaker.record(promotion(5))).toBe("suppressed");
    clock.advance(400);
    expect(breaker.record(promotion(6))).toBe("suppressed");

    const snap = breaker.snapshot();
    expect(snap.tripped).toBe(true);
    expect(snap.suppressedCount).toBe(3);
    // Suppressed attempts are not added to the ring.
    expect(snap.history).toHaveLength(4);
  });

  it("releases after a quiet cooldown, reports the release once, and starts a fresh window", () => {
    const clock = makeClock();
    const breaker = makeBreaker(clock);
    for (let n = 0; n < 4; n++) breaker.record(promotion(n));
    clock.advance(200);
    breaker.record(promotion(4));
    expect(breaker.snapshot().suppressedCount).toBe(1);

    clock.advance(501);
    expect(breaker.record(promotion(5))).toBe("recovered");
    const snap = breaker.snapshot();
    expect(snap.tripped).toBe(false);
    expect(snap.history).toHaveLength(1);
    // Still reports the hold that just ended, for the release log line.
    expect(snap.suppressedCount).toBe(1);

    // A second burst counts from the recovery promotion, not from zero.
    expect(breaker.record(promotion(6))).toBe("allow");
    expect(breaker.record(promotion(7))).toBe("allow");
    expect(breaker.record(promotion(8))).toBe("tripped");
    expect(breaker.snapshot().suppressedCount).toBe(0);
  });

  it("reset clears the window, the hold, and the counters", () => {
    const clock = makeClock();
    const breaker = makeBreaker(clock);
    for (let n = 0; n < 5; n++) breaker.record(promotion(n));
    expect(breaker.snapshot().tripped).toBe(true);

    breaker.reset();
    expect(breaker.snapshot()).toEqual({ tripped: false, history: [], suppressedCount: 0 });
    expect(breaker.record(promotion(0))).toBe("allow");
  });
});
