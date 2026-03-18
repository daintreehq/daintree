import { describe, it, expect, beforeEach } from "vitest";
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
    it("removes terminal tracking state", () => {
      tracker.beginInjection("t1", "inj1");
      tracker.markCancelled("inj1");

      tracker.cleanupTerminal("t1");

      expect(tracker.isTerminalInjecting("t1")).toBe(false);
      expect(tracker.getActiveCount()).toBe(0);
    });

    it("handles non-existent terminal gracefully", () => {
      tracker.cleanupTerminal("t-nonexistent");
      expect(tracker.getActiveCount()).toBe(0);
    });
  });

  describe("onProjectSwitch", () => {
    it("clears all state", () => {
      tracker.beginInjection("t1", "inj1");
      tracker.beginInjection("t2", "inj2");
      tracker.markCancelled("inj1");

      tracker.onProjectSwitch();

      expect(tracker.isTerminalInjecting("t1")).toBe(false);
      expect(tracker.isTerminalInjecting("t2")).toBe(false);
      expect(tracker.isCancelled("inj1")).toBe(false);
      expect(tracker.getActiveCount()).toBe(0);
    });
  });
});
