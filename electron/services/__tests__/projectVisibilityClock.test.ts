import { describe, expect, it } from "vitest";
import { ProjectVisibilityClock, trackProjectVisibility } from "../projectVisibilityClock.js";
import { notifyProjectPresenceChanged } from "../../window/projectPresenceChanges.js";

function makeClock(startAt = 1_000) {
  const time = { now: startAt };
  const clock = new ProjectVisibilityClock(() => time.now);
  return { clock, time };
}

describe("ProjectVisibilityClock", () => {
  it("counts a project it has never seen as idle since its first observation", () => {
    const { clock, time } = makeClock(1_000);
    time.now = 3_000;
    clock.observe([]);
    time.now = 50_000;
    expect(clock.lastVisibleAt("p1")).toBe(3_000);
  });

  it("reads every project as just seen until it has observed anything", () => {
    const { clock, time } = makeClock(1_000);
    time.now = 50_000;
    expect(clock.lastVisibleAt("p1")).toBe(50_000);
  });

  it("reads a project still on screen as visible right now", () => {
    const { clock, time } = makeClock();
    time.now = 2_000;
    clock.observe(["p1"]);
    time.now = 9_000;
    expect(clock.lastVisibleAt("p1")).toBe(9_000);
  });

  it("stamps a departure at the first observation that no longer holds the project", () => {
    const { clock, time } = makeClock();
    time.now = 2_000;
    clock.observe(["p1", "p2"]);
    time.now = 5_000;
    clock.observe(["p2"]);
    time.now = 9_000;
    expect(clock.lastVisibleAt("p1")).toBe(5_000);
    expect(clock.lastVisibleAt("p2")).toBe(9_000);
  });

  it("keeps the departure time through later observations that still lack the project", () => {
    const { clock, time } = makeClock();
    time.now = 2_000;
    clock.observe(["p1"]);
    time.now = 5_000;
    clock.observe([]);
    time.now = 7_000;
    clock.observe(["p2"]);
    time.now = 9_000;
    clock.observe([]);
    expect(clock.lastVisibleAt("p1")).toBe(5_000);
    expect(clock.lastVisibleAt("p2")).toBe(9_000);
  });

  it("takes an explicit start time as the baseline for unseen projects", () => {
    const clock = new ProjectVisibilityClock(() => 10_000, 4_000);
    expect(clock.lastVisibleAt("p1")).toBe(4_000);
  });
});

describe("trackProjectVisibility", () => {
  it("observes once straight away, so what is on screen at install is known", () => {
    const { clock, time } = makeClock();
    time.now = 2_000;
    const stop = trackProjectVisibility(() => ["p1"], clock);
    stop();
    time.now = 9_000;
    expect(clock.lastVisibleAt("p1")).toBe(9_000);
  });

  it("catches a visit that comes and goes between two reads of the clock", () => {
    const { clock, time } = makeClock();
    let shown: string[] = [];
    const stop = trackProjectVisibility(() => shown, clock);
    try {
      time.now = 3_000;
      shown = ["p1"];
      notifyProjectPresenceChanged();
      time.now = 4_000;
      shown = [];
      notifyProjectPresenceChanged();
    } finally {
      stop();
    }
    time.now = 60_000;
    expect(clock.lastVisibleAt("p1")).toBe(4_000);
  });

  it("stops observing once unsubscribed", () => {
    const { clock, time } = makeClock();
    let shown = ["p1"];
    const stop = trackProjectVisibility(() => shown, clock);
    stop();
    time.now = 4_000;
    shown = [];
    notifyProjectPresenceChanged();
    time.now = 60_000;
    // Still on screen as far as the clock knows: the departure was never seen.
    expect(clock.lastVisibleAt("p1")).toBe(60_000);
  });
});
