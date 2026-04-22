import { describe, it, expect } from "vitest";
import { coerceAgentState, ACTIVE_AGENT_STATES } from "../agent.js";
import type { AgentState } from "../agent.js";

describe("coerceAgentState", () => {
  it("maps the retired 'running' state to 'working'", () => {
    expect(coerceAgentState("running")).toBe("working");
  });

  it.each<AgentState>(["idle", "working", "waiting", "directing", "completed", "exited"])(
    "passes %s through unchanged",
    (state) => {
      expect(coerceAgentState(state)).toBe(state);
    }
  );

  it("returns undefined for unknown strings", () => {
    expect(coerceAgentState("banana")).toBeUndefined();
  });

  it("returns undefined for non-string inputs", () => {
    expect(coerceAgentState(undefined)).toBeUndefined();
    expect(coerceAgentState(null)).toBeUndefined();
    expect(coerceAgentState(42)).toBeUndefined();
    expect(coerceAgentState({})).toBeUndefined();
  });
});

describe("ACTIVE_AGENT_STATES", () => {
  it("no longer includes the retired 'running' state", () => {
    expect(ACTIVE_AGENT_STATES.has("running" as AgentState)).toBe(false);
  });

  it("still covers in-flight states", () => {
    expect(ACTIVE_AGENT_STATES.has("working")).toBe(true);
    expect(ACTIVE_AGENT_STATES.has("waiting")).toBe(true);
    expect(ACTIVE_AGENT_STATES.has("directing")).toBe(true);
  });
});
