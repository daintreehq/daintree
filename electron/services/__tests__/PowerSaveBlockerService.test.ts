import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
import { PowerSaveBlockerService } from "../PowerSaveBlockerService.js";
import { events } from "../events.js";

function emitStateChanged(
  terminalId: string,
  state: string,
  opts: { agentId?: string; previousState?: string } = {}
) {
  events.emit("agent:state-changed", {
    terminalId,
    agentId: opts.agentId,
    state: state as any,
    previousState: (opts.previousState ?? "idle") as any,
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

    it("starts blocker for running state", () => {
      emitStateChanged("term-1", "running", { agentId: "agent-1" });

      expect(powerSaveBlocker.start).toHaveBeenCalledWith("prevent-app-suspension");
      expect(service.isBlocking()).toBe(true);
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
      emitStateChanged("term-2", "running", { agentId: "agent-2" });

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

    it("resolves terminal from agentId when terminalId missing on killed", () => {
      emitStateChanged("term-1", "working", { agentId: "agent-1" });

      events.emit("agent:killed", {
        agentId: "agent-1",
        timestamp: Date.now(),
      });

      expect(service.isBlocking()).toBe(false);
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
