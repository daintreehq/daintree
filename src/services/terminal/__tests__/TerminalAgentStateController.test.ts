// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalAgentStateController } from "../TerminalAgentStateController";
import type { ManagedTerminal } from "../types";

const mockUpdateAgentState = vi.fn();
vi.mock("@/store/terminalStore", () => ({
  useTerminalStore: {
    getState: () => ({
      updateAgentState: mockUpdateAgentState,
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
    mockUpdateAgentState.mockClear();
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

      controller.onUserInput("t1", "a");
      expect(managed.agentState).toBe("directing");
    });

    it("does not set directing for non-agent terminals", () => {
      const managed = makeMockManaged({
        kind: "terminal",
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "a");
      expect(managed.agentState).toBe("waiting");
    });

    it("does not set directing when agent is not waiting", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "working",
        agentState: "working",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "a");
      expect(managed.agentState).toBe("working");
    });

    it("reverts directing state after short debounce for phase 1 (single char)", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "a");
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(1499);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(1);
      expect(managed.agentState).toBe("waiting");
    });

    it("uses long debounce for phase 2 (5+ chars)", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "hello");
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(5000);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(5000);
      expect(managed.agentState).toBe("waiting");
    });

    it("upgrades to phase 2 timeout after accumulating 5+ chars", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "ab");
      controller.onUserInput("t1", "cd");
      controller.onUserInput("t1", "e");

      vi.advanceTimersByTime(5000);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(5000);
      expect(managed.agentState).toBe("waiting");
    });

    it("resets debounce timer on repeated input (phase 1)", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "a");
      vi.advanceTimersByTime(1000);
      expect(managed.agentState).toBe("directing");

      controller.onUserInput("t1", "b");
      vi.advanceTimersByTime(1000);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(500);
      expect(managed.agentState).toBe("waiting");
    });

    it("backspace decrements composition count staying in phase 1", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      // Type "hello" (5 chars → phase 2), then backspace (4 chars → phase 1)
      controller.onUserInput("t1", "hello");
      controller.onUserInput("t1", "\x7f");

      // After backspace count is 4 (phase 1 = 1500ms debounce)
      // Should NOT survive 5000ms (which phase 2 would)
      vi.advanceTimersByTime(1499);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(1);
      expect(managed.agentState).toBe("waiting");
    });

    it("backspace does not drop count below zero", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "a");
      controller.onUserInput("t1", "\x7f");
      controller.onUserInput("t1", "\x7f");
      controller.onUserInput("t1", "\x7f");

      vi.advanceTimersByTime(1499);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(1);
      expect(managed.agentState).toBe("waiting");
    });

    it("ctrl+u resets composition count to zero", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "hello world");
      controller.onUserInput("t1", "\x15");

      vi.advanceTimersByTime(1499);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(1);
      expect(managed.agentState).toBe("waiting");
    });

    it("bracketed paste immediately enters phase 2", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "\x1b[200~hello world\x1b[201~");

      vi.advanceTimersByTime(5000);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(5000);
      expect(managed.agentState).toBe("waiting");
    });

    it("empty data does not crash and uses phase 1 timeout", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "");

      vi.advanceTimersByTime(1499);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(1);
      expect(managed.agentState).toBe("waiting");
    });

    it("empty data always uses phase 1 timeout even when count is already in phase 2", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      // Establish phase 2 with 5 chars
      controller.onUserInput("t1", "hello");
      expect(managed.agentState).toBe("directing");

      // A legacy notifyUserInput(id) call (data="") should reset debounce to phase 1
      controller.onUserInput("t1", "");

      vi.advanceTimersByTime(1499);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(1);
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

      controller.onUserInput("t1", "a");
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

    it("immediately reverts directing to waiting without advancing timers (Escape cancel)", () => {
      const callback = vi.fn();
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      managed.agentStateSubscribers.add(callback);
      instances.set("t1", managed);

      controller.onUserInput("t1", "a");
      expect(managed.agentState).toBe("directing");
      callback.mockClear();

      controller.clearDirectingState("t1");
      expect(managed.agentState).toBe("waiting");
      expect(callback).toHaveBeenCalledWith("waiting");
    });

    it("resets composition count so next input starts from phase 1", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "hello");
      controller.clearDirectingState("t1");

      controller.onUserInput("t1", "a");

      vi.advanceTimersByTime(1499);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(1);
      expect(managed.agentState).toBe("waiting");
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
      expect(mockUpdateAgentState).toHaveBeenCalledWith("t1", "working");
      expect(mockUpdateAgentState).toHaveBeenCalledTimes(1);
    });

    it("immediately transitions directing → working and cancels timer", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "a");
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
        canonicalAgentState: "completed",
        agentState: "completed",
      });
      instances.set("t1", managed);

      controller.onEnterPressed("t1");
      expect(managed.agentState).toBe("completed");
      expect(mockUpdateAgentState).not.toHaveBeenCalled();
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

      controller.onUserInput("t1", "a");
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

    it("resets composition count so next input after Enter starts from phase 1", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "hello");
      controller.onEnterPressed("t1");

      managed.agentState = "waiting";
      managed.canonicalAgentState = "waiting";

      controller.onUserInput("t1", "a");

      vi.advanceTimersByTime(1499);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(1);
      expect(managed.agentState).toBe("waiting");
    });
  });

  describe("destroy", () => {
    it("cancels active directing timer", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "a");
      expect(managed.agentState).toBe("directing");

      controller.destroy("t1");

      vi.advanceTimersByTime(3000);
      expect(managed.agentState).toBe("directing");
    });

    it("clears composition count so re-added instance starts at phase 1", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "hello");
      controller.destroy("t1");

      const managed2 = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed2);

      controller.onUserInput("t1", "a");

      vi.advanceTimersByTime(1499);
      expect(managed2.agentState).toBe("directing");

      vi.advanceTimersByTime(1);
      expect(managed2.agentState).toBe("waiting");
    });
  });

  describe("dispose", () => {
    it("cancels all timers", () => {
      const m1 = makeMockManaged({ canonicalAgentState: "waiting", agentState: "waiting" });
      const m2 = makeMockManaged({ canonicalAgentState: "waiting", agentState: "waiting" });
      instances.set("t1", m1);
      instances.set("t2", m2);

      controller.onUserInput("t1", "a");
      controller.onUserInput("t2", "a");

      controller.dispose();

      vi.advanceTimersByTime(3000);
      expect(m1.agentState).toBe("directing");
      expect(m2.agentState).toBe("directing");
    });

    it("clears all composition counts", () => {
      const m1 = makeMockManaged({ canonicalAgentState: "waiting", agentState: "waiting" });
      instances.set("t1", m1);

      controller.onUserInput("t1", "hello");
      controller.dispose();

      const m2 = makeMockManaged({ canonicalAgentState: "waiting", agentState: "waiting" });
      instances.set("t1", m2);

      controller = new TerminalAgentStateController({
        getInstance: (id) => instances.get(id),
      });

      controller.onUserInput("t1", "a");

      vi.advanceTimersByTime(1499);
      expect(m2.agentState).toBe("directing");

      vi.advanceTimersByTime(1);
      expect(m2.agentState).toBe("waiting");
    });
  });
});
