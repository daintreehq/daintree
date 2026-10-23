import { describe, expect, it } from "vitest";
import { isAgentBusy } from "../agentTask.js";

describe("agent activity", () => {
  it("treats a mid-turn agent as busy and a waiting one as reachable", () => {
    expect(isAgentBusy("working")).toBe(true);
    expect(isAgentBusy("directing")).toBe(true);
    expect(isAgentBusy("waiting")).toBe(false);
    expect(isAgentBusy("idle")).toBe(false);
    expect(isAgentBusy(null)).toBe(false);
  });
});
