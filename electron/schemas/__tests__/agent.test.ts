import { describe, it, expect } from "vitest";
import { AgentStateSchema } from "../agent.js";

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
