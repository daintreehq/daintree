import { describe, it, expect } from "vitest";
import {
  AgentStateSchema,
  AgentStateChangedSchema,
  AgentSpawnedSchema,
  AgentCompletedSchema,
} from "../agent.js";

describe("AgentStateSchema (issue #5810 migration)", () => {
  it("preprocesses the retired 'running' value to 'working'", () => {
    expect(AgentStateSchema.parse("running")).toBe("working");
  });

  it.each(["idle", "working", "waiting", "directing", "completed", "exited"])(
    "accepts canonical state %s",
    (state) => {
      expect(AgentStateSchema.parse(state)).toBe(state);
    }
  );

  it("rejects unknown values", () => {
    expect(() => AgentStateSchema.parse("banana")).toThrow();
  });
});

describe("AgentStateChangedSchema (zod/mini migration, issue #10395)", () => {
  const validPayload = {
    agentId: "claude",
    terminalId: "term-1",
    state: "working",
    previousState: "idle",
    timestamp: 1735000000000,
    trigger: "output",
    confidence: 0.8,
    cwd: "/tmp/worktree",
    sessionCost: 0.12,
    sessionTokens: 1200,
    temperature: 0.5,
    heatAdded: 0.1,
    changedChars: 42,
  };

  it("accepts a full valid payload and maps retired 'running' state", () => {
    const result = AgentStateChangedSchema.safeParse({ ...validPayload, state: "running" });
    expect(result.success).toBe(true);
    expect(result.data?.state).toBe("working");
    expect(result.data?.previousState).toBe("idle");
  });

  it("maps retired 'running' in previousState too", () => {
    const result = AgentStateChangedSchema.safeParse({ ...validPayload, previousState: "running" });
    expect(result.success).toBe(true);
    expect(result.data?.previousState).toBe("working");
  });

  it.each([0, 1])("accepts boundary confidence %s", (confidence) => {
    expect(AgentStateChangedSchema.safeParse({ ...validPayload, confidence }).success).toBe(true);
  });

  it("rejects NaN confidence", () => {
    expect(AgentStateChangedSchema.safeParse({ ...validPayload, confidence: NaN }).success).toBe(
      false
    );
  });

  it("rejects negative sessionCost", () => {
    expect(
      AgentStateChangedSchema.safeParse({ ...validPayload, sessionCost: -0.001 }).success
    ).toBe(false);
  });

  it("rejects a zero timestamp", () => {
    expect(AgentStateChangedSchema.safeParse({ ...validPayload, timestamp: 0 }).success).toBe(
      false
    );
  });

  it("accepts a minimal payload without optional fields", () => {
    const result = AgentStateChangedSchema.safeParse({
      state: "waiting",
      previousState: "working",
      timestamp: 1735000000000,
      trigger: "heuristic",
      confidence: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects out-of-range confidence", () => {
    expect(AgentStateChangedSchema.safeParse({ ...validPayload, confidence: 1.5 }).success).toBe(
      false
    );
  });

  it("rejects an empty agentId", () => {
    expect(AgentStateChangedSchema.safeParse({ ...validPayload, agentId: "" }).success).toBe(false);
  });

  it("rejects a non-finite temperature", () => {
    expect(
      AgentStateChangedSchema.safeParse({ ...validPayload, temperature: Infinity }).success
    ).toBe(false);
  });

  it("rejects a non-integer timestamp", () => {
    expect(AgentStateChangedSchema.safeParse({ ...validPayload, timestamp: 1.5 }).success).toBe(
      false
    );
  });
});

describe("other migrated event schemas (zod/mini)", () => {
  it("AgentSpawnedSchema accepts a valid payload and rejects an empty terminalId", () => {
    const payload = { agentId: "claude", terminalId: "term-1", timestamp: 1735000000000 };
    expect(AgentSpawnedSchema.safeParse(payload).success).toBe(true);
    expect(AgentSpawnedSchema.safeParse({ ...payload, terminalId: "" }).success).toBe(false);
  });

  it("AgentCompletedSchema accepts a negative exitCode but rejects negative duration", () => {
    const payload = { agentId: "claude", exitCode: -1, duration: 10, timestamp: 1735000000000 };
    expect(AgentCompletedSchema.safeParse(payload).success).toBe(true);
    expect(AgentCompletedSchema.safeParse({ ...payload, duration: -1 }).success).toBe(false);
  });
});
