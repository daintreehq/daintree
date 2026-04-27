// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalAgentStateController } from "../TerminalAgentStateController";
import type { ManagedTerminal } from "../types";

const mockUpdateAgentState = vi.fn();
vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      updateAgentState: mockUpdateAgentState,
    }),
  },
}));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

function makeMockManaged(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
  const managed = {
    kind: "terminal",
    launchAgentId: "claude",
    agentState: undefined,
    canonicalAgentState: undefined,
    agentStateSubscribers: new Set(),
    ...overrides,
  } as unknown as ManagedTerminal;
  managed.runtimeAgentId ??= managed.launchAgentId;
  return managed;
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
        launchAgentId: undefined,
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

      vi.advanceTimersByTime(9999);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(1);
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

      vi.advanceTimersByTime(9999);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(1);
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

    it("upgrades from phase 1 to phase 2 mid-session when 5th char typed after delay", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      // Type 4 chars (phase 1)
      controller.onUserInput("t1", "abcd");
      vi.advanceTimersByTime(1400);
      expect(managed.agentState).toBe("directing");

      // Type 5th char — should upgrade to phase 2 (10000ms from this keystroke)
      controller.onUserInput("t1", "e");

      // Should survive well past phase 1 timeout
      vi.advanceTimersByTime(9999);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(1);
      expect(managed.agentState).toBe("waiting");
    });

    it("independent composition counts across multiple terminals", () => {
      const m1 = makeMockManaged({ canonicalAgentState: "waiting", agentState: "waiting" });
      const m2 = makeMockManaged({ canonicalAgentState: "waiting", agentState: "waiting" });
      instances.set("t1", m1);
      instances.set("t2", m2);

      // t1 enters phase 2 with 5 chars
      controller.onUserInput("t1", "hello");
      // t2 stays in phase 1 with 1 char
      controller.onUserInput("t2", "a");

      // After 1500ms, t2 (phase 1) should expire, t1 (phase 2) should hold
      vi.advanceTimersByTime(1500);
      expect(m1.agentState).toBe("directing");
      expect(m2.agentState).toBe("waiting");

      // t1 should expire at 10000ms
      vi.advanceTimersByTime(8500);
      expect(m1.agentState).toBe("waiting");
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

      vi.advanceTimersByTime(9999);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(1);
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

    it("empty data preserves phase 2 timeout when count is already in phase 2", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      // Establish phase 2 with 5 chars
      controller.onUserInput("t1", "hello");
      expect(managed.agentState).toBe("directing");

      // A legacy notifyUserInput(id) call (data="") should preserve phase 2
      controller.onUserInput("t1", "");

      vi.advanceTimersByTime(9999);
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
        launchAgentId: undefined,
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

  describe("checkStaleDirecting", () => {
    it("reverts directing when no timer is tracking it (rehydration)", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "directing",
      });
      instances.set("t1", managed);

      controller.checkStaleDirecting("t1");
      expect(managed.agentState).toBe("waiting");
      expect(mockUpdateAgentState).toHaveBeenCalledWith("t1", "waiting");
    });

    it("preserves directing when an active timer is tracking it", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "a");
      expect(managed.agentState).toBe("directing");
      mockUpdateAgentState.mockClear();

      controller.checkStaleDirecting("t1");
      expect(managed.agentState).toBe("directing");
      expect(mockUpdateAgentState).not.toHaveBeenCalled();
    });

    it("no-ops when terminal is not directing", () => {
      const managed = makeMockManaged({ agentState: "waiting" });
      instances.set("t1", managed);

      controller.checkStaleDirecting("t1");
      expect(managed.agentState).toBe("waiting");
      expect(mockUpdateAgentState).not.toHaveBeenCalled();
    });

    it("no-ops for unknown terminal", () => {
      controller.checkStaleDirecting("nonexistent");
    });

    it("reverts to canonical state when set", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "completed",
        agentState: "directing",
      });
      instances.set("t1", managed);

      controller.checkStaleDirecting("t1");
      expect(managed.agentState).toBe("completed");
    });
  });

  describe("wall-clock guardrail (visibilitychange)", () => {
    it("clears stuck directing on visibility restore after threshold", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "a");
      expect(managed.agentState).toBe("directing");

      // Simulate Chromium IntensiveWakeUpThrottling: wall clock advances past
      // the 15s cap, but the backgrounded debounce timer never fires.
      vi.setSystemTime(Date.now() + 20000);
      document.dispatchEvent(new Event("visibilitychange"));

      expect(managed.agentState).toBe("waiting");
      expect(mockUpdateAgentState).toHaveBeenCalledWith("t1", "waiting");
    });

    it("does not clear entries newer than the cap", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "a");
      expect(managed.agentState).toBe("directing");

      vi.setSystemTime(Date.now() + 5000);
      document.dispatchEvent(new Event("visibilitychange"));

      expect(managed.agentState).toBe("directing");
    });

    it("sweeps multiple stuck terminals in a single pass", () => {
      const m1 = makeMockManaged({ canonicalAgentState: "waiting", agentState: "waiting" });
      const m2 = makeMockManaged({ canonicalAgentState: "waiting", agentState: "waiting" });
      instances.set("t1", m1);
      instances.set("t2", m2);

      controller.onUserInput("t1", "a");
      controller.onUserInput("t2", "b");

      vi.setSystemTime(Date.now() + 20000);
      document.dispatchEvent(new Event("visibilitychange"));

      expect(m1.agentState).toBe("waiting");
      expect(m2.agentState).toBe("waiting");
    });

    it("refreshes wall-clock on each keystroke (active typing not swept)", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      // Simulate a long typing session where each keystroke advances the
      // wall clock but the user keeps interacting (the debounce timer is
      // continuously reset).
      controller.onUserInput("t1", "a");
      vi.setSystemTime(Date.now() + 7000);
      controller.onUserInput("t1", "b");
      vi.setSystemTime(Date.now() + 7000);
      controller.onUserInput("t1", "c");
      vi.setSystemTime(Date.now() + 7000);

      // Total elapsed: 21s. Last keystroke was 7s ago — under the cap.
      document.dispatchEvent(new Event("visibilitychange"));
      expect(managed.agentState).toBe("directing");
    });

    it("sweeps when last keystroke was 15s+ ago even if a timer is still pending", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      // Single keystroke schedules a 1500ms debounce. setSystemTime advances
      // the wall clock without firing the queued timer — this models
      // Chromium IntensiveWakeUpThrottling delaying the timer in a
      // backgrounded view.
      controller.onUserInput("t1", "a");
      vi.setSystemTime(Date.now() + 20000);

      document.dispatchEvent(new Event("visibilitychange"));
      expect(managed.agentState).toBe("waiting");
    });

    it("does not sweep when visibilityState is hidden", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "a");

      const original = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });

      try {
        vi.setSystemTime(Date.now() + 20000);
        document.dispatchEvent(new Event("visibilitychange"));
        expect(managed.agentState).toBe("directing");
      } finally {
        if (original) {
          Object.defineProperty(Document.prototype, "visibilityState", original);
        } else {
          delete (document as { visibilityState?: unknown }).visibilityState;
        }
      }
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

    it("removes the visibilitychange listener", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "a");
      expect(managed.agentState).toBe("directing");

      controller.dispose();

      // After dispose, a stale visibility event must not touch the (still
      // "directing") managed instance — the listener is gone.
      vi.setSystemTime(Date.now() + 20000);
      const before = mockUpdateAgentState.mock.calls.length;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(mockUpdateAgentState.mock.calls.length).toBe(before);
    });
  });
});
