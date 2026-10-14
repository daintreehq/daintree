// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalAgentStateController } from "../TerminalAgentStateController";
import type { ManagedTerminal, PostCompleteHook } from "../types";

const mockUpdateAgentState = vi.fn();
vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      updateAgentState: mockUpdateAgentState,
    }),
  },
}));

const mockLogError = vi.fn();
vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logError: (...args: unknown[]) => mockLogError(...args),
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

    it("no-ops for unknown terminal", () => {
      controller.onEnterPressed("nonexistent");
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

    it("reverts to canonical state when set", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "completed",
        agentState: "directing",
      });
      instances.set("t1", managed);

      controller.checkStaleDirecting("t1");
      expect(managed.agentState).toBe("completed");
    });

    it("no-ops for unknown terminal", () => {
      controller.checkStaleDirecting("nonexistent");
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

    it("does not sweep when visibilityState is hidden", () => {
      const managed = makeMockManaged({
        canonicalAgentState: "waiting",
        agentState: "waiting",
      });
      instances.set("t1", managed);

      controller.onUserInput("t1", "a");

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });

      try {
        vi.setSystemTime(Date.now() + 20000);
        document.dispatchEvent(new Event("visibilitychange"));
        expect(managed.agentState).toBe("directing");
      } finally {
        // The override lives on the instance; deleting it re-exposes the
        // prototype getter, so later suites see "visible" again.
        delete (document as { visibilityState?: unknown }).visibilityState;
      }
    });
  });

  describe("composer draft hold", () => {
    function waitingAgent(id = "t1"): ManagedTerminal {
      const managed = makeMockManaged({ canonicalAgentState: "waiting", agentState: "waiting" });
      instances.set(id, managed);
      return managed;
    }

    it("holds directing through a thinking pause with an unsent draft", () => {
      const managed = waitingAgent();

      controller.onComposerDraft("t1");
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(60_000);
      expect(managed.agentState).toBe("directing");
    });

    it("each edit restarts the abandonment ceiling, which then clears an abandoned draft", () => {
      const managed = waitingAgent();

      controller.onComposerDraft("t1");
      vi.advanceTimersByTime(100_000);
      controller.onComposerDraft("t1");
      vi.advanceTimersByTime(100_000);
      expect(managed.agentState).toBe("directing");

      vi.advanceTimersByTime(20_000);
      expect(managed.agentState).toBe("waiting");
      expect(mockUpdateAgentState).toHaveBeenLastCalledWith("t1", "waiting");
    });

    it("visibility sweep spares a held draft past the 15s cap but not past the ceiling", () => {
      const managed = waitingAgent();
      const t0 = Date.now();
      controller.onComposerDraft("t1");

      vi.setSystemTime(t0 + 30_000);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(managed.agentState).toBe("directing");

      vi.setSystemTime(t0 + 130_000);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(managed.agentState).toBe("waiting");
    });

    it("xterm input during a held draft does not shorten the hold", () => {
      const managed = waitingAgent();
      controller.onComposerDraft("t1");

      controller.onUserInput("t1", "");
      vi.advanceTimersByTime(30_000);
      expect(managed.agentState).toBe("directing");
    });

    it("releasing the draft falls back to the short bridge", () => {
      const managed = waitingAgent();
      controller.onComposerDraft("t1");
      vi.advanceTimersByTime(30_000);

      controller.releaseComposerDraft("t1");
      vi.advanceTimersByTime(1499);
      expect(managed.agentState).toBe("directing");
      vi.advanceTimersByTime(1);
      expect(managed.agentState).toBe("waiting");
    });

    it("release is a no-op without a hold", () => {
      const managed = waitingAgent();
      controller.onUserInput("t1", "hello");

      controller.releaseComposerDraft("t1");
      vi.advanceTimersByTime(9999);
      expect(managed.agentState).toBe("directing");
      vi.advanceTimersByTime(1);
      expect(managed.agentState).toBe("waiting");
    });

    it("sweeps an unheld pane at the 15s cap while a held draft survives", () => {
      const held = waitingAgent("t1");
      const typed = waitingAgent("t2");
      const t0 = Date.now();
      controller.onComposerDraft("t1");
      controller.onUserInput("t2", "a");

      vi.setSystemTime(t0 + 15_000);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(held.agentState).toBe("directing");
      expect(typed.agentState).toBe("waiting");

      vi.setSystemTime(t0 + 120_000);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(held.agentState).toBe("waiting");
    });

    it.each([
      ["escape", (c: TerminalAgentStateController) => c.clearDirectingState("t1", "escape-key")],
      ["enter", (c: TerminalAgentStateController) => c.onEnterPressed("t1")],
      ["canonical change", (c: TerminalAgentStateController) => c.setAgentState("t1", "working")],
    ])("%s ends the hold so the next spell uses the keystroke debounce", (_label, end) => {
      const managed = waitingAgent();
      controller.onComposerDraft("t1");
      end(controller);
      expect(managed.agentState).not.toBe("directing");

      controller.setAgentState("t1", "waiting");
      controller.onUserInput("t1", "a");
      expect(managed.agentState).toBe("directing");
      vi.advanceTimersByTime(1500);
      expect(managed.agentState).toBe("waiting");
    });

    it("destroy drops the hold", () => {
      const managed = waitingAgent();
      controller.onComposerDraft("t1");
      controller.destroy("t1");

      managed.agentState = "waiting";
      controller.onUserInput("t1", "a");
      vi.advanceTimersByTime(1500);
      expect(managed.agentState).toBe("waiting");
    });

    it("does not enter directing while the agent is working", () => {
      const managed = makeMockManaged({ canonicalAgentState: "working", agentState: "working" });
      instances.set("t1", managed);

      controller.onComposerDraft("t1");
      expect(managed.agentState).toBe("working");
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

describe("TerminalAgentStateController — postCompleteHook", () => {
  function makeMockBufferLine(text: string) {
    return {
      translateToString: (trimRight?: boolean) => (trimRight ? text.trimEnd() : text),
    };
  }

  function makeMockBuffer(lines: string[]) {
    return {
      active: {
        length: lines.length,
        getLine: (i: number) => (i >= 0 && i < lines.length ? makeMockBufferLine(lines[i]!) : null),
        baseY: 0,
        type: "normal",
      },
    };
  }

  function makeMockMarker(line: number) {
    return {
      line,
      isDisposed: false,
      dispose: vi.fn(),
      onDispose: { dispose: vi.fn() },
    };
  }

  function makeHookManaged(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
    return {
      kind: "terminal",
      agentState: undefined,
      canonicalAgentState: undefined,
      agentStateSubscribers: new Set(),
      terminal: {
        buffer: makeMockBuffer([]),
        registerMarker: vi.fn(() => makeMockMarker(0)),
      },
      ...overrides,
    } as unknown as ManagedTerminal;
  }

  let controller: TerminalAgentStateController;
  let instances: Map<string, ManagedTerminal>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockUpdateAgentState.mockClear();
    mockLogError.mockClear();
    instances = new Map();
    controller = new TerminalAgentStateController({
      getInstance: (id) => instances.get(id),
    });
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
  });

  it("fires hook on working → waiting transition", () => {
    const hook = vi.fn();
    const bufferLines = ["$ claude", "Working on task...", "Done."];
    const managed = makeHookManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(bufferLines) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
      postCompleteMarker: undefined,
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");

    expect(hook).toHaveBeenCalledOnce();
    expect(hook).toHaveBeenCalledWith("$ claude\nWorking on task...\nDone.");
  });

  it("extracts output from marker line to buffer end", () => {
    const hook = vi.fn();
    const bufferLines = ["old line 1", "old line 2", "new output 1", "new output 2"];
    const marker = makeMockMarker(2);
    const managed = makeHookManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(bufferLines) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
      postCompleteMarker: marker as unknown as ManagedTerminal["postCompleteMarker"],
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");

    expect(hook).toHaveBeenCalledWith("new output 1\nnew output 2");
    expect(marker.dispose).toHaveBeenCalled();
  });

  it("is one-shot — second working → waiting does not fire again", () => {
    const hook = vi.fn();
    const managed = makeHookManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(["line"]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");
    expect(hook).toHaveBeenCalledOnce();

    // Transition back to working, then to waiting again
    managed.agentState = "working";
    controller.setAgentState("t1", "waiting");
    expect(hook).toHaveBeenCalledOnce(); // still once
  });

  it("does not fire on idle → waiting", () => {
    const hook = vi.fn();
    const managed = makeHookManaged({
      agentState: "idle",
      terminal: { buffer: makeMockBuffer([]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");
    expect(hook).not.toHaveBeenCalled();
  });

  it("does not fire on working → idle", () => {
    const hook = vi.fn();
    const managed = makeHookManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer([]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "idle");
    expect(hook).not.toHaveBeenCalled();
  });

  it("does not fire on directing → waiting (revert)", () => {
    const hook = vi.fn();
    const managed = makeHookManaged({
      agentState: "directing",
      canonicalAgentState: "waiting",
      terminal: { buffer: makeMockBuffer([]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");
    // The directing → waiting guard returns early, so hook is not fired
    expect(hook).not.toHaveBeenCalled();
  });

  it("falls back to startLine 0 when marker is disposed", () => {
    const hook = vi.fn();
    const marker = makeMockMarker(5);
    marker.isDisposed = true;
    const bufferLines = ["line 0", "line 1", "line 2"];
    const managed = makeHookManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(bufferLines) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
      postCompleteMarker: marker as unknown as ManagedTerminal["postCompleteMarker"],
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");

    expect(hook).toHaveBeenCalledWith("line 0\nline 1\nline 2");
  });

  it("falls back to startLine 0 when marker line is negative", () => {
    const hook = vi.fn();
    const marker = makeMockMarker(-1);
    const bufferLines = ["all", "lines"];
    const managed = makeHookManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(bufferLines) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
      postCompleteMarker: marker as unknown as ManagedTerminal["postCompleteMarker"],
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");

    expect(hook).toHaveBeenCalledWith("all\nlines");
  });

  it("catches sync errors from hook callback", () => {
    const hook = vi.fn().mockImplementation(() => {
      throw new Error("hook exploded");
    });
    const managed = makeHookManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(["x"]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
    });
    instances.set("t1", managed);

    expect(() => controller.setAgentState("t1", "waiting")).not.toThrow();
    expect(mockLogError).toHaveBeenCalledWith("Post-complete hook error", expect.any(Error));
  });

  it("catches async errors from hook callback", async () => {
    const hook = vi.fn().mockRejectedValue(new Error("async boom"));
    const managed = makeHookManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(["x"]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");

    // Flush the rejected promise
    await vi.advanceTimersByTimeAsync(0);

    expect(mockLogError).toHaveBeenCalledWith("Post-complete hook error", expect.any(Error));
  });

  it("clears hook and marker fields on managed after firing", () => {
    const hook = vi.fn();
    const marker = makeMockMarker(0);
    const managed = makeHookManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(["x"]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
      postCompleteMarker: marker as unknown as ManagedTerminal["postCompleteMarker"],
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");

    expect(managed.postCompleteHook).toBeUndefined();
    expect(managed.postCompleteMarker).toBeUndefined();
  });

  it("still notifies subscribers after hook fires", () => {
    const hook = vi.fn();
    const subscriber = vi.fn();
    const managed = makeHookManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer([]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
    });
    managed.agentStateSubscribers.add(subscriber);
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");

    expect(hook).toHaveBeenCalledOnce();
    expect(subscriber).toHaveBeenCalledWith("waiting");
  });

  it("produces empty string when buffer is empty", () => {
    const hook = vi.fn();
    const managed = makeHookManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer([]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");

    expect(hook).toHaveBeenCalledWith("");
  });
});
