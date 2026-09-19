import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";

vi.mock("electron", () => {
  let nextId = 1;
  const activeBlockers = new Set<number>();
  return {
    powerSaveBlocker: {
      start: vi.fn(() => {
        const id = nextId++;
        activeBlockers.add(id);
        return id;
      }),
      stop: vi.fn((id: number) => {
        activeBlockers.delete(id);
      }),
      isStarted: vi.fn((id: number) => activeBlockers.has(id)),
    },
  };
});

import { powerSaveBlocker } from "electron";
import {
  PowerSaveBlockerService,
  initializePowerSaveBlockerService,
  disposePowerSaveBlockerService,
  type TerminalRegistry,
} from "../PowerSaveBlockerService.js";
import { events } from "../events.js";
import type { AgentState } from "../../../shared/types/agent.js";

function emitStateChanged(
  terminalId: string,
  state: string,
  opts: { agentId?: string; previousState?: string } = {}
) {
  events.emit("agent:state-changed", {
    terminalId,
    agentId: opts.agentId,
    state: state as AgentState,
    previousState: (opts.previousState ?? "idle") as AgentState,
    timestamp: Date.now(),
    trigger: "output" as const,
    confidence: 1.0,
  });
}

describe("PowerSaveBlockerService", () => {
  let service: PowerSaveBlockerService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    service = new PowerSaveBlockerService();
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });

  describe("blocker lifecycle", () => {
    it("starts blocker when first agent enters working state", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });

      expect(powerSaveBlocker.start).toHaveBeenCalledWith("prevent-app-suspension");
      expect(service.isBlocking()).toBe(true);
      expect(service.getActiveCount()).toBe(1);
    });

    it("stops blocker when last agent leaves working state", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });
      emitStateChanged("term-1", "idle", {
        agentId: "agent-1",
        previousState: "working",
      });

      expect(powerSaveBlocker.stop).toHaveBeenCalled();
      expect(service.isBlocking()).toBe(false);
      expect(service.getActiveCount()).toBe(0);
    });

    it("does not start blocker for waiting state", () => {
      emitStateChanged("term-1", "waiting", { agentId: "agent-1" });

      expect(powerSaveBlocker.start).not.toHaveBeenCalled();
      expect(service.isBlocking()).toBe(false);
    });

    it("does not start blocker for idle state", () => {
      emitStateChanged("term-1", "idle", { agentId: "agent-1" });

      expect(powerSaveBlocker.start).not.toHaveBeenCalled();
      expect(service.isBlocking()).toBe(false);
    });

    it("does not start blocker for completed state", () => {
      emitStateChanged("term-1", "completed", { agentId: "agent-1" });

      expect(powerSaveBlocker.start).not.toHaveBeenCalled();
    });
  });

  describe("multi-agent refcounting", () => {
    it("keeps blocker active while any agent is working", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });
      emitStateChanged("term-2", "working", { agentId: "agent-2" });

      expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
      expect(service.getActiveCount()).toBe(2);

      emitStateChanged("term-1", "idle", { agentId: "agent-1" });

      expect(service.isBlocking()).toBe(true);
      expect(service.getActiveCount()).toBe(1);
      expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
    });

    it("stops blocker when all agents become idle", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });
      emitStateChanged("term-2", "working", { agentId: "agent-2" });

      emitStateChanged("term-1", "idle", { agentId: "agent-1" });
      emitStateChanged("term-2", "idle", { agentId: "agent-2" });

      expect(service.isBlocking()).toBe(false);
      expect(powerSaveBlocker.stop).toHaveBeenCalled();
    });
  });

  describe("cleanup events", () => {
    it("removes terminal on agent:exited", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });

      events.emit("agent:exited", {
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      expect(service.isBlocking()).toBe(false);
      expect(service.getActiveCount()).toBe(0);
    });

    it("removes terminal on agent:completed", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });

      events.emit("agent:completed", {
        agentId: "agent-1",
        terminalId: "term-1",
        exitCode: 0,
        duration: 1000,
        timestamp: Date.now(),
      });

      expect(service.isBlocking()).toBe(false);
      expect(service.getActiveCount()).toBe(0);
    });

    it("removes terminal on agent:killed", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });

      events.emit("agent:killed", {
        agentId: "agent-1",
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      expect(service.isBlocking()).toBe(false);
      expect(service.getActiveCount()).toBe(0);
    });

    it("killed without terminalId does not affect active blockers", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });

      events.emit("agent:killed", {
        agentId: "agent-1",
        timestamp: Date.now(),
      });

      // Blocker stays active since terminalId was not provided
      expect(service.isBlocking()).toBe(true);
    });

    it("completed without terminalId does not affect active blockers", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });

      events.emit("agent:completed", {
        agentId: "agent-1",
        exitCode: 0,
        duration: 1000,
        timestamp: Date.now(),
      });

      // Blocker stays active since terminalId was not provided
      expect(service.isBlocking()).toBe(true);
    });

    it("terminal reuse after exit works correctly", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });

      events.emit("agent:exited", {
        terminalId: "term-1",
        timestamp: Date.now(),
      });

      expect(service.isBlocking()).toBe(false);

      // Reuse the same terminal with a new agent
      emitStateChanged("term-1", "working", { agentId: "agent-2" });

      expect(service.isBlocking()).toBe(true);
      expect(service.getActiveCount()).toBe(1);
    });

    it("unknown agent events do not affect active blockers", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });

      events.emit("agent:killed", {
        agentId: "unknown-agent",
        terminalId: "unknown-term",
        timestamp: Date.now(),
      });

      events.emit("agent:completed", {
        agentId: "unknown-agent",
        terminalId: "unknown-term",
        exitCode: 0,
        duration: 0,
        timestamp: Date.now(),
      });

      expect(service.isBlocking()).toBe(true);
      expect(service.getActiveCount()).toBe(1);
    });

    it("handles unknown terminalId on exited gracefully", () => {
      events.emit("agent:exited", {
        terminalId: "unknown-term",
        timestamp: Date.now(),
      });

      expect(service.isBlocking()).toBe(false);
    });
  });

  describe("safety timeout", () => {
    it("releases blocker after 4 hours", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });

      vi.advanceTimersByTime(4 * 60 * 60 * 1000);

      expect(service.isBlocking()).toBe(false);
      expect(powerSaveBlocker.stop).toHaveBeenCalled();
    });

    it("clears safety timer when blocker is stopped normally", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });
      emitStateChanged("term-1", "idle", { agentId: "agent-1" });

      // Advancing past timeout should not cause issues
      vi.advanceTimersByTime(4 * 60 * 60 * 1000);

      // stop was called once when agent went idle, not again from timeout
      expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
    });

    it("recovers after safety timeout when new agent starts working", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });

      vi.advanceTimersByTime(4 * 60 * 60 * 1000);
      expect(service.isBlocking()).toBe(false);

      // New agent starts working — blocker should reacquire
      emitStateChanged("term-2", "working", { agentId: "agent-2" });
      expect(service.isBlocking()).toBe(true);
    });

    it("resets safety timer on new blocker acquisition", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });
      emitStateChanged("term-1", "idle", { agentId: "agent-1" });

      // Start a new blocker
      emitStateChanged("term-2", "working", { agentId: "agent-2" });

      // Advance 3 hours (should not trigger since new timer started)
      vi.advanceTimersByTime(3 * 60 * 60 * 1000);
      expect(service.isBlocking()).toBe(true);

      // Advance 1 more hour (4h from second start)
      vi.advanceTimersByTime(1 * 60 * 60 * 1000);
      expect(service.isBlocking()).toBe(false);
    });
  });

  describe("safety checkpoint with a terminal registry", () => {
    const HOUR = 60 * 60 * 1000;
    let liveTerminals: Set<string>;
    let registry: TerminalRegistry & { hasTerminal: Mock<(id: string) => boolean> };

    beforeEach(() => {
      liveTerminals = new Set();
      registry = { hasTerminal: vi.fn((id: string) => liveTerminals.has(id)) };
      service.setTerminalRegistry(registry);
    });

    function startLiveWorking(terminalId: string) {
      liveTerminals.add(terminalId);
      emitStateChanged(terminalId, "working");
    }

    it("keeps a steadily working fleet protected through the 4h and 8h checkpoints on one assertion", () => {
      // The fleet emits nothing after its first working event; the old cutoff
      // released it at 4h and cleared the map so nothing could reacquire.
      startLiveWorking("term-1");
      startLiveWorking("term-2");
      startLiveWorking("term-3");

      vi.advanceTimersByTime(4 * HOUR);
      expect(service.isBlocking()).toBe(true);
      expect(service.getActiveCount()).toBe(3);

      vi.advanceTimersByTime(4 * HOUR);
      expect(service.isBlocking()).toBe(true);
      expect(service.getActiveCount()).toBe(3);

      expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
      expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
    });

    it("releases and clears at 12 hours even while every terminal still exists", () => {
      // A terminal wedged at working looks exactly like a busy one, so the cap
      // is the leak guarantee and must not depend on anything the fleet reports.
      startLiveWorking("term-1");

      vi.advanceTimersByTime(12 * HOUR - 1);
      expect(service.isBlocking()).toBe(true);

      vi.advanceTimersByTime(1);
      expect(service.isBlocking()).toBe(false);
      expect(service.getActiveCount()).toBe(0);
      expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not move the cap when another terminal starts working mid-lease", () => {
      startLiveWorking("term-1");
      vi.advanceTimersByTime(11 * HOUR);

      startLiveWorking("term-2");
      expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1 * HOUR);
      expect(service.isBlocking()).toBe(false);
      expect(service.getActiveCount()).toBe(0);
    });

    it("releases at the first checkpoint when the tracked terminal's PTY is gone", () => {
      // An exit that never reached this service leaves a ghost entry; the
      // registry proves it gone, so it gets no renewal.
      startLiveWorking("term-1");
      liveTerminals.delete("term-1");

      vi.advanceTimersByTime(4 * HOUR);

      expect(service.isBlocking()).toBe(false);
      expect(service.getActiveCount()).toBe(0);
      expect(registry.hasTerminal).toHaveBeenCalledWith("term-1");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("prunes a gone terminal but renews for the ones still running", () => {
      startLiveWorking("term-1");
      startLiveWorking("term-2");
      liveTerminals.delete("term-1");

      vi.advanceTimersByTime(4 * HOUR);

      expect(service.isBlocking()).toBe(true);
      expect(service.getActiveCount()).toBe(1);

      // The pruned entry stays out: term-2 going idle is now a clean release.
      emitStateChanged("term-2", "idle", { previousState: "working" });
      expect(service.isBlocking()).toBe(false);
    });

    it("does not let an entry dropped at the cap keep a later acquisition alive", () => {
      startLiveWorking("term-1");
      vi.advanceTimersByTime(12 * HOUR);
      expect(service.isBlocking()).toBe(false);

      startLiveWorking("term-2");
      expect(service.isBlocking()).toBe(true);
      expect(service.getActiveCount()).toBe(1);

      emitStateChanged("term-2", "idle", { previousState: "working" });
      expect(service.isBlocking()).toBe(false);
    });

    it("gives a fresh acquisition a fresh renewal budget", () => {
      startLiveWorking("term-1");
      vi.advanceTimersByTime(8 * HOUR);
      emitStateChanged("term-1", "idle", { previousState: "working" });
      expect(service.isBlocking()).toBe(false);

      startLiveWorking("term-2");
      vi.advanceTimersByTime(8 * HOUR);
      expect(service.isBlocking()).toBe(true);

      vi.advanceTimersByTime(4 * HOUR);
      expect(service.isBlocking()).toBe(false);
      expect(powerSaveBlocker.start).toHaveBeenCalledTimes(2);
    });

    it("still reaches the 12h cap when the registry throws at every checkpoint", () => {
      // A held assertion with no timer armed would never be released.
      startLiveWorking("term-1");
      registry.hasTerminal.mockImplementation(() => {
        throw new Error("registry unavailable");
      });

      expect(() => vi.advanceTimersByTime(4 * HOUR)).toThrow("registry unavailable");
      expect(service.isBlocking()).toBe(true);
      expect(vi.getTimerCount()).toBe(1);

      expect(() => vi.advanceTimersByTime(4 * HOUR)).toThrow("registry unavailable");
      vi.advanceTimersByTime(4 * HOUR);

      expect(service.isBlocking()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("falls back to the 4h release once the registry is unbound", () => {
      startLiveWorking("term-1");
      service.setTerminalRegistry(null);

      vi.advanceTimersByTime(4 * HOUR);

      expect(service.isBlocking()).toBe(false);
      expect(service.getActiveCount()).toBe(0);
    });

    it("leaves no timer behind when disposed after a renewal", () => {
      startLiveWorking("term-1");
      vi.advanceTimersByTime(4 * HOUR);
      expect(service.isBlocking()).toBe(true);

      service.dispose();

      expect(service.isBlocking()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("ignores state-changed without terminalId", () => {
      events.emit("agent:state-changed", {
        agentId: "agent-1",
        state: "working",
        previousState: "idle",
        timestamp: Date.now(),
        trigger: "output",
        confidence: 1.0,
      });

      expect(service.isBlocking()).toBe(false);
    });

    it("duplicate working events do not start multiple blockers", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });
      emitStateChanged("term-1", "working", { agentId: "agent-1" });

      expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
      expect(service.getActiveCount()).toBe(1);
    });
  });

  describe("dispose", () => {
    it("releases blocker and clears state", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });

      service.dispose();

      expect(service.isBlocking()).toBe(false);
      expect(powerSaveBlocker.stop).toHaveBeenCalled();
    });

    it("stops listening to events after dispose", () => {
      service.dispose();

      emitStateChanged("term-1", "working", { agentId: "agent-1" });

      expect(powerSaveBlocker.start).not.toHaveBeenCalled();
      expect(service.isBlocking()).toBe(false);
    });

    it("double dispose is safe", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });

      service.dispose();
      service.dispose();

      expect(service.isBlocking()).toBe(false);
    });
  });
});

