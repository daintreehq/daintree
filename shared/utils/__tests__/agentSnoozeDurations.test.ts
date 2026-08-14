import { describe, it, expect } from "vitest";
import {
  AGENT_SNOOZE_DURATION_OPTIONS,
  AGENT_SNOOZE_LABEL,
  isAgentSnoozeDurationOption,
  resolveAgentSnoozeDuration,
} from "../agentSnoozeDurations.js";

const NOW = 1_700_000_000_000;

describe("resolveAgentSnoozeDuration", () => {
  it("orders the timed options strictly by length", () => {
    const at15 = resolveAgentSnoozeDuration("15m", NOW)!;
    const at30 = resolveAgentSnoozeDuration("30m", NOW)!;
    const at6h = resolveAgentSnoozeDuration("6h", NOW)!;

    expect(at15).toBeGreaterThan(NOW);
    expect(at30).toBeGreaterThan(at15);
    expect(at6h).toBeGreaterThan(at30);
  });

  it("makes 30m exactly twice the offset of 15m", () => {
    // A relationship rather than a literal: this stays meaningful if the ladder
    // is ever re-tuned, and fails if one option is edited without the other.
    const at15 = resolveAgentSnoozeDuration("15m", NOW)! - NOW;
    const at30 = resolveAgentSnoozeDuration("30m", NOW)! - NOW;
    expect(at30).toBe(at15 * 2);
  });

  it("returns no wake time for the unlimited option", () => {
    expect(resolveAgentSnoozeDuration("unlimited", NOW)).toBeUndefined();
  });

  it("is a pure offset from the injected clock, not from wall time", () => {
    const early = resolveAgentSnoozeDuration("6h", NOW)!;
    const later = resolveAgentSnoozeDuration("6h", NOW + 1_000)!;
    expect(later - early).toBe(1_000);
  });

  it("resolves every listed option without falling through", () => {
    for (const option of AGENT_SNOOZE_DURATION_OPTIONS) {
      const resolved = resolveAgentSnoozeDuration(option, NOW);
      // Unlimited is the only option allowed to produce no wake time.
      if (option === "unlimited") expect(resolved).toBeUndefined();
      else expect(resolved).toBeGreaterThan(NOW);
    }
  });
});

describe("isAgentSnoozeDurationOption", () => {
  it("accepts every option the menu can offer", () => {
    for (const option of AGENT_SNOOZE_DURATION_OPTIONS) {
      expect(isAgentSnoozeDurationOption(option)).toBe(true);
    }
  });

  it("rejects non-members, including the notification inbox's own ladder", () => {
    // The two ladders are deliberately separate; an inbox option reaching the
    // agent snooze path is a wiring mistake, not a valid duration.
    for (const value of ["1h", "4h", "tomorrow-8am", "next-monday-8am"]) {
      expect(isAgentSnoozeDurationOption(value)).toBe(false);
    }
  });

  it("rejects non-string payloads from an untrusted caller", () => {
    for (const value of [undefined, null, 15, {}, [], true]) {
      expect(isAgentSnoozeDurationOption(value)).toBe(false);
    }
  });
});

describe("AGENT_SNOOZE_LABEL", () => {
  it("labels every option distinctly", () => {
    const labels = AGENT_SNOOZE_DURATION_OPTIONS.map((option) => AGENT_SNOOZE_LABEL[option]);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((label) => label.length > 0)).toBe(true);
  });

  it("never ends a menu label with a period", () => {
    // Microcopy rule: no trailing period on titles, buttons or labels.
    for (const label of Object.values(AGENT_SNOOZE_LABEL)) {
      expect(label.endsWith(".")).toBe(false);
    }
  });
});
