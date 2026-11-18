import { describe, expect, it, vi } from "vitest";

vi.mock("../../../ipc/utils.js", () => ({ broadcastToRenderer: vi.fn() }));

import type { AgentUsageReading } from "../../../../shared/types/ipc/agentUsage.js";
import { AgentUsageReadouts, type RemoteAgentUsage } from "../AgentUsageReadouts.js";
import type { AgentUsageWatch } from "../AgentUsageWatch.js";

function reading(usedPercent: number): AgentUsageReading {
  return {
    agentId: "codex",
    accountNames: [],
    isDefault: true,
    windowDurationMins: 300,
    usedPercent,
    resetsAt: null,
    observedAt: 1,
  };
}

function fakeWatch() {
  let latest: AgentUsageReading[] = [];
  const listeners = new Set<(readings: AgentUsageReading[]) => void>();
  const release = vi.fn();
  const watch = {
    acquire: vi.fn(() => release),
    latest: () => latest,
    onChange: (listener: (readings: AgentUsageReading[]) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    watch: watch as unknown as AgentUsageWatch,
    acquire: watch.acquire,
    release,
    listenerCount: () => listeners.size,
    set(next: AgentUsageReading[]) {
      latest = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function fakeRemote() {
  let hosts: RemoteAgentUsage[] = [];
  let listener: (() => void) | null = null;
  return {
    source: {
      list: () => hosts,
      watch: (next: () => void) => {
        listener = next;
        return () => (listener = null);
      },
    },
    watching: () => listener !== null,
    set(next: RemoteAgentUsage[]) {
      hosts = next;
      listener?.();
    },
  };
}

describe("AgentUsageReadouts", () => {
  it("watches this machine only while some view follows, however many do", () => {
    const w = fakeWatch();
    const readouts = new AgentUsageReadouts({ watch: () => w.watch, publish: vi.fn() });
    readouts.follow(1);
    readouts.follow(2);
    readouts.follow(2);
    expect(w.acquire).toHaveBeenCalledTimes(1);
    readouts.unfollow(1);
    expect(w.release).not.toHaveBeenCalled();
    readouts.unfollow(2);
    expect(w.release).toHaveBeenCalledTimes(1);
    expect(w.listenerCount()).toBe(0);
  });

  it("takes in this machine's readings and every linked host's, publishing only on a change", () => {
    const w = fakeWatch();
    const remote = fakeRemote();
    const publish = vi.fn();
    const readouts = new AgentUsageReadouts({ watch: () => w.watch, publish });
    readouts.setRemoteSource(remote.source);
    expect(remote.watching()).toBe(false);

    const seed = readouts.follow(1);
    expect(seed.readouts).toEqual([]);
    expect(remote.watching()).toBe(true);

    w.set([reading(50)]);
    remote.set([{ hostId: "vps", hostName: "Build VPS", readings: [reading(90)] }]);
    expect(publish).toHaveBeenCalledTimes(2);
    const last = publish.mock.calls.at(-1)![0];
    expect(last.readouts).toEqual([
      { hostId: "local", hostName: null, reading: reading(50) },
      { hostId: "vps", hostName: "Build VPS", reading: reading(90) },
    ]);
    expect(last.revision).toBeGreaterThan(seed.revision);

    // A summary that says the same again publishes nothing.
    remote.set([{ hostId: "vps", hostName: "Build VPS", readings: [reading(90)] }]);
    expect(publish).toHaveBeenCalledTimes(2);

    // A host gone from the source is gone from the set.
    remote.set([]);
    expect(publish.mock.calls.at(-1)![0].readouts).toEqual([
      { hostId: "local", hostName: null, reading: reading(50) },
    ]);
  });

  it("stops listening to hosts when the last view stops following, and when the source is taken away", () => {
    const w = fakeWatch();
    const remote = fakeRemote();
    const readouts = new AgentUsageReadouts({ watch: () => w.watch, publish: vi.fn() });
    const remove = readouts.setRemoteSource(remote.source);
    readouts.follow(1);
    readouts.unfollow(1);
    expect(remote.watching()).toBe(false);
    readouts.follow(1);
    expect(remote.watching()).toBe(true);
    remove();
    expect(remote.watching()).toBe(false);
  });
});
