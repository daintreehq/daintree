import { describe, it, expect } from "vitest";
import type { AgentState } from "@/types";
import { isAgentReady } from "@/store/slices/terminalCommandQueueSlice";

type InitializationState = "initializing" | "initialized";

function computeHybridSubmitEnabled(params: {
  isAgentTerminal: boolean;
  agentState?: AgentState;
  agentHasLifecycleEvent: boolean;
  initializationState: InitializationState;
}): boolean {
  const { isAgentTerminal, initializationState } = params;
  const isInitializing = isAgentTerminal && initializationState === "initializing";
  return !isInitializing;
}

function simulateInitializationTransition(params: {
  isAgentTerminal: boolean;
  agentState?: AgentState;
  agentHasLifecycleEvent: boolean;
  currentState: InitializationState;
}): InitializationState {
  const { isAgentTerminal, agentState, agentHasLifecycleEvent, currentState } = params;

  if (currentState === "initialized") return "initialized";
  if (isAgentTerminal && agentHasLifecycleEvent && isAgentReady(agentState)) {
    return "initialized";
  }
  return "initializing";
}

describe("HybridInputBar agent readiness gating", () => {
  describe("computeHybridSubmitEnabled", () => {
    it("blocks submission with initial placeholder idle state and no lifecycle event", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: false,
          initializationState: "initializing",
        })
      ).toBe(false);
    });

    it("blocks submission after first lifecycle event (working) before becoming ready", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "working",
          agentHasLifecycleEvent: true,
          initializationState: "initializing",
        })
      ).toBe(false);
    });

    it("allows submission after agent becomes ready (idle with lifecycle event)", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: true,
          initializationState: "initialized",
        })
      ).toBe(true);
    });

    it("allows submission after agent becomes ready (waiting with lifecycle event)", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "waiting",
          agentHasLifecycleEvent: true,
          initializationState: "initialized",
        })
      ).toBe(true);
    });

    it("allows submission when agent transitions back to working after ready", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "working",
          agentHasLifecycleEvent: true,
          initializationState: "initialized",
        })
      ).toBe(true);
    });

    it("allows submission for non-agent terminals regardless of state", () => {
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
    it("transitions to initialized when agent reaches idle with lifecycle event", () => {
      expect(
        simulateInitializationTransition({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: true,
          currentState: "initializing",
        })
      ).toBe("initialized");
    });

    it("transitions to initialized when agent reaches waiting with lifecycle event", () => {
      expect(
        simulateInitializationTransition({
          isAgentTerminal: true,
          agentState: "waiting",
          agentHasLifecycleEvent: true,
          currentState: "initializing",
        })
      ).toBe("initialized");
    });

    it("stays initializing with idle state but no lifecycle event", () => {
      expect(
        simulateInitializationTransition({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: false,
          currentState: "initializing",
        })
      ).toBe("initializing");
    });

    it("stays initializing when agent is working", () => {
      expect(
        simulateInitializationTransition({
          isAgentTerminal: true,
          agentState: "working",
          agentHasLifecycleEvent: true,
          currentState: "initializing",
        })
      ).toBe("initializing");
    });

    it("stays initialized once it has been initialized (latching behavior)", () => {
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
    it("blocks submission again after restart (initialization state reset)", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: false,
          initializationState: "initializing",
        })
      ).toBe(false);
    });

    it("allows submission after restart once agent becomes ready again", () => {
      const afterRestart = simulateInitializationTransition({
        isAgentTerminal: true,
        agentState: "idle",
        agentHasLifecycleEvent: true,
        currentState: "initializing",
      });

      expect(afterRestart).toBe("initialized");

      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: true,
          initializationState: afterRestart,
        })
      ).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles agent with failed state before becoming ready", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "failed",
          agentHasLifecycleEvent: true,
          initializationState: "initializing",
        })
      ).toBe(false);
    });

    it("handles agent with completed state", () => {
      expect(
        simulateInitializationTransition({
          isAgentTerminal: true,
          agentState: "completed",
          agentHasLifecycleEvent: true,
          currentState: "initializing",
        })
      ).toBe("initializing");
    });
  });
});
