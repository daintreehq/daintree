import { describe, it, expect } from "vitest";
import { AgentStateChangeTriggerSchema, AgentStateChangedSchema } from "../agent.js";

describe("AgentStateChangeTriggerSchema with title trigger", () => {
  it("accepts 'title' as a valid trigger", () => {
    const result = AgentStateChangeTriggerSchema.safeParse("title");
    expect(result.success).toBe(true);
  });

  it("rejects invalid trigger values", () => {
    const result = AgentStateChangeTriggerSchema.safeParse("window-title");
    expect(result.success).toBe(false);
  });

  it("accepts a full state-changed payload with trigger: title", () => {
    const payload = {
      agentId: "gemini",
      state: "working",
      previousState: "waiting",
      timestamp: Date.now(),
      trigger: "title",
      confidence: 0.98,
      terminalId: "term-1",
    };
    const result = AgentStateChangedSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});
