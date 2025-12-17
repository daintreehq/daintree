import { describe, it, expect } from "vitest";
import { getAmbientState, getAmbientClassName } from "../terminalAmbientState";

describe("getAmbientState", () => {
  it("returns 'failed' for failed agent state", () => {
    const result = getAmbientState({
      agentState: "failed",
      flowStatus: undefined,
      isExited: false,
    });
    expect(result).toBe("failed");
  });

  it("returns 'exited' when terminal is exited", () => {
    const result = getAmbientState({
      agentState: "idle",
      flowStatus: undefined,
      isExited: true,
    });
    expect(result).toBe("exited");
  });

  it("returns 'paused' for paused-backpressure flow status", () => {
    const result = getAmbientState({
      agentState: "idle",
      flowStatus: "paused-backpressure",
      isExited: false,
    });
    expect(result).toBe("paused");
  });

  it("returns 'suspended' for suspended flow status", () => {
    const result = getAmbientState({
      agentState: "idle",
      flowStatus: "suspended",
      isExited: false,
    });
    expect(result).toBe("suspended");
  });

  it("returns 'waiting' for waiting agent state", () => {
    const result = getAmbientState({
      agentState: "waiting",
      flowStatus: undefined,
      isExited: false,
    });
    expect(result).toBe("waiting");
  });

  it("returns null for idle state with no special conditions", () => {
    const result = getAmbientState({
      agentState: "idle",
      flowStatus: undefined,
      isExited: false,
    });
    expect(result).toBe(null);
  });

  it("returns null for working state", () => {
    const result = getAmbientState({
      agentState: "working",
      flowStatus: undefined,
      isExited: false,
    });
    expect(result).toBe(null);
  });

  it("prioritizes 'failed' over 'exited'", () => {
    const result = getAmbientState({
      agentState: "failed",
      flowStatus: undefined,
      isExited: true,
    });
    expect(result).toBe("failed");
  });

  it("prioritizes 'exited' over 'paused'", () => {
    const result = getAmbientState({
      agentState: "idle",
      flowStatus: "paused-backpressure",
      isExited: true,
    });
    expect(result).toBe("exited");
  });

  it("prioritizes 'paused' over 'waiting'", () => {
    const result = getAmbientState({
      agentState: "waiting",
      flowStatus: "paused-backpressure",
      isExited: false,
    });
    expect(result).toBe("paused");
  });

  it("handles paused-user flow status (no ambient state)", () => {
    const result = getAmbientState({
      agentState: "idle",
      flowStatus: "paused-user",
      isExited: false,
    });
    expect(result).toBe(null);
  });

  it("handles running flow status", () => {
    const result = getAmbientState({
      agentState: "working",
      flowStatus: "running",
      isExited: false,
    });
    expect(result).toBe(null);
  });

  it("prioritizes 'failed' over 'paused-backpressure'", () => {
    const result = getAmbientState({
      agentState: "failed",
      flowStatus: "paused-backpressure",
      isExited: false,
    });
    expect(result).toBe("failed");
  });

  it("prioritizes 'failed' over 'suspended'", () => {
    const result = getAmbientState({
      agentState: "failed",
      flowStatus: "suspended",
      isExited: false,
    });
    expect(result).toBe("failed");
  });

  it("prioritizes 'exited' over 'suspended'", () => {
    const result = getAmbientState({
      agentState: "idle",
      flowStatus: "suspended",
      isExited: true,
    });
    expect(result).toBe("exited");
  });

  it("prioritizes 'suspended' over 'waiting'", () => {
    const result = getAmbientState({
      agentState: "waiting",
      flowStatus: "suspended",
      isExited: false,
    });
    expect(result).toBe("suspended");
  });

  it("handles undefined agentState with paused-backpressure", () => {
    const result = getAmbientState({
      agentState: undefined,
      flowStatus: "paused-backpressure",
      isExited: false,
    });
    expect(result).toBe("paused");
  });

  it("handles undefined agentState with suspended", () => {
    const result = getAmbientState({
      agentState: undefined,
      flowStatus: "suspended",
      isExited: false,
    });
    expect(result).toBe("suspended");
  });

  it("handles undefined agentState with isExited true", () => {
    const result = getAmbientState({
      agentState: undefined,
      flowStatus: undefined,
      isExited: true,
    });
    expect(result).toBe("exited");
  });

  it("returns 'waiting' even when flowStatus is 'running'", () => {
    const result = getAmbientState({
      agentState: "waiting",
      flowStatus: "running",
      isExited: false,
    });
    expect(result).toBe("waiting");
  });
});

describe("getAmbientClassName", () => {
  it("returns correct class name for 'waiting'", () => {
    expect(getAmbientClassName("waiting")).toBe("terminal-ambient-waiting");
  });

  it("returns correct class name for 'failed'", () => {
    expect(getAmbientClassName("failed")).toBe("terminal-ambient-failed");
  });

  it("returns correct class name for 'paused'", () => {
    expect(getAmbientClassName("paused")).toBe("terminal-ambient-paused");
  });

  it("returns correct class name for 'suspended'", () => {
    expect(getAmbientClassName("suspended")).toBe("terminal-ambient-suspended");
  });

  it("returns correct class name for 'exited'", () => {
    expect(getAmbientClassName("exited")).toBe("terminal-ambient-exited");
  });

  it("returns null for null state", () => {
    expect(getAmbientClassName(null)).toBe(null);
  });
});
