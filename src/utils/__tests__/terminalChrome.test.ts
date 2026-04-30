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

  it("returns agent chrome from live detection", () => {
    expect(deriveTerminalChrome({ detectedAgentId: "claude" })).toMatchObject({
      iconId: "claude",
      label: "Claude",
      isAgent: true,
      agentId: "claude",
      runtimeKind: "agent",
    });
  });

  it("uses stored agentPresetColor when direct panel data is passed", () => {
    expect(
      deriveTerminalChrome({
        detectedAgentId: "claude",
        agentPresetColor: "#3366ff",
      }).color
    ).toBe("#3366ff");
  });

  it("lets explicit presetColor override stored agentPresetColor", () => {
    expect(
      deriveTerminalChrome({
        detectedAgentId: "claude",
        agentPresetColor: "#3366ff",
        presetColor: "#ff6600",
      }).color
    ).toBe("#ff6600");
  });

  it("returns agent chrome from durable launch affinity until explicit exit", () => {
    expect(
      deriveTerminalChrome({
        launchAgentId: "claude",
        agentState: "working",
      })
    ).toMatchObject({
      iconId: "claude",
      label: "Claude",
      isAgent: true,
      agentId: "claude",
      runtimeKind: "agent",
    });
  });

  it("demotes launch affinity to plain terminal after explicit agent exit", () => {
    expect(
      deriveTerminalChrome({
        launchAgentId: "claude",
        agentState: "exited",
      })
    ).toMatchObject({
      iconId: null,
      label: "Terminal",
      isAgent: false,
      agentId: null,
      runtimeKind: "none",
    });
  });

  it("demotes cleared sticky detection when legacy state lacks agentState", () => {
    expect(
      deriveTerminalChrome({
        launchAgentId: "claude",
        everDetectedAgent: true,
      })
    ).toMatchObject({
      iconId: null,
      label: "Terminal",
      isAgent: false,
      agentId: null,
      runtimeKind: "none",
    });
  });

  it("shows a process icon after a launch-affinity terminal has explicitly exited", () => {
    expect(
      deriveTerminalChrome({
        launchAgentId: "claude",
        agentState: "exited",
        detectedProcessId: "npm",
      })
    ).toMatchObject({
      iconId: "npm",
      label: "npm",
      isAgent: false,
      agentId: null,
      processId: "npm",
      runtimeKind: "process",
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
