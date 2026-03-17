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
});
