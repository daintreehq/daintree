import { describe, expect, it } from "vitest";
import { getTerminalAgentDisplayState } from "../terminalAgentDisplayState";

const liveAgent = { isAgent: true as const, hasExited: false as const };
const exitedAgent = { isAgent: false as const, hasExited: true as const };
const bootingAgent = { isAgent: false as const, hasExited: false as const };

describe("getTerminalAgentDisplayState", () => {
  it("passes active states through during the boot window (#6650)", () => {
    expect(getTerminalAgentDisplayState(bootingAgent, "working")).toBe("working");
    expect(getTerminalAgentDisplayState(bootingAgent, "waiting")).toBe("waiting");
    expect(getTerminalAgentDisplayState(bootingAgent, "directing")).toBe("directing");
  });

  it("hides the indicator on explicit exit even if agentState is stale", () => {
    expect(getTerminalAgentDisplayState(exitedAgent, "working")).toBeUndefined();
    expect(getTerminalAgentDisplayState(exitedAgent, "waiting")).toBeUndefined();
    expect(getTerminalAgentDisplayState(exitedAgent, "directing")).toBeUndefined();
    expect(getTerminalAgentDisplayState(exitedAgent, "completed")).toBeUndefined();
    expect(getTerminalAgentDisplayState(exitedAgent, "idle")).toBeUndefined();
    expect(getTerminalAgentDisplayState(exitedAgent, undefined)).toBeUndefined();
  });

  it("hides the indicator when agentState is 'exited'", () => {
    expect(getTerminalAgentDisplayState(liveAgent, "exited")).toBeUndefined();
  });

  it("returns undefined for non-active states when not yet an agent", () => {
    expect(getTerminalAgentDisplayState(bootingAgent, undefined)).toBeUndefined();
    expect(getTerminalAgentDisplayState(bootingAgent, "idle")).toBeUndefined();
    expect(getTerminalAgentDisplayState(bootingAgent, "completed")).toBeUndefined();
  });

  it("preserves working/waiting/directing/completed glyphs when chrome is live", () => {
    expect(getTerminalAgentDisplayState(liveAgent, "working")).toBe("working");
    expect(getTerminalAgentDisplayState(liveAgent, "waiting")).toBe("waiting");
    expect(getTerminalAgentDisplayState(liveAgent, "directing")).toBe("directing");
    expect(getTerminalAgentDisplayState(liveAgent, "completed")).toBe("completed");
  });

  it("coerces idle to waiting when the agent chrome is live", () => {
    expect(getTerminalAgentDisplayState(liveAgent, "idle")).toBe("waiting");
  });

  it("coerces missing state to waiting when the agent chrome is live", () => {
    expect(getTerminalAgentDisplayState(liveAgent, undefined)).toBe("waiting");
  });
});
