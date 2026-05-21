import { describe, it, expect, vi } from "vitest";
import {
  dispatchToolbarVisibility,
  type ToolbarVisibilityDispatchDeps,
} from "@/lib/toolbarVisibilityDispatch";
import type { AgentSettings, CliAvailability } from "@shared/types";

function makeDeps(
  overrides: Partial<ToolbarVisibilityDispatchDeps> = {}
): ToolbarVisibilityDispatchDeps {
  return {
    agentSettings: null,
    agentAvailability: null,
    setAgentPinned: vi.fn(),
    toggleButtonVisibility: vi.fn(),
    ...overrides,
  };
}

describe("dispatchToolbarVisibility", () => {
  it.each(["ready", "installed", "blocked", "unauthenticated"] as const)(
    "undefined-pinned agent + %s availability flips to false (hide — already visible)",
    (state) => {
      const deps = makeDeps({
        agentSettings: { agents: {} } as AgentSettings,
        agentAvailability: { claude: state } as unknown as CliAvailability,
      });
      dispatchToolbarVisibility("claude", "left", deps);
      expect(deps.setAgentPinned).toHaveBeenCalledWith("claude", false);
      expect(deps.toggleButtonVisibility).not.toHaveBeenCalled();
    }
  );

  it("undefined-pinned agent + missing availability flips to true (show)", () => {
    const deps = makeDeps({
      agentSettings: { agents: {} } as AgentSettings,
      agentAvailability: { claude: "missing" } as unknown as CliAvailability,
    });
    dispatchToolbarVisibility("claude", "left", deps);
    expect(deps.setAgentPinned).toHaveBeenCalledWith("claude", true);
  });

  it("explicitly pinned (true) agent flips to false regardless of availability", () => {
    const deps = makeDeps({
      agentSettings: { agents: { claude: { pinned: true } } } as AgentSettings,
      agentAvailability: { claude: "missing" } as unknown as CliAvailability,
    });
    dispatchToolbarVisibility("claude", "left", deps);
    expect(deps.setAgentPinned).toHaveBeenCalledWith("claude", false);
  });

  it("explicitly unpinned (false) agent flips to true regardless of availability", () => {
    const deps = makeDeps({
      agentSettings: { agents: { claude: { pinned: false } } } as AgentSettings,
      agentAvailability: { claude: "ready" } as unknown as CliAvailability,
    });
    dispatchToolbarVisibility("claude", "left", deps);
    expect(deps.setAgentPinned).toHaveBeenCalledWith("claude", true);
  });

  it("explicitPinned=false bypasses availability lookup", () => {
    const deps = makeDeps({
      agentSettings: null,
      agentAvailability: null,
    });
    dispatchToolbarVisibility("claude", "left", deps, false);
    expect(deps.setAgentPinned).toHaveBeenCalledWith("claude", false);
  });

  it("explicitPinned=true bypasses availability lookup", () => {
    const deps = makeDeps({
      agentSettings: null,
      agentAvailability: null,
    });
    dispatchToolbarVisibility("claude", "left", deps, true);
    expect(deps.setAgentPinned).toHaveBeenCalledWith("claude", true);
  });

  it("non-agent button routes through toggleButtonVisibility on the requested side", () => {
    const deps = makeDeps();
    dispatchToolbarVisibility("terminal", "right", deps);
    expect(deps.toggleButtonVisibility).toHaveBeenCalledWith("terminal", "right");
    expect(deps.setAgentPinned).not.toHaveBeenCalled();
  });

  it("non-agent button respects left vs right", () => {
    const deps = makeDeps();
    dispatchToolbarVisibility("browser", "left", deps);
    expect(deps.toggleButtonVisibility).toHaveBeenCalledWith("browser", "left");
  });

  it("agent-tray is not an agent ID — routes through toggleButtonVisibility", () => {
    const deps = makeDeps();
    dispatchToolbarVisibility("agent-tray", "left", deps);
    expect(deps.toggleButtonVisibility).toHaveBeenCalledWith("agent-tray", "left");
    expect(deps.setAgentPinned).not.toHaveBeenCalled();
  });

  it("plugin button routes through toggleButtonVisibility", () => {
    const deps = makeDeps();
    dispatchToolbarVisibility("plugin.foo.bar", "right", deps);
    expect(deps.toggleButtonVisibility).toHaveBeenCalledWith("plugin.foo.bar", "right");
    expect(deps.setAgentPinned).not.toHaveBeenCalled();
  });

  it("null agentSettings treated as no entry — flips on availability alone", () => {
    const deps = makeDeps({
      agentSettings: null,
      agentAvailability: { gemini: "ready" } as unknown as CliAvailability,
    });
    dispatchToolbarVisibility("gemini", "left", deps);
    expect(deps.setAgentPinned).toHaveBeenCalledWith("gemini", false);
  });

  it("null agentAvailability treated as missing — flips undefined-pinned agent to true", () => {
    const deps = makeDeps({
      agentSettings: { agents: {} } as AgentSettings,
      agentAvailability: null,
    });
    dispatchToolbarVisibility("gemini", "left", deps);
    expect(deps.setAgentPinned).toHaveBeenCalledWith("gemini", true);
  });
});
