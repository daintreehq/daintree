// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalAgentStateController } from "../TerminalAgentStateController";
import type { ManagedTerminal } from "../types";

vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: {
    getState: () => ({
      updateAgentState: vi.fn(),
    }),
  },
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
}));

function makeMockManaged(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
  return {
    kind: "agent",
    agentState: undefined,
    canonicalAgentState: undefined,
    agentStateSubscribers: new Set(),
    ...overrides,
  } as unknown as ManagedTerminal;
}

describe("TerminalAgentStateController", () => {
  let controller: TerminalAgentStateController;
  let instances: Map<string, ManagedTerminal>;

  beforeEach(() => {
    vi.useFakeTimers();
    instances = new Map();
    controller = new TerminalAgentStateController({
      getInstance: (id) => instances.get(id),
    });
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
  });

  describe("setAgentState", () => {
    it("ignores directing state", () => {
      const managed = makeMockManaged();
      instances.set("t1", managed);

      controller.setAgentState("t1", "directing");
      expect(managed.agentState).toBeUndefined();
    });

    it("sets canonical and agent state", () => {
      const managed = makeMockManaged();
      instances.set("t1", managed);

      controller.setAgentState("t1", "working");
      expect(managed.canonicalAgentState).toBe("working");
      expect(managed.agentState).toBe("working");
    });

    it("does not overwrite directing with waiting", () => {
      const managed = makeMockManaged({
        agentState: "directing",
        canonicalAgentState: "waiting",
      });
      instances.set("t1", managed);

      controller.setAgentState("t1", "waiting");
      expect(managed.agentState).toBe("directing");
    });

    it("clears directing state when transitioning to non-waiting", () => {
      const managed = makeMockManaged({
        agentState: "directing",
        canonicalAgentState: "waiting",
      });
      instances.set("t1", managed);

      controller.setAgentState("t1", "working");
      expect(managed.agentState).toBe("working");
    });

    it("notifies subscribers on state change", () => {
      const callback = vi.fn();
      const managed = makeMockManaged();
      managed.agentStateSubscribers.add(callback);
      instances.set("t1", managed);

      controller.setAgentState("t1", "working");
      expect(callback).toHaveBeenCalledWith("working");
    });

    it("skips notification when state unchanged", () => {
      const callback = vi.fn();
      const managed = makeMockManaged({ agentState: "working" });
      managed.agentStateSubscribers.add(callback);
      instances.set("t1", managed);

      controller.setAgentState("t1", "working");
      expect(callback).not.toHaveBeenCalled();
    });

    it("no-ops for unknown terminal", () => {
      controller.setAgentState("nonexistent", "working");
    });
  });

  describe("onUserInput", () => {
    it("sets directing state for waiting agent on input", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1");
      expect(managed.agentState).toBe("directing");
    });

    it("does not set directing for non-agent terminals", () => {
      const managed = makeMockManaged({
        kind: "terminal",
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1");
      expect(managed.agentState).toBe("waiting");
    });

    it("does not set directing when agent is not waiting", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "working",
        agentState: "working",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1");
      expect(managed.agentState).toBe("working");
    });

    it("reverts directing state after debounce timeout", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1");
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(2500);
      expect(managed.agentState).toBe("waiting");
    });

    it("resets debounce timer on repeated input", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1");
      vi.advanceTimersByTime(2000);
      expect(managed.agentState).toBe("directing");

      controller.onUserInput("t1");
      vi.advanceTimersByTime(2000);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(500);
      expect(managed.agentState).toBe("waiting");
    });
  });

  describe("clearDirectingState", () => {
    it("reverts to canonical state", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "directing",
      });
      instances.set("t1", managed);

      controller.clearDirectingState("t1");
      expect(managed.agentState).toBe("waiting");
    });

    it("cancels pending timer", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1");
      expect(managed.agentState).toBe("directing");

      controller.clearDirectingState("t1");
      expect(managed.agentState).toBe("waiting");

      vi.advanceTimersByTime(3000);
      expect(managed.agentState).toBe("waiting");
    });

    it("no-ops when not directing", () => {
      const managed = makeMockManaged({ agentState: "working" });
      instances.set("t1", managed);

      controller.clearDirectingState("t1");
      expect(managed.agentState).toBe("working");
    });
  });

  describe("onEnterPressed", () => {
    it("immediately transitions waiting → working", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onEnterPressed("t1");
      expect(managed.agentState).toBe("working");
      expect(managed.canonicalAgentState).toBe("waiting");
    });

    it("immediately transitions directing → working and cancels timer", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1");
      expect(managed.agentState).toBe("directing");

      controller.onEnterPressed("t1");
      expect(managed.agentState).toBe("working");

      vi.advanceTimersByTime(3000);
      expect(managed.agentState).toBe("working");
    });

    it("notifies subscribers", () => {
      const callback = vi.fn();
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      managed.agentStateSubscribers.add(callback);
      instances.set("t1", managed);

      controller.onEnterPressed("t1");
      expect(callback).toHaveBeenCalledWith("working");
    });

    it("no-ops when already working", () => {
      const callback = vi.fn();
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "working",
      });
      managed.agentStateSubscribers.add(callback);
      instances.set("t1", managed);

      controller.onEnterPressed("t1");
      expect(callback).not.toHaveBeenCalled();
    });

    it("no-ops for non-agent terminals", () => {
      const managed = makeMockManaged({
        kind: "terminal",
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onEnterPressed("t1");
      expect(managed.agentState).toBe("waiting");
    });

    it("no-ops when canonicalAgentState is not waiting", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "working",
        agentState: "working",
      });
      instances.set("t1", managed);

      controller.onEnterPressed("t1");
      expect(managed.agentState).toBe("working");
    });

    it("no-ops for unknown terminal", () => {
      controller.onEnterPressed("nonexistent");
    });

    it("prevents onUserInput from reverting working to directing", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onEnterPressed("t1");
      expect(managed.agentState).toBe("working");

      controller.onUserInput("t1");
      expect(managed.agentState).toBe("working");
    });

    it("does not duplicate notification when setAgentState confirms working", () => {
      const callback = vi.fn();
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      managed.agentStateSubscribers.add(callback);
      instances.set("t1", managed);

      controller.onEnterPressed("t1");
      expect(callback).toHaveBeenCalledTimes(1);

      controller.setAgentState("t1", "working");
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe("destroy", () => {
    it("cancels active directing timer", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1");
      expect(managed.agentState).toBe("directing");

      controller.destroy("t1");

      vi.advanceTimersByTime(3000);
      expect(managed.agentState).toBe("directing");
    });
  });

  describe("dispose", () => {
    it("cancels all timers", () => {
      const m1 = makeMockManaged({ canonicalAgentState: "waiting", agentState: "waiting" });
      const m2 = makeMockManaged({ canonicalAgentState: "waiting", agentState: "waiting" });
      instances.set("t1", m1);
      instances.set("t2", m2);

      controller.onUserInput("t1");
      controller.onUserInput("t2");

      controller.dispose();

      vi.advanceTimersByTime(3000);
      expect(m1.agentState).toBe("directing");
      expect(m2.agentState).toBe("directing");
    });
  });
});
