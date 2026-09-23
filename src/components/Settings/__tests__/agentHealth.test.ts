import { describe, it, expect } from "vitest";
import type { AgentAvailabilityState } from "@shared/types";
import { getAgentHealth } from "../agentHealth";
import { isAgentInstalled, isAgentReady } from "../../../../shared/utils/agentAvailability";

const STATES: AgentAvailabilityState[] = [
  "missing",
  "installed",
  "ready",
  "blocked",
  "unauthenticated",
];

describe("getAgentHealth", () => {
  it("calls out exactly the installed agents that are not ready", () => {
    for (const state of STATES) {
      const needsAttention = isAgentInstalled(state) && !isAgentReady(state);
      expect(getAgentHealth(state).kind === "attention", state).toBe(needsAttention);
    }
  });

  it("never gives a missing agent a warning glyph, and never labels a ready one", () => {
    for (const state of STATES) {
      const health = getAgentHealth(state);
      if (!isAgentInstalled(state)) expect(health.kind, state).toBe("missing");
      if (isAgentReady(state)) expect(health.kind, state).toBe("ready");
    }
  });

  it("gives every attention state its own words and its own glyph", () => {
    const attention = STATES.map(getAgentHealth).filter((h) => h.kind === "attention");
    expect(attention.length).toBeGreaterThan(1);
    const labels = new Set(attention.map((h) => (h.kind === "attention" ? h.label : "")));
    const icons = new Set(attention.map((h) => (h.kind === "attention" ? h.Icon : null)));
    expect(labels.size).toBe(attention.length);
    expect(icons.size).toBe(attention.length);
  });

  it("does not guess while availability is unknown", () => {
    expect(getAgentHealth(undefined).kind).toBe("unknown");
  });
});
