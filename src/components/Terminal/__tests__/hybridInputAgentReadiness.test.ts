import { describe, it, expect } from "vitest";
import type { AgentState } from "@/types";
import { isAgentReady } from "@/store/slices/terminalCommandQueueSlice";

function computeHybridSubmitEnabled(params: {
  isAgentTerminal: boolean;
  agentState?: AgentState;
  agentHasLifecycleEvent: boolean;
  hasBecomeReadyOnce: boolean;
}): boolean {
  const { isAgentTerminal, hasBecomeReadyOnce } = params;
  const isInitialAgentLoading = isAgentTerminal && !hasBecomeReadyOnce;
  return !isInitialAgentLoading;
}

function simulateReadinessTransition(params: {
  isAgentTerminal: boolean;
  agentState?: AgentState;
  agentHasLifecycleEvent: boolean;
  previouslyReady: boolean;
}): boolean {
  const { isAgentTerminal, agentState, agentHasLifecycleEvent, previouslyReady } = params;

  if (previouslyReady) return true;
  if (isAgentTerminal && agentHasLifecycleEvent && isAgentReady(agentState)) {
    return true;
  }
  return false;
}

describe("HybridInputBar agent readiness gating", () => {
  describe("computeHybridSubmitEnabled", () => {
    it("blocks submission with initial placeholder idle state and no lifecycle event", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: false,
          hasBecomeReadyOnce: false,
        })
      ).toBe(false);
    });

    it("blocks submission after first lifecycle event (working) before becoming ready", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "working",
          agentHasLifecycleEvent: true,
          hasBecomeReadyOnce: false,
        })
      ).toBe(false);
    });

    it("allows submission after agent becomes ready (idle with lifecycle event)", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: true,
          hasBecomeReadyOnce: true,
        })
      ).toBe(true);
    });

    it("allows submission after agent becomes ready (waiting with lifecycle event)", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "waiting",
          agentHasLifecycleEvent: true,
          hasBecomeReadyOnce: true,
        })
      ).toBe(true);
    });

    it("allows submission when agent transitions back to working after ready", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "working",
          agentHasLifecycleEvent: true,
          hasBecomeReadyOnce: true,
        })
      ).toBe(true);
    });

    it("allows submission for non-agent terminals regardless of state", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: false,
          agentState: undefined,
          agentHasLifecycleEvent: false,
          hasBecomeReadyOnce: false,
        })
      ).toBe(true);
    });
  });

  describe("simulateReadinessTransition", () => {
    it("transitions to ready when agent reaches idle with lifecycle event", () => {
      expect(
        simulateReadinessTransition({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: true,
          previouslyReady: false,
        })
      ).toBe(true);
    });

    it("transitions to ready when agent reaches waiting with lifecycle event", () => {
      expect(
        simulateReadinessTransition({
          isAgentTerminal: true,
          agentState: "waiting",
          agentHasLifecycleEvent: true,
          previouslyReady: false,
        })
      ).toBe(true);
    });

    it("does not transition to ready with idle state but no lifecycle event", () => {
      expect(
        simulateReadinessTransition({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: false,
          previouslyReady: false,
        })
      ).toBe(false);
    });

    it("does not transition to ready when agent is working", () => {
      expect(
        simulateReadinessTransition({
          isAgentTerminal: true,
          agentState: "working",
          agentHasLifecycleEvent: true,
          previouslyReady: false,
        })
      ).toBe(false);
    });

    it("stays ready once it has been ready (latching behavior)", () => {
      expect(
        simulateReadinessTransition({
          isAgentTerminal: true,
          agentState: "working",
          agentHasLifecycleEvent: true,
          previouslyReady: true,
        })
      ).toBe(true);
    });
  });

  describe("restart scenario", () => {
    it("blocks submission again after restart (ready flag reset)", () => {
      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: false,
          hasBecomeReadyOnce: false,
        })
      ).toBe(false);
    });

    it("allows submission after restart once agent becomes ready again", () => {
      const afterRestart = simulateReadinessTransition({
        isAgentTerminal: true,
        agentState: "idle",
        agentHasLifecycleEvent: true,
        previouslyReady: false,
      });

      expect(afterRestart).toBe(true);

      expect(
        computeHybridSubmitEnabled({
          isAgentTerminal: true,
          agentState: "idle",
          agentHasLifecycleEvent: true,
          hasBecomeReadyOnce: afterRestart,
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
          hasBecomeReadyOnce: false,
        })
      ).toBe(false);
    });

    it("handles agent with completed state", () => {
      expect(
        simulateReadinessTransition({
          isAgentTerminal: true,
          agentState: "completed",
          agentHasLifecycleEvent: true,
          previouslyReady: false,
        })
      ).toBe(false);
    });
  });
});
