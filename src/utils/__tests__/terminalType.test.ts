import { describe, expect, it } from "vitest";
import {
  getBuiltInRuntimeAgentId,
  getRuntimeAgentId,
  getRuntimeOrBootAgentId,
  isAgentTerminal,
} from "../terminalType";

describe("isAgentTerminal", () => {
  it("uses fresh detectedAgentId before stale runtimeIdentity", () => {
    expect(
      isAgentTerminal({
        detectedAgentId: "claude",
        runtimeIdentity: {
          kind: "process",
          id: "npm",
          iconId: "npm",
          processId: "npm",
        },
      })
    ).toBe(true);
  });

  it("falls back to detectedAgentId for legacy terminal records", () => {
    expect(isAgentTerminal({ detectedAgentId: "claude" })).toBe(true);
  });
});

describe("runtime agent identity helpers", () => {
  it("returns detectedAgentId before runtime identity", () => {
    expect(
      getRuntimeAgentId({
        detectedAgentId: "claude",
        runtimeIdentity: {
          kind: "agent",
          id: "codex",
          iconId: "codex",
          agentId: "codex",
        },
      })
    ).toBe("claude");
  });

  it("does not treat process runtime identity as an agent without detectedAgentId", () => {
    expect(
      getRuntimeAgentId({
        runtimeIdentity: {
          kind: "process",
          id: "npm",
          iconId: "npm",
          processId: "npm",
        },
      })
    ).toBeUndefined();
  });

  it("uses launch intent as durable agent affinity until explicit exit", () => {
    expect(getRuntimeOrBootAgentId({ launchAgentId: "claude" })).toBe("claude");
    expect(
      getRuntimeOrBootAgentId({
        launchAgentId: "claude",
        everDetectedAgent: true,
        agentState: "working",
      })
    ).toBe("claude");
    expect(
      getRuntimeOrBootAgentId({
        launchAgentId: "claude",
        agentState: "exited",
      })
    ).toBeUndefined();
  });

  it("treats sticky detected-but-cleared legacy records as non-agent without agentState", () => {
    expect(
      isAgentTerminal({
        launchAgentId: "claude",
        everDetectedAgent: true,
      })
    ).toBe(false);
  });

  it("narrows runtime agent ids to built-ins", () => {
    expect(getBuiltInRuntimeAgentId({ detectedAgentId: "claude" })).toBe("claude");
    expect(getBuiltInRuntimeAgentId({ detectedAgentId: "custom-agent" })).toBeUndefined();
  });
});