describe("initializePowerSaveBlockerService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    disposePowerSaveBlockerService();
  });

  afterEach(() => {
    disposePowerSaveBlockerService();
    vi.useRealTimers();
  });

  function startWorking(terminalId: string) {
    events.emit("agent:state-changed", {
      terminalId,
      agentId: "agent-1",
      state: "working" as AgentState,
      previousState: "idle" as AgentState,
      timestamp: Date.now(),
      trigger: "output" as const,
      confidence: 1.0,
    });
  }

  it("keeps the live instance, its assertion and its tracked agents when a second window initializes", () => {
    // Per-window setup calls this for every window. Replacing the instance here
    // released the blocker and started one with an empty map, which a steadily
    // working agent never refills — it emits no further agent:state-changed.
    const first = initializePowerSaveBlockerService();
    startWorking("term-1");
    expect(first.isBlocking()).toBe(true);
    expect(first.getActiveCount()).toBe(1);

    const second = initializePowerSaveBlockerService();

    expect(second).toBe(first);
    expect(second.isBlocking()).toBe(true);
    expect(second.getActiveCount()).toBe(1);
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });

  it("does not re-subscribe on a second initialize", () => {
    // The map and the blocker guard both hide a duplicate subscription, so this
    // counts the subscriptions themselves rather than their visible effect.
    const onSpy = vi.spyOn(events, "on");
    initializePowerSaveBlockerService();
    const afterFirst = onSpy.mock.calls.filter(([event]) => event === "agent:state-changed").length;

    initializePowerSaveBlockerService();
    initializePowerSaveBlockerService();

    expect(onSpy.mock.calls.filter(([event]) => event === "agent:state-changed").length).toBe(
      afterFirst
    );
    onSpy.mockRestore();
  });

  it("leaves the instance an earlier caller is holding still subscribed and counting once", () => {
    // Anything holding the reference from the first call kept a DISPOSED service
    // once a second window initialized: unsubscribed, counting nothing. And the
    // one acquisition must stay one acquisition.
    const service = initializePowerSaveBlockerService();
    initializePowerSaveBlockerService();

    startWorking("term-1");

    expect(service.getActiveCount()).toBe(1);
    expect((powerSaveBlocker.start as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("binds a registry to the instance already live without resetting its renewal budget", () => {
    // The first initialize can come before any client exists; a later window's
    // call must still reach that instance, and rebinding must not buy the lease
    // more time.
    const live = new Set(["term-1"]);
    const registry = { hasTerminal: (id: string) => live.has(id) };
    const first = initializePowerSaveBlockerService();
    startWorking("term-1");

    expect(initializePowerSaveBlockerService(registry)).toBe(first);
    vi.advanceTimersByTime(8 * 60 * 60 * 1000);
    expect(first.isBlocking()).toBe(true);

    initializePowerSaveBlockerService(registry);
    initializePowerSaveBlockerService();
    vi.advanceTimersByTime(4 * 60 * 60 * 1000);

    expect(first.isBlocking()).toBe(false);
    expect((powerSaveBlocker.start as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("still builds a live instance after an explicit dispose, and the old one goes quiet", () => {
    // Identity alone would also be satisfied by a disposer that just nulls the
    // singleton, so this checks that the old service really unsubscribed and the
    // new one really receives events.
    const first = initializePowerSaveBlockerService();
    startWorking("term-1");
    expect(first.isBlocking()).toBe(true);

    disposePowerSaveBlockerService();
    const second = initializePowerSaveBlockerService();
    expect(second).not.toBe(first);

    startWorking("term-2");

    expect(second.isBlocking()).toBe(true);
    expect(second.getActiveCount()).toBe(1);
    expect(first.getActiveCount()).toBe(0);
  });
});
