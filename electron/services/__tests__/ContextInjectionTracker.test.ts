import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ContextInjectionTracker } from "../ContextInjectionTracker.js";

describe("ContextInjectionTracker", () => {
  let tracker: ContextInjectionTracker;

  beforeEach(() => {
    tracker = new ContextInjectionTracker();
  });

  describe("injection lifecycle", () => {
    it("tracks begin and finish", () => {
      expect(tracker.isTerminalInjecting("t1")).toBe(false);

      tracker.beginInjection("t1", "inj1");
      expect(tracker.isTerminalInjecting("t1")).toBe(true);

      tracker.finishInjection("t1", "inj1");
      expect(tracker.isTerminalInjecting("t1")).toBe(false);
    });

    it("finishInjection is idempotent", () => {
      tracker.beginInjection("t1", "inj1");
      tracker.finishInjection("t1", "inj1");
      tracker.finishInjection("t1", "inj1");
      expect(tracker.isTerminalInjecting("t1")).toBe(false);
    });
  });

  describe("cancellation", () => {
    it("marks active injection as cancelled", () => {
      tracker.beginInjection("t1", "inj1");

      const wasActive = tracker.markCancelled("inj1");
      expect(wasActive).toBe(true);
      expect(tracker.isCancelled("inj1")).toBe(true);
    });

    it("does not mark unknown injection as cancelled", () => {
      const wasActive = tracker.markCancelled("inj-unknown");
      expect(wasActive).toBe(false);
      expect(tracker.isCancelled("inj-unknown")).toBe(false);
    });

    it("finishInjection clears cancelled state", () => {
      tracker.beginInjection("t1", "inj1");
      tracker.markCancelled("inj1");

      tracker.finishInjection("t1", "inj1");
      expect(tracker.isCancelled("inj1")).toBe(false);
    });

    it("markAllCancelled cancels all active injections", () => {
      tracker.beginInjection("t1", "inj1");
      tracker.beginInjection("t2", "inj2");

      const count = tracker.markAllCancelled();
      expect(count).toBe(2);
      expect(tracker.isCancelled("inj1")).toBe(true);
      expect(tracker.isCancelled("inj2")).toBe(true);
    });
  });

  describe("stop reasons", () => {
    it("records why a run stopped, and a plain cancel as cancelled", () => {
      tracker.beginInjection("t1", "inj1");
      tracker.beginInjection("t2", "inj2");

      tracker.markCancelled("inj1", "input-locked");
      tracker.markCancelled("inj2");

      expect(tracker.getStop("inj1")).toBe("input-locked");
      expect(tracker.getStop("inj2")).toBe("cancelled");
    });

    it("keeps the first reason when a later cancel lands on the same run", () => {
      tracker.beginInjection("t1", "inj1");
      tracker.markCancelled("inj1", "input-locked");

      tracker.markAllCancelled();
      tracker.markCancelled("inj1");

      expect(tracker.getStop("inj1")).toBe("input-locked");
    });
  });

  describe("a stop that arrives before its run", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("applies it when the run begins, without reserving the terminal", () => {
      expect(tracker.markCancelled("inj-early", "input-locked")).toBe(false);
      expect(tracker.isTerminalInjecting("t1")).toBe(false);
      expect(tracker.getActiveCount()).toBe(0);

      tracker.beginInjection("t1", "inj-early");

      expect(tracker.getStop("inj-early")).toBe("input-locked");
    });

    it("is claimed once: a later run with the same id starts clean", () => {
      tracker.markCancelled("inj-early");
      tracker.beginInjection("t1", "inj-early");
      tracker.finishInjection("t1", "inj-early");

      tracker.beginInjection("t1", "inj-early");

      expect(tracker.isCancelled("inj-early")).toBe(false);
    });

    it("lapses when no run claims it soon", () => {
      vi.useFakeTimers();
      tracker.markCancelled("inj-late");

      vi.advanceTimersByTime(31_000);
      tracker.beginInjection("t1", "inj-late");

      expect(tracker.isCancelled("inj-late")).toBe(false);
    });

    it("holds only a bounded number, dropping the oldest first", () => {
      for (let i = 0; i < 65; i++) tracker.markCancelled(`inj-${i}`);

      for (let i = 0; i < 65; i++) tracker.beginInjection(`t-${i}`, `inj-${i}`);

      // The 65th pushed out only the first; the other 64 were all kept.
      expect(tracker.isCancelled("inj-0")).toBe(false);
      for (let i = 1; i < 65; i++) expect(tracker.isCancelled(`inj-${i}`)).toBe(true);
    });

    it("is cleared by a project switch", () => {
      tracker.markCancelled("inj-early");
      tracker.onProjectSwitch();

      tracker.beginInjection("t1", "inj-early");

      expect(tracker.isCancelled("inj-early")).toBe(false);
    });
  });

  describe("getActiveCount", () => {
    it("reflects active injections", () => {
      expect(tracker.getActiveCount()).toBe(0);

      tracker.beginInjection("t1", "inj1");
      expect(tracker.getActiveCount()).toBe(1);

      tracker.beginInjection("t2", "inj2");
      expect(tracker.getActiveCount()).toBe(2);

      tracker.finishInjection("t1", "inj1");
      expect(tracker.getActiveCount()).toBe(1);
    });
  });

  describe("cleanupTerminal", () => {
    it("removes terminal tracking state including cancelled marker", () => {
      tracker.beginInjection("t1", "inj1");
      tracker.markCancelled("inj1");

      tracker.cleanupTerminal("t1");

      expect(tracker.isTerminalInjecting("t1")).toBe(false);
      expect(tracker.isCancelled("inj1")).toBe(false);
      expect(tracker.getActiveCount()).toBe(0);
    });
  });

  describe("onProjectSwitch", () => {
    it("releases every terminal reservation", () => {
      tracker.beginInjection("t1", "inj1");
      tracker.beginInjection("t2", "inj2");

      tracker.onProjectSwitch();

      expect(tracker.isTerminalInjecting("t1")).toBe(false);
      expect(tracker.isTerminalInjecting("t2")).toBe(false);
      expect(tracker.getActiveCount()).toBe(0);
    });

    // #15644: the handler keeps running across a switch, so forgetting its
    // stop would let a locked pane receive the bundle after all.
    it("keeps a running run's stop, and still lets one reach it", () => {
      tracker.beginInjection("t1", "inj1");
      tracker.beginInjection("t2", "inj2");
      tracker.markCancelled("inj1", "input-locked");

      tracker.onProjectSwitch();
      const reachedRun = tracker.markCancelled("inj2", "input-locked");

      expect(tracker.getStop("inj1")).toBe("input-locked");
      expect(reachedRun).toBe(true);
      expect(tracker.getStop("inj2")).toBe("input-locked");
    });

    it("lets the older run's finish leave a newer run's reservation alone", () => {
      tracker.beginInjection("t1", "inj-old");
      tracker.onProjectSwitch();
      tracker.beginInjection("t1", "inj-new");

      tracker.finishInjection("t1", "inj-old");

      expect(tracker.isTerminalInjecting("t1")).toBe(true);
      expect(tracker.isCancelled("inj-old")).toBe(false);
    });
  });
});
