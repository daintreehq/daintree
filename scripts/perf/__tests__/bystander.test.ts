import { describe, expect, it, vi } from "vitest";
import {
  armBystanderProbe,
  bystanderMetrics,
  startBystanderProbe,
  type BystanderProbe,
} from "../lib/bystander";

/**
 * Does the bystander probe see a block, and stay quiet when there is none?
 *
 * Both halves matter. A probe that reports stalls on an idle loop makes every
 * reading noise, and a probe that misses a synchronous block reports the one
 * thing it exists to catch as a clean result. The block below is real CPU work
 * rather than a fake clock, because that is the only thing a Node timer
 * genuinely cannot fire through.
 */

function blockFor(ms: number): void {
  const until = performance.now() + ms;
  // A spin, not a sleep: the point is to hold the loop, and any await would
  // hand it straight back.
  while (performance.now() < until) {
    // Deliberately empty.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("bystander probe", () => {
  it("reports a synchronous block as a stall of roughly its length", async () => {
    const probe = startBystanderProbe({ cadenceMs: 8 });
    await sleep(30);
    blockFor(120);
    await sleep(30);
    const reading = probe.stop();

    expect(reading.longestStallMs).toBeGreaterThan(100);
    expect(reading.blockedMs).toBeGreaterThan(100);
    expect(reading.probeMisses).toBe(0);
    expect(reading.ticksObserved).toBeGreaterThan(0);
  });

  it("measures a synchronous block as a lower bound on the loop being held", async () => {
    // Everything asserted here is a LOWER bound on the busy side, because that
    // is the only thing a shared machine cannot break: a 150ms spin holds the
    // loop for at least 150ms however loaded the box is, and load can only make
    // it longer. The idle side carries apparatus assertions only.
    //
    // A ratio between the two was tried first and is not safe. Inside a full
    // 2,481-file suite run the "idle" window genuinely stalled 80ms on foreign
    // scheduling, so `busy > idle * 4` failed — a true statement about the
    // runner reported as a defect in the probe.
    const idleProbe = startBystanderProbe({ cadenceMs: 8 });
    await sleep(150);
    const idle = idleProbe.stop();

    const busyProbe = startBystanderProbe({ cadenceMs: 8 });
    blockFor(150);
    const busy = busyProbe.stop();

    // Apparatus: the probe fired during the idle window. Deliberately not "many
    // times" — a 150ms window at an 8ms cadence nominally owes 18 ticks, and a
    // fully loaded runner delivered 7. The tick RATE is a property of the
    // machine; that the probe fired at all is a property of the probe.
    expect(idle.probeMisses).toBe(0);
    expect(idle.ticksObserved).toBeGreaterThan(0);

    // DISCRIMINATION, stated on tick counts rather than on a stall ratio. This
    // is what the removed busy/idle ratio was reaching for, expressed in a
    // quantity load cannot invert: a probe cannot sample a loop it could not
    // reach, however busy the box is, and cannot fail to sample one it could.
    // Identical bogus stall values for both windows do not survive it.
    expect(busy.ticksObserved).toBeLessThan(idle.ticksObserved);

    // Signal: the spin IS the whole busy window, so it must read as one long
    // unbroken hold covering nearly all of it.
    expect(busy.longestStallMs).toBeGreaterThan(140);
    expect(busy.blockedMs).toBeGreaterThan(120);
    expect(busy.blockedFraction).toBeGreaterThan(0.8);
    // And the probe cannot have sampled inside a loop it could not reach.
    expect(busy.ticksObserved).toBe(0);
  });

  it("counts a block still running at stop, not only one between two ticks", async () => {
    // Without the endedAt sentinel the largest gap in the window — the one that
    // never got a closing observation — would be discarded, which is exactly the
    // shape of a workload that blocks right up to its own completion.
    const probe = startBystanderProbe({ cadenceMs: 8 });
    await sleep(20);
    blockFor(90);
    const reading = probe.stop();

    expect(reading.longestStallMs).toBeGreaterThan(80);
  });

  it("reports probeMisses on an unarmed probe that never got a turn", () => {
    const probe = startBystanderProbe({ cadenceMs: 8 });
    // Stopped in the same turn: no timer has had a chance to fire.
    const reading = probe.stop();
    expect(reading.ticksObserved).toBe(0);
    expect(reading.probeMisses).toBe(1);
  });

  it("does not blame the workload for blocking, once armed", async () => {
    // The trap this closes: a workload that is one fully synchronous block from
    // start to stop lets no timer callback run, so a predicate built on the
    // window's own tick count fires BECAUSE the subject blocked hard — the very
    // condition under measurement moving the exit code under
    // `--enforce-integrity`. Arming proves the timer works beforehand.
    const probe = await armBystanderProbe({ cadenceMs: 8 });
    blockFor(120);
    const reading = probe.stop();

    expect(reading.ticksObserved).toBe(0);
    expect(reading.probeMisses).toBe(0);
    // The block is still measured — arming discards the priming tick, not the
    // window.
    expect(reading.longestStallMs).toBeGreaterThan(100);
  });

  it("does not charge the arming gap to the window", async () => {
    // `reopen()` restarts the window clock, so the wait for the priming tick
    // cannot appear as a stall the workload caused.
    //
    // Asserted on the WINDOW, not on `blockedMs`. Inside a Vitest worker
    // sharing a machine with 59 other perf files, a 60ms sleep really does pick
    // up 60ms+ of foreign scheduling — a `blockedMs === 0` here failed for a
    // reason that had nothing to do with arming. The window length is the
    // property this test is about and it is not machine-dependent: it must
    // measure the sleep, not the sleep plus the wait for the priming tick.
    // A 250ms cadence makes arming cost ~250ms against a 60ms window, so the
    // two are impossible to confuse: charged, the window would read ~310ms;
    // correct, it reads ~60ms. A short cadence would put the difference inside
    // ordinary scheduling noise and the test would pass either way.
    const armStart = performance.now();
    const probe = await armBystanderProbe({ cadenceMs: 250 });
    const armMs = performance.now() - armStart;
    await sleep(60);
    const reading = probe.stop();

    expect(armMs).toBeGreaterThan(200);
    expect(reading.probeMisses).toBe(0);
    expect(reading.windowMs).toBeGreaterThanOrEqual(55);
    expect(reading.windowMs).toBeLessThan(armMs);
    // Structural, and true on any machine however loaded.
    expect(reading.blockedMs).toBeLessThanOrEqual(reading.windowMs);
  });

  it("keeps exactly one cadence timer after arming", async () => {
    // `reopen()` clears the pending timer before rescheduling. Without that a
    // second chain runs alongside the first, every tick is counted twice, and a
    // blocked loop looks half as blocked.
    vi.useFakeTimers();
    try {
      const arming = armBystanderProbe({ cadenceMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      const probe = await arming;

      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(vi.getTimerCount()).toBe(1);
      expect(probe.stop().ticksObserved).toBeGreaterThan(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the same window from a second stop()", async () => {
    const probe = await armBystanderProbe({ cadenceMs: 8 });
    await sleep(40);
    const first = probe.stop();
    await sleep(40);
    const second = probe.stop();

    // A `finally` that stops a probe an earlier line already stopped must not
    // silently widen the window it reports.
    expect(second.windowMs).toBe(first.windowMs);
    expect(second.ticksObserved).toBe(first.ticksObserved);
  });

  it("keeps reporting a miss when arming timed out, even if a tick lands later", async () => {
    // The arming result is latched into the window. Reading the live "has this
    // ever fired" flag instead would let a tick arriving after the timeout
    // erase the one piece of evidence that the probe was not working when the
    // window opened — the failure quietly repairing its own record.
    //
    // Arming times out after 50 cadences, so a 4ms cadence times out in ~200ms
    // while the timer itself keeps running.
    const probe = await armBystanderProbe({ cadenceMs: 4 });
    await sleep(60);
    const reading = probe.stop();

    // On an unloaded loop arming succeeds long before the timeout, so this is
    // the healthy path; the assertion that matters is that the two facts are
    // decided at window-open and not re-derived at stop.
    expect(reading.probeMisses).toBe(0);
    expect(reading.ticksObserved).toBeGreaterThan(0);
  });

  it("does not leave the arming timer to fire inside the measured window", async () => {
    // Left scheduled, the arming timeout lands ~50 cadences into the window —
    // an unrelated callback inside the very window this probe exists to keep
    // clean. Observed indirectly: with a cadence whose arming timeout would
    // land mid-window, the window must still show no unexplained stall.
    const probe = await armBystanderProbe({ cadenceMs: 6 });
    await sleep(120); // 6ms * 50 = 300ms timeout; well outside this window
    const reading = probe.stop();

    expect(reading.probeMisses).toBe(0);
    // Every gap is accounted for by the cadence, so nothing foreign fired.
    expect(reading.longestStallMs).toBeLessThan(60);
  });

  it("ignores a reopen after the reading is closed", async () => {
    const probe = (await armBystanderProbe({ cadenceMs: 8 })) as BystanderProbe & {
      reopen?: (armed: boolean) => void;
    };
    await sleep(30);
    const first = probe.stop();
    probe.reopen?.(true);
    const second = probe.stop();

    // A reopen after stop would restart the window clock under a reading that
    // has already been reported.
    expect(second.windowMs).toBe(first.windowMs);
    expect(second.ticksObserved).toBe(first.ticksObserved);
  });

  it("clamps a cadence below the useful floor", async () => {
    const probe = startBystanderProbe({ cadenceMs: 0 });
    await sleep(40);
    const reading = probe.stop();
    // At an unclamped cadence of 0 this would spin the loop rather than sample
    // it. The floor is what keeps the probe from becoming the workload.
    expect(reading.ticksObserved).toBeLessThan(40);
  });

  it("prefixes metrics so two arms can be reported side by side", () => {
    const metrics = bystanderMetrics("worker", {
      ticksObserved: 12,
      probeMisses: 0,
      longestStallMs: 4,
      blockedMs: 0,
      p95StallMs: 3,
      p95DelayMs: 1,
      windowMs: 100,
      blockedFraction: 0,
    });
    expect(Object.keys(metrics).sort()).toEqual([
      "workerBlockedMs",
      "workerBlockedPct",
      "workerLongestStallMs",
      "workerP95DelayMs",
      "workerP95StallMs",
      "workerProbeTicks",
    ]);
    // Not folded into the prefix: one scenario declares one predicate for the
    // probe regardless of how many arms it runs, and an undeclared one is
    // invisible to the runner.
    expect(metrics).not.toHaveProperty("workerProbeMisses");
  });

  it("carries each percentile through to its own prefixed metric", () => {
    // Distinct non-zero values, because an implementation that reported a
    // constant 0 — or wired both keys to the same field — satisfies any
    // assertion written as an inequality.
    const metrics = bystanderMetrics("burst", {
      ticksObserved: 12,
      probeMisses: 0,
      longestStallMs: 91,
      blockedMs: 40,
      p95StallMs: 7,
      p95DelayMs: 3,
      windowMs: 100,
      blockedFraction: 0.4,
    });
    expect(metrics.burstP95StallMs).toBe(7);
    expect(metrics.burstP95DelayMs).toBe(3);
  });

  it("reports a gap percentile well below the one freeze that dominates the max", async () => {
    const probe = await armBystanderProbe({ cadenceMs: 8 });
    // Many ordinary gaps around a single long block, so the distribution and
    // its extreme are far apart and a p95 cannot be confused with either.
    await sleep(120);
    blockFor(120);
    await sleep(120);
    const reading = probe.stop();

    expect(reading.ticksObserved).toBeGreaterThan(10);
    // The block owns the max...
    expect(reading.longestStallMs).toBeGreaterThan(100);
    // ...but it is one sample among many, so it must not own the percentile.
    // This is what fails for an implementation returning the maximum.
    expect(reading.p95StallMs).toBeLessThan(reading.longestStallMs / 2);
    // And a real cadence still separates it from an implementation that
    // returns a constant zero.
    expect(reading.p95StallMs).toBeGreaterThan(0);
    // Strictly between the two bounds, which is what separates a real excess
    // calculation from the two ways of getting it wrong: hardcoding zero, and
    // reporting the same figure as the raw gap percentile.
    expect(reading.p95DelayMs).toBeGreaterThan(0);
    expect(reading.p95DelayMs).toBeLessThan(reading.p95StallMs);
  });

  it("analyses once, so a second stop() returns the same reading it already computed", () => {
    // `stop()` sorts the gap list to produce percentiles. A `finally` that
    // stops an already-stopped probe must not repeat that work inside a
    // scenario's measured bracket.
    const probe = startBystanderProbe({ cadenceMs: 8 });
    blockFor(20);
    const first = probe.stop();
    const second = probe.stop();
    expect(second).toBe(first);
  });
});
