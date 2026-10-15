import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const broadcastToRenderer = vi.hoisted(() => vi.fn());
const running = vi.hoisted(() => new Map<string, { sessionId: string; terminalId: string }>());
const pty = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const generations = new Map<string, number>();
  return {
    generations,
    listeners,
    client: {
      getLiveGeneration: (id: string) => generations.get(id) ?? null,
      on: (event: string, fn: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
      },
      off: (event: string, fn: (...args: unknown[]) => void) => listeners.get(event)?.delete(fn),
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
    },
  };
});

vi.mock("../../../ipc/utils.js", () => ({ broadcastToRenderer }));
vi.mock("../../../services/HelpSessionService.js", () => ({
  helpSessionService: {
    getRunningLaneSession: (projectId: string, slot: number) =>
      running.get(`${projectId}:${slot}`) ?? null,
    addSessionEndedListener: () => () => {},
    setMessagingReach: () => {},
  },
}));
vi.mock("../../../services/DriveLeaseService.js", () => ({ peekDriveLeaseService: () => null }));
vi.mock("../../metrics/hostOps.js", () => ({ callerDrives: () => false }));
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: () => pty.client }));

import { CHANNELS } from "../../../ipc/channels.js";
import { getRemoteService } from "../../runtime.js";
import type { ExchangeRecord } from "../../exchange/types.js";
import type { MovedExchange } from "../AssistantExchangeClient.js";
import type { LaneEnrollment } from "../AssistantMessagingPolicy.js";
import { installAssistantMessagingPolicy, wakeHubForMoved } from "../install.js";

describe("installAssistantMessagingPolicy", () => {
  let hosts: string[];
  let hostListeners: Set<() => void>;
  let uninstall: (() => void) | null = null;

  const install = () =>
    (uninstall = installAssistantMessagingPolicy({
      isHostMessagingEnabled: () => false,
      hasHosts: () => hosts.length > 0,
      onHostsChanged: (listener) => {
        hostListeners.add(listener);
        return () => hostListeners.delete(listener);
      },
    }));
  const hostsChanged = () => {
    for (const listener of [...hostListeners]) listener();
  };
  const pushes = () =>
    broadcastToRenderer.mock.calls
      .filter(([channel]) => channel === CHANNELS.ASSISTANT_MESSAGING_CHANGED)
      .map(([, event]) => (event as { revision: number }).revision);

  beforeEach(() => {
    broadcastToRenderer.mockClear();
    running.clear();
    hosts = [];
    hostListeners = new Set();
    pty.listeners.clear();
    pty.generations.clear();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("pushes once on install, so a view that read it as missing reads it again", () => {
    install();
    expect(pushes()).toEqual([1]);
    expect(getRemoteService("assistantMessagingSurface")?.revision()).toBe(1);
  });

  it("pushes a fresh revision on every policy change", () => {
    install();
    getRemoteService("assistantMessagingPolicy")!.setPaused(true);
    running.set("proj:0", { sessionId: "s1", terminalId: "t1" });
    pty.generations.set("t1", 1);
    getRemoteService("assistantMessagingPolicy")!.enroll(
      { projectId: "proj", slot: 0 },
      { kind: "local" }
    );
    expect(pushes()).toEqual([1, 2, 3]);
  });

  it("pushes only when the first host arrives or the last one goes", () => {
    install();
    expect(getRemoteService("assistantMessagingSurface")?.hasHosts()).toBe(false);
    hosts = ["a"];
    hostsChanged();
    hosts = ["a", "b"];
    hostsChanged();
    hosts = [];
    hostsChanged();
    expect(pushes()).toEqual([1, 2, 3]);
  });

  it("ends an enrollment whose PTY was relaunched in place as soon as it spawns", () => {
    install();
    running.set("proj:0", { sessionId: "s1", terminalId: "t1" });
    pty.generations.set("t1", 1);
    const policy = getRemoteService("assistantMessagingPolicy")!;
    policy.enroll({ projectId: "proj", slot: 0 }, { kind: "remote", linkSessionId: "link" });
    expect(pushes()).toEqual([1, 2]);
    pty.generations.set("t1", 2);
    pty.emit("spawn-result", "t1", { success: true, id: "t1" });
    expect(pushes()).toEqual([1, 2, 3]);
    expect(policy.getEnded({ projectId: "proj", slot: 0 })?.reason).toBe("relaunched");
  });

  it("unregisters both services and stops listening on teardown", () => {
    install();
    uninstall!();
    uninstall = null;
    expect(getRemoteService("assistantMessagingPolicy")).toBeUndefined();
    expect(getRemoteService("assistantMessagingSurface")).toBeUndefined();
    expect(hostListeners.size).toBe(0);
    expect(pty.listeners.get("spawn-result")?.size ?? 0).toBe(0);
    hosts = ["a"];
    hostsChanged();
    expect(pushes()).toEqual([1]);
  });
});

describe("wakeHubForMoved", () => {
  const hub = { projectId: "proj", slot: 0, generation: "hub-2" } as LaneEnrollment;
  const moved = (taskId: string, hubGeneration: string): MovedExchange => ({
    record: { taskId } as ExchangeRecord,
    hubGeneration,
  });

  it("wakes the hub that sent each exchange, as an update from this Shell", () => {
    const wake = vi.fn();
    wakeHubForMoved([moved("task-1", "hub-2"), moved("task-2", "hub-1")], { getHub: () => hub }, {
      wake,
    });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]![0]).toMatchObject({
      lane: { projectId: "proj", slot: 0 },
      generation: "hub-2",
      shell: { kind: "local" },
      exchangeId: "task-1",
      kind: "update",
    });
  });

  it("wakes nothing with no hub enrolled, or no waker", () => {
    const wake = vi.fn();
    wakeHubForMoved([moved("task-1", "hub-2")], { getHub: () => null }, { wake });
    wakeHubForMoved([moved("task-1", "hub-2")], undefined, { wake });
    expect(() => wakeHubForMoved([moved("task-1", "hub-2")], { getHub: () => hub }, undefined)).not.toThrow();
    expect(wake).not.toHaveBeenCalled();
  });
});
