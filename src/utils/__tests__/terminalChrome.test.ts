import { describe, expect, it } from "vitest";
import {
  deriveTerminalChrome,
  deriveTerminalRuntimeIdentity,
  terminalRuntimeIdentitiesEqual,
} from "../terminalChrome";

describe("deriveTerminalRuntimeIdentity", () => {
  it("promotes detected agents to the canonical runtime identity", () => {
    expect(
      deriveTerminalRuntimeIdentity({
        detectedAgentId: "claude",
        detectedProcessId: "npm",
      })
    ).toMatchObject({
      kind: "agent",
      id: "claude",
      iconId: "claude",
      agentId: "claude",
      processId: "npm",
    });
  });

  it("prefers fresh detected agent evidence over stale process runtime identity", () => {
    expect(
      deriveTerminalRuntimeIdentity({
        detectedAgentId: "claude",
        detectedProcessId: "claude",
        runtimeIdentity: {
          kind: "process",
          id: "npm",
          iconId: "npm",
          processId: "npm",
        },
      })
    ).toMatchObject({
      kind: "agent",
      id: "claude",
      iconId: "claude",
      agentId: "claude",
      processId: "claude",
    });
  });

  it("prefers fresh detected process evidence over stale agent runtime identity", () => {
    expect(
      deriveTerminalRuntimeIdentity({
        detectedProcessId: "npm",
        runtimeIdentity: {
          kind: "agent",
          id: "claude",
          iconId: "claude",
          agentId: "claude",
        },
      })
    ).toEqual({
      kind: "process",
      id: "npm",
      iconId: "npm",
      processId: "npm",
    });
  });

  it("uses process identity when no agent is detected", () => {
    expect(deriveTerminalRuntimeIdentity({ detectedProcessId: "NPM" })).toEqual({
      kind: "process",
      id: "npm",
      iconId: "npm",
      processId: "npm",
    });
  });

  it("returns null when no live identity exists", () => {
    expect(deriveTerminalRuntimeIdentity({})).toBeNull();
    expect(deriveTerminalRuntimeIdentity(undefined)).toBeNull();
  });
});

describe("deriveTerminalChrome", () => {
  it("returns generic terminal chrome for empty runtime state", () => {
    expect(deriveTerminalChrome()).toMatchObject({
      iconId: null,
      label: "Terminal",
      isAgent: false,
      agentId: null,
      processId: null,
      runtimeKind: "none",
    });
  });

  it("returns agent chrome from live detection only", () => {
    expect(deriveTerminalChrome({ detectedAgentId: "claude" })).toMatchObject({
      iconId: "claude",
      label: "Claude",
      isAgent: true,
      agentId: "claude",
      runtimeKind: "agent",
    });
  });

  it("returns process chrome without agent capability", () => {
    expect(deriveTerminalChrome({ detectedProcessId: "npm" })).toMatchObject({
      iconId: "npm",
      label: "npm",
      isAgent: false,
      agentId: null,
      processId: "npm",
      runtimeKind: "process",
    });
  });

  it("agent identity wins when agent and process are both present", () => {
    expect(
      deriveTerminalChrome({
        detectedAgentId: "codex",
        detectedProcessId: "npm",
      })
    ).toMatchObject({
      iconId: "codex",
      isAgent: true,
      agentId: "codex",
      processId: "npm",
    });
  });
});

describe("terminalRuntimeIdentitiesEqual", () => {
  it("compares canonical runtime identity fields", () => {
    const left = deriveTerminalRuntimeIdentity({ detectedAgentId: "claude" });
    const right = deriveTerminalRuntimeIdentity({ detectedAgentId: "claude" });
    const other = deriveTerminalRuntimeIdentity({ detectedProcessId: "npm" });

    expect(terminalRuntimeIdentitiesEqual(left, right)).toBe(true);
    expect(terminalRuntimeIdentitiesEqual(left, other)).toBe(false);
  });
});
