import { describe, it, expect, beforeEach } from "vitest";
import { WorkingSignalDebouncer } from "../WorkingSignalDebouncer.js";

describe("WorkingSignalDebouncer", () => {
  let debouncer: WorkingSignalDebouncer;

  beforeEach(() => {
    debouncer = new WorkingSignalDebouncer(1500);
  });

  it("returns false on first signal", () => {
    expect(debouncer.shouldTriggerRecovery(1000, true)).toBe(false);
  });

  it("returns true after sustained duration", () => {
    debouncer.shouldTriggerRecovery(1000, true);
    expect(debouncer.shouldTriggerRecovery(2500, true)).toBe(true);
  });

  it("returns false just before sustained duration", () => {
    debouncer.shouldTriggerRecovery(1000, true);
    expect(debouncer.shouldTriggerRecovery(2499, true)).toBe(false);
  });

  it("resets when signal disappears", () => {
    debouncer.shouldTriggerRecovery(1000, true);
    debouncer.shouldTriggerRecovery(1500, false);
    // Restart tracking
    debouncer.shouldTriggerRecovery(2000, true);
    expect(debouncer.shouldTriggerRecovery(3499, true)).toBe(false);
    expect(debouncer.shouldTriggerRecovery(3500, true)).toBe(true);
  });

  it("reset clears state", () => {
    debouncer.shouldTriggerRecovery(1000, true);
    debouncer.reset();
    expect(debouncer.shouldTriggerRecovery(2500, true)).toBe(false);
  });

  describe("setDelay", () => {
    it("shortens the gate so recovery fires sooner", () => {
      debouncer.setDelay(600);
      debouncer.shouldTriggerRecovery(1000, true);
      expect(debouncer.shouldTriggerRecovery(1599, true)).toBe(false);
      expect(debouncer.shouldTriggerRecovery(1600, true)).toBe(true);
    });

    it("preserves sustainedSince when changing delay mid-flight", () => {
      debouncer.shouldTriggerRecovery(1000, true);
      debouncer.setDelay(600);
      // Signal started at t=1000; with 600ms delay it should fire at t>=1600.
      expect(debouncer.shouldTriggerRecovery(1600, true)).toBe(true);
    });

    it("exposes the current delay through the getter", () => {
      expect(debouncer.delayMs).toBe(1500);
      debouncer.setDelay(600);
      expect(debouncer.delayMs).toBe(600);
    });
  });
});
