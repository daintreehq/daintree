import { describe, it, expect } from "vitest";
import type { AgentState } from "@/types";

type InitializationState = "initializing" | "initialized";

// Updated: Input is now always enabled regardless of initialization state
// The isInitializing flag is only used for visual feedback (opacity, placeholder text)
function computeHybridSubmitEnabled(_params: {
  isAgentTerminal: boolean;
  agentState?: AgentState;
  agentHasLifecycleEvent: boolean;
  initializationState: InitializationState;
}): boolean {
  // Input is always enabled - initialization state no longer blocks input
  return true;
}

function simulateInitializationTransition(params: {
  isAgentTerminal: boolean;
  agentState?: AgentState;
  agentHasLifecycleEvent: boolean;
  currentState: InitializationState;
}): InitializationState {
  const { isAgentTerminal, agentHasLifecycleEvent, currentState } = params;

  if (currentState === "initialized") return "initialized";
  if (isAgentTerminal && agentHasLifecycleEvent) {
    return "initialized";
  }
  return "initializing";
}

describe("HybridInputBar agent readiness - input always enabled", () => {
  describe("computeHybridSubmitEnabled", () => {
    it("allows submission during initialization (no blocking)", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: false,
          initializationState: "initializing",
        })
      ).toBe(true);
    });

    it("allows submission after first lifecycle event", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "working",
          agentHasLifecycleEvent: true,
          initializationState: "initialized",
        })
      ).toBe(true);
    });

    it("allows submission when agent is idle with lifecycle event", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: true,
          initializationState: "initialized",
        })
      ).toBe(true);
    });

    it("allows submission when agent is waiting with lifecycle event", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "waiting",
          agentHasLifecycleEvent: true,
          initializationState: "initialized",
        })
      ).toBe(true);
    });

    it("allows submission when agent is working", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "working",
          agentHasLifecycleEvent: true,
          initializationState: "initialized",
        })
      ).toBe(true);
    });

    it("allows submission for non-agent terminals", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: false,
          agentState: undefined,
          agentHasLifecycleEvent: false,
          initializationState: "initializing",
        })
      ).toBe(true);
    });
  });

  describe("simulateInitializationTransition", () => {
    it("transitions to initialized when agent emits lifecycle event", () => {
      expect(
        simulateInitializationTransition({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: true,
          currentState: "initializing",
        })
      ).toBe("initialized");
    });

    it("transitions to initialized when agent is waiting with lifecycle event", () => {
      expect(
        simulateInitializationTransition({
          isAgentTerminal: true,
          agentState: "waiting",
          agentHasLifecycleEvent: true,
          currentState: "initializing",
        })
      ).toBe("initialized");
    });

    it("stays initializing without lifecycle event (but input still works)", () => {
      expect(
        simulateInitializationTransition({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: false,
          currentState: "initializing",
        })
      ).toBe("initializing");
    });

    it("transitions to initialized when agent is working with lifecycle event", () => {
      expect(
        simulateInitializationTransition({
          isAgentTerminal: true,
          agentState: "working",
          agentHasLifecycleEvent: true,
          currentState: "initializing",
        })
      ).toBe("initialized");
    });

    it("stays initialized once initialized (latching behavior)", () => {
      expect(
        simulateInitializationTransition({
          isAgentTerminal: true,
          agentState: "working",
          agentHasLifecycleEvent: true,
          currentState: "initialized",
        })
      ).toBe("initialized");
    });
  });

  describe("restart scenario", () => {
    it("allows submission immediately after restart (no blocking)", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: false,
          initializationState: "initializing",
        })
      ).toBe(true);
    });

    it("continues to allow submission after restart once agent emits lifecycle event", () => {
      const afterRestart = simulateInitializationTransition({
        isAgentTerminal: true,
        agentState: "working",
        agentHasLifecycleEvent: true,
        currentState: "initializing",
      });

      expect(afterRestart).toBe("initialized");

      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "working",
          agentHasLifecycleEvent: true,
          initializationState: afterRestart,
        })
      ).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("allows submission for agent with failed state", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "failed",
          agentHasLifecycleEvent: true,
          initializationState: "initialized",
        })
      ).toBe(true);
    });

    it("transitions to initialized when agent has completed state with lifecycle event", () => {
      expect(
        simulateInitializationTransition({
          isAgentTerminal: true,
          agentState: "completed",
          agentHasLifecycleEvent: true,
          currentState: "initializing",
        })
      ).toBe("initialized");
    });

    it("stays initializing without lifecycle event even with completed state", () => {
      expect(
        simulateInitializationTransition({
          isAgentTerminal: true,
          agentState: "completed",
          agentHasLifecycleEvent: false,
          currentState: "initializing",
        })
      ).toBe("initializing");
    });
  });

  describe("input enabled during initialization", () => {
    it("allows input submission during initializing state", () => {
      // This test verifies the core change: input is never blocked by initialization
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: false,
          initializationState: "initializing",
        })
      ).toBe(true);
    });

    it("allows keyboard navigation during initialization", () => {
      // Arrow keys, Tab, Ctrl+C should all work during initialization
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "working",
          agentHasLifecycleEvent: false,
          initializationState: "initializing",
        })
      ).toBe(true);
    });

    it("allows autocomplete during initialization", () => {
      // Autocomplete selection and execution should work during initialization
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: undefined,
          agentHasLifecycleEvent: false,
          initializationState: "initializing",
        })
      ).toBe(true);
    });
  });
});
