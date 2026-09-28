import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";

const power = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>();
  return {
    onBattery: false,
    throwOnQuery: false,
    listeners,
    emit(event: string) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    },
    count(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
});

const storeMock = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  failSet: false,
}));

const broadcastToRenderer = vi.hoisted(() => vi.fn());

const linuxSource = vi.hoisted(() => ({
  onChange: null as ((onBattery: boolean) => void) | null,
  refresh: vi.fn(async () => {}),
  dispose: vi.fn(),
}));

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
    powerMonitor: {
      isOnBatteryPower: vi.fn(() => {
        if (power.throwOnQuery) throw new Error("power source unavailable");
        return power.onBattery;
      }),
      on: vi.fn((event: string, listener: () => void) => {
        if (!power.listeners.has(event)) power.listeners.set(event, new Set());
        power.listeners.get(event)!.add(listener);
      }),
      removeListener: vi.fn((event: string, listener: () => void) => {
        power.listeners.get(event)?.delete(listener);
      }),
    },
  };
});

vi.mock("../../store.js", () => ({
  store: {
    get: vi.fn((key: string) => storeMock.data[key]),
    set: vi.fn((key: string, value: unknown) => {
      if (storeMock.failSet) throw new Error("store write failed");
      storeMock.data[key] = value;
    }),
  },
}));

vi.mock("../../ipc/utils.js", () => ({ broadcastToRenderer }));

vi.mock("../linuxPowerSource.js", () => ({
  watchLinuxPowerSource: vi.fn((onChange: (onBattery: boolean) => void) => {
    linuxSource.onChange = onChange;
    return { refresh: linuxSource.refresh, dispose: linuxSource.dispose };
  }),
}));

import { powerSaveBlocker } from "electron";
import {
  PowerSaveBlockerService,
  getPowerSaveBlockerService,
  initializePowerSaveBlockerService,
  disposePowerSaveBlockerService,
  setAttachedFrontendCount,
  type TerminalRegistry,
} from "../PowerSaveBlockerService.js";
import { events } from "../events.js";
import { store } from "../../store.js";
import { CHANNELS } from "../../ipc/channels.js";
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

const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

// Linux reads sysfs instead of powerMonitor, and CI runs on Linux, so each test
// names the platform it means.
beforeEach(() => {
  setPlatform("darwin");
  power.onBattery = false;
  power.throwOnQuery = false;
  storeMock.data = {};
  storeMock.failSet = false;
  linuxSource.onChange = null;
});

afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
});

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
      vi.advanceTimersByTime(12 * HOUR - 1);
      expect(service.isBlocking()).toBe(true);
      vi.advanceTimersByTime(1);
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

    it("keeps its next checkpoint armed when the registry throws", () => {
      // A held assertion with no timer armed would never be released; the
      // budget keeps counting down to the cap through the failed checkpoints.
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

    it("releases at the next checkpoint once the registry is unbound mid-lease", () => {
      startLiveWorking("term-1");
      vi.advanceTimersByTime(5 * HOUR);
      service.setTerminalRegistry(null);

      vi.advanceTimersByTime(3 * HOUR - 1);
      expect(service.isBlocking()).toBe(true);

      vi.advanceTimersByTime(1);
      expect(service.isBlocking()).toBe(false);
      expect(service.getActiveCount()).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
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

  describe("keep-awake setting and power source", () => {
    const HOUR = 60 * 60 * 1000;

    function restart() {
      service.dispose();
      service = new PowerSaveBlockerService();
    }

    it("defaults to holding on AC and not on battery", () => {
      expect(service.getState().config).toEqual({ enabled: true, onBattery: false });
    });

    it("reads a stored setting and ignores values that are not exactly the opt-out", () => {
      storeMock.data.keepAwake = { enabled: false, onBattery: true };
      restart();
      expect(service.getState().config).toEqual({ enabled: false, onBattery: true });

      storeMock.data.keepAwake = { enabled: "false", onBattery: "true" };
      restart();
      expect(service.getState().config).toEqual({ enabled: true, onBattery: false });

      storeMock.data.keepAwake = null;
      restart();
      expect(service.getState().config).toEqual({ enabled: true, onBattery: false });
    });

    it("tracks a working agent without holding when it starts on battery", () => {
      power.onBattery = true;
      restart();

      emitStateChanged("term-1", "working");

      expect(powerSaveBlocker.start).not.toHaveBeenCalled();
      expect(service.isBlocking()).toBe(false);
      expect(service.getActiveCount()).toBe(1);
    });

    it("treats a power source it cannot read as AC", () => {
      power.throwOnQuery = true;
      restart();

      emitStateChanged("term-1", "working");

      expect(service.isBlocking()).toBe(true);
    });

    it("releases on unplug and takes the blocker back on replug with no agent event", () => {
      emitStateChanged("term-1", "working");
      expect(service.isBlocking()).toBe(true);

      power.emit("on-battery");
      expect(service.isBlocking()).toBe(false);
      expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
      expect(service.getActiveCount()).toBe(1);

      power.emit("on-ac");
      expect(service.isBlocking()).toBe(true);
      expect(powerSaveBlocker.start).toHaveBeenCalledTimes(2);
    });

    it("keeps holding through an unplug when battery is allowed", () => {
      service.updateConfig({ onBattery: true });
      emitStateChanged("term-1", "working");

      power.emit("on-battery");

      expect(service.isBlocking()).toBe(true);
      expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
    });

    it("ignores repeated power events", () => {
      emitStateChanged("term-1", "working");

      power.emit("on-battery");
      power.emit("on-battery");
      expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);

      power.emit("on-ac");
      power.emit("on-ac");
      expect(powerSaveBlocker.start).toHaveBeenCalledTimes(2);
    });

    it("reads the power source again on resume", () => {
      emitStateChanged("term-1", "working");

      power.onBattery = true;
      power.emit("resume");

      expect(service.isBlocking()).toBe(false);
    });

    it("keeps a known battery reading when the query fails on resume", () => {
      power.onBattery = true;
      restart();
      emitStateChanged("term-1", "working");

      power.throwOnQuery = true;
      power.emit("resume");

      expect(service.isBlocking()).toBe(false);
    });

    describe("on Linux", () => {
      beforeEach(() => {
        setPlatform("linux");
        restart();
      });

      it("follows the sysfs reading, since Electron reports AC there regardless", () => {
        emitStateChanged("term-1", "working");
        expect(service.isBlocking()).toBe(true);

        linuxSource.onChange!(true);
        expect(service.isBlocking()).toBe(false);

        linuxSource.onChange!(false);
        expect(service.isBlocking()).toBe(true);
      });

      it("reads sysfs again on resume instead of trusting powerMonitor", () => {
        power.onBattery = false;
        linuxSource.onChange!(true);
        emitStateChanged("term-1", "working");

        power.emit("resume");

        expect(linuxSource.refresh).toHaveBeenCalledTimes(1);
        expect(service.isBlocking()).toBe(false);
      });

      it("stops reading sysfs when disposed", () => {
        service.dispose();

        expect(linuxSource.dispose).toHaveBeenCalledTimes(1);
      });
    });

    it("releases at once when disabled and resumes when enabled again", () => {
      emitStateChanged("term-1", "working");

      service.updateConfig({ enabled: false });
      expect(service.isBlocking()).toBe(false);
      expect(store.set).toHaveBeenCalledWith("keepAwake", { enabled: false, onBattery: false });

      service.updateConfig({ enabled: true });
      expect(service.isBlocking()).toBe(true);
    });

    it("never holds while disabled, on AC or on battery", () => {
      storeMock.data.keepAwake = { enabled: false, onBattery: true };
      restart();

      emitStateChanged("term-1", "working");
      expect(service.isBlocking()).toBe(false);

      power.emit("on-battery");
      power.emit("on-ac");
      expect(powerSaveBlocker.start).not.toHaveBeenCalled();
    });

    it("follows the battery setting while unplugged", () => {
      power.onBattery = true;
      restart();
      emitStateChanged("term-1", "working");

      service.updateConfig({ onBattery: true });
      expect(service.isBlocking()).toBe(true);

      service.updateConfig({ onBattery: false });
      expect(service.isBlocking()).toBe(false);
    });

    it("does not hold for a power or setting change with no working agent", () => {
      power.emit("on-battery");
      power.emit("on-ac");
      service.updateConfig({ enabled: false });
      service.updateConfig({ enabled: true });

      expect(powerSaveBlocker.start).not.toHaveBeenCalled();
    });

    it("leaves the live policy alone when the setting cannot be saved", () => {
      emitStateChanged("term-1", "working");
      storeMock.failSet = true;

      expect(() => service.updateConfig({ enabled: false })).toThrow("store write failed");

      expect(service.isBlocking()).toBe(true);
      expect(service.getState().config.enabled).toBe(true);
    });

    it("writes nothing for a patch that changes nothing", () => {
      service.updateConfig({ enabled: true, onBattery: false });

      expect(store.set).not.toHaveBeenCalled();
      expect(broadcastToRenderer).not.toHaveBeenCalled();
    });

    it("pushes a state only when the hold or the setting changes", () => {
      emitStateChanged("term-1", "working");
      expect(broadcastToRenderer).toHaveBeenLastCalledWith(CHANNELS.KEEP_AWAKE_STATE_CHANGED, {
        config: { enabled: true, onBattery: false },
        isBlocking: true,
        revision: 1,
      });

      emitStateChanged("term-2", "working");
      emitStateChanged("term-2", "waiting");
      expect(broadcastToRenderer).toHaveBeenCalledTimes(1);

      service.updateConfig({ onBattery: true });
      expect(broadcastToRenderer).toHaveBeenLastCalledWith(CHANNELS.KEEP_AWAKE_STATE_CHANGED, {
        config: { enabled: true, onBattery: true },
        isBlocking: true,
        revision: 2,
      });

      emitStateChanged("term-1", "waiting");
      expect(broadcastToRenderer).toHaveBeenLastCalledWith(CHANNELS.KEEP_AWAKE_STATE_CHANGED, {
        config: { enabled: true, onBattery: true },
        isBlocking: false,
        revision: 3,
      });
      expect(service.getState().revision).toBe(3);
    });

    describe("safety budget across a release", () => {
      it("carries the unused part of a period instead of granting a new one", () => {
        emitStateChanged("term-1", "working");
        vi.advanceTimersByTime(3 * HOUR);

        power.emit("on-battery");
        vi.advanceTimersByTime(10 * HOUR);
        power.emit("on-ac");

        vi.advanceTimersByTime(HOUR - 1);
        expect(service.isBlocking()).toBe(true);
        vi.advanceTimersByTime(1);
        expect(service.isBlocking()).toBe(false);
        expect(service.getActiveCount()).toBe(0);
      });

      it("does not refill a period when the wall clock moves back", () => {
        emitStateChanged("term-1", "working");
        vi.advanceTimersByTime(3 * HOUR);

        vi.setSystemTime(Date.now() - 3 * HOUR);
        power.emit("on-battery");
        power.emit("on-ac");

        vi.advanceTimersByTime(HOUR);
        expect(service.isBlocking()).toBe(false);
      });

      it("does not refill a period that was about to run out", () => {
        emitStateChanged("term-1", "working");
        vi.advanceTimersByTime(4 * HOUR - 1);

        service.updateConfig({ enabled: false });
        vi.advanceTimersByTime(HOUR);
        service.updateConfig({ enabled: true });
        expect(service.isBlocking()).toBe(true);

        vi.advanceTimersByTime(1);
        expect(service.isBlocking()).toBe(false);
      });

      it("keeps renewals already spent when the blocker comes back", () => {
        const registry = { hasTerminal: vi.fn(() => true) };
        service.setTerminalRegistry(registry);
        emitStateChanged("term-1", "working");

        vi.advanceTimersByTime(5 * HOUR);
        power.emit("on-battery");
        vi.advanceTimersByTime(10 * HOUR);
        power.emit("on-ac");

        // Five hours held before the gap: the second checkpoint is three more
        // hours away, and the release four hours after that.
        vi.advanceTimersByTime(3 * HOUR);
        expect(service.isBlocking()).toBe(true);
        vi.advanceTimersByTime(4 * HOUR - 1);
        expect(service.isBlocking()).toBe(true);
        vi.advanceTimersByTime(1);
        expect(service.isBlocking()).toBe(false);
        expect(service.getActiveCount()).toBe(0);
      });

      it("does not let another agent starting while released reset the budget", () => {
        emitStateChanged("term-1", "working");
        vi.advanceTimersByTime(3 * HOUR);
        power.emit("on-battery");

        emitStateChanged("term-2", "working");
        power.emit("on-ac");

        vi.advanceTimersByTime(HOUR);
        expect(service.isBlocking()).toBe(false);
      });

      it("gives a fresh budget once the released episode has ended", () => {
        emitStateChanged("term-1", "working");
        vi.advanceTimersByTime(3 * HOUR);
        power.emit("on-battery");
        emitStateChanged("term-1", "waiting");
        power.emit("on-ac");

        emitStateChanged("term-1", "working");
        vi.advanceTimersByTime(4 * HOUR - 1);
        expect(service.isBlocking()).toBe(true);
      });

      it("keeps a safety release final through later power and setting changes", () => {
        emitStateChanged("term-1", "working");
        vi.advanceTimersByTime(4 * HOUR);
        expect(service.isBlocking()).toBe(false);

        power.emit("on-battery");
        power.emit("on-ac");
        service.updateConfig({ enabled: false });
        service.updateConfig({ enabled: true });

        expect(service.isBlocking()).toBe(false);
        expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
      });

      it("runs no checkpoint while released", () => {
        const registry = { hasTerminal: vi.fn(() => true) };
        service.setTerminalRegistry(registry);
        emitStateChanged("term-1", "working");
        power.emit("on-battery");

        vi.advanceTimersByTime(24 * HOUR);

        expect(registry.hasTerminal).not.toHaveBeenCalled();
        expect(service.getActiveCount()).toBe(1);
      });
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

    it("removes its power listeners", () => {
      expect(power.count("on-battery")).toBe(1);
      expect(power.count("on-ac")).toBe(1);
      expect(power.count("resume")).toBe(1);

      service.dispose();

      expect(power.count("on-battery")).toBe(0);
      expect(power.count("on-ac")).toBe(0);
      expect(power.count("resume")).toBe(0);
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

  it("refuses to build a replacement once shutdown has disposed it", () => {
    initializePowerSaveBlockerService();
    disposePowerSaveBlockerService();

    expect(() => getPowerSaveBlockerService()).toThrow(/shuts down/);
    expect(power.count("on-battery")).toBe(0);
  });

  it("adds no power listeners on a second initialize", () => {
    initializePowerSaveBlockerService();
    initializePowerSaveBlockerService();

    expect(power.count("on-battery")).toBe(1);
    expect(power.count("on-ac")).toBe(1);
    expect(power.count("resume")).toBe(1);
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
    const HOUR = 60 * 60 * 1000;
    const live = new Set(["term-1", "term-2"]);
    const registry = { hasTerminal: vi.fn((id: string) => live.has(id)) };
    const replacement = { hasTerminal: vi.fn((id: string) => live.has(id)) };
    const first = initializePowerSaveBlockerService();
    startWorking("term-1");

    vi.advanceTimersByTime(2 * HOUR);
    expect(initializePowerSaveBlockerService(registry)).toBe(first);
    vi.advanceTimersByTime(3 * HOUR);
    expect(registry.hasTerminal).toHaveBeenCalledTimes(1);

    // A later window with nothing to pass must not unbind it.
    initializePowerSaveBlockerService();
    vi.advanceTimersByTime(3 * HOUR);
    expect(first.isBlocking()).toBe(true);
    expect(registry.hasTerminal).toHaveBeenCalledTimes(2);

    // Nor may one passing a different registry buy the lease more time.
    vi.advanceTimersByTime(1 * HOUR);
    initializePowerSaveBlockerService(replacement);
    vi.advanceTimersByTime(3 * HOUR - 1);
    expect(first.isBlocking()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(first.isBlocking()).toBe(false);
    expect((powerSaveBlocker.start as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // The replacement is what the next lease consults.
    startWorking("term-2");
    vi.advanceTimersByTime(4 * HOUR);
    expect(first.isBlocking()).toBe(true);
    expect(replacement.hasTerminal).toHaveBeenCalledWith("term-2");
    expect(registry.hasTerminal).toHaveBeenCalledTimes(2);
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

describe("attached remote frontends", () => {
  const HOUR = 60 * 60 * 1000;
  let service: PowerSaveBlockerService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    service = new PowerSaveBlockerService();
  });

  afterEach(() => {
    service.dispose();
    disposePowerSaveBlockerService();
    vi.useRealTimers();
  });

  it("holds the blocker while a frontend is attached and no agent works", () => {
    service.setAttachedFrontendCount(1);

    expect(powerSaveBlocker.start).toHaveBeenCalledWith("prevent-app-suspension");
    expect(service.isBlocking()).toBe(true);
    expect(broadcastToRenderer).toHaveBeenCalledWith(
      CHANNELS.KEEP_AWAKE_STATE_CHANGED,
      expect.objectContaining({ isBlocking: true })
    );
  });

  it("releases at zero frontends", () => {
    service.setAttachedFrontendCount(2);
    service.setAttachedFrontendCount(0);

    expect(service.isBlocking()).toBe(false);
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps holding for working agents after the last frontend detaches", () => {
    service.setAttachedFrontendCount(1);
    emitStateChanged("term-1", "working");
    service.setAttachedFrontendCount(0);

    expect(service.isBlocking()).toBe(true);
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
  });

  it("keeps holding for frontends after the last agent stops", () => {
    emitStateChanged("term-1", "working");
    service.setAttachedFrontendCount(1);
    emitStateChanged("term-1", "idle", { previousState: "working" });

    expect(service.isBlocking()).toBe(true);
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });

  it("is not subject to the agent safety cap", () => {
    service.setAttachedFrontendCount(1);
    vi.advanceTimersByTime(24 * HOUR);

    expect(service.isBlocking()).toBe(true);
  });

  it("outlives an agent episode's force-release", () => {
    service.setAttachedFrontendCount(1);
    emitStateChanged("term-1", "working");
    vi.advanceTimersByTime(4 * HOUR);

    expect(service.getActiveCount()).toBe(0);
    expect(service.isBlocking()).toBe(true);
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });

  it("gives an agent episode that starts under frontends its own safety budget", () => {
    service.setAttachedFrontendCount(1);
    emitStateChanged("term-1", "working");
    service.setAttachedFrontendCount(0);

    vi.advanceTimersByTime(4 * HOUR - 1);
    expect(service.isBlocking()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(service.isBlocking()).toBe(false);
  });

  it("respects keep-awake being turned off", () => {
    storeMock.data.keepAwake = { enabled: false, onBattery: false };
    service.dispose();
    service = new PowerSaveBlockerService();

    service.setAttachedFrontendCount(1);

    expect(service.isBlocking()).toBe(false);
    expect(powerSaveBlocker.start).not.toHaveBeenCalled();
  });

  it("releases on battery unless the battery rule allows it, and takes it back on AC", () => {
    service.setAttachedFrontendCount(1);
    expect(service.isBlocking()).toBe(true);

    power.onBattery = true;
    power.emit("on-battery");
    expect(service.isBlocking()).toBe(false);

    power.onBattery = false;
    power.emit("on-ac");
    expect(service.isBlocking()).toBe(true);
  });

  it("holds on battery when the setting allows it", () => {
    storeMock.data.keepAwake = { enabled: true, onBattery: true };
    power.onBattery = true;
    service.dispose();
    service = new PowerSaveBlockerService();

    service.setAttachedFrontendCount(1);

    expect(service.isBlocking()).toBe(true);
  });

  it("treats a repeated or invalid count as no change", () => {
    service.setAttachedFrontendCount(1);
    service.setAttachedFrontendCount(1);
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);

    service.setAttachedFrontendCount(-3);
    expect(service.getAttachedFrontendCount()).toBe(0);
    expect(service.isBlocking()).toBe(false);

    service.setAttachedFrontendCount(Number.NaN);
    expect(service.getAttachedFrontendCount()).toBe(0);
  });

  it("applies a count set before the singleton exists once it is built", async () => {
    // A fresh module: the shared one's dispose latch is set by earlier cases.
    vi.resetModules();
    const fresh = await import("../PowerSaveBlockerService.js");
    fresh.setAttachedFrontendCount(1);
    const instance = fresh.initializePowerSaveBlockerService();

    expect(instance.getAttachedFrontendCount()).toBe(1);
    expect(instance.isBlocking()).toBe(true);
    fresh.disposePowerSaveBlockerService();
  });

  it("drops a count set after shutdown disposed the singleton", () => {
    initializePowerSaveBlockerService();
    disposePowerSaveBlockerService();
    setAttachedFrontendCount(1);

    expect(powerSaveBlocker.start).not.toHaveBeenCalled();
  });
});
