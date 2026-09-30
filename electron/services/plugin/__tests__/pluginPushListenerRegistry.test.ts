import { describe, expect, it, vi, type Mock } from "vitest";

vi.mock("../../../ipc/utils.js", () => ({ getProjectRendererTargets: vi.fn(() => []) }));

import {
  PluginPushListenerRegistry,
  type PluginPushListenerKey,
  type PluginPushListenerTarget,
} from "../pluginPushListenerRegistry.js";
import { PluginPushBatcher, type PluginPushTarget } from "../pluginPushBatcher.js";

interface FakeRenderer extends PluginPushTarget {
  destroyed: boolean;
  destroy(): void;
  once(event: "destroyed", listener: () => void): void;
  send: Mock<(channel: string, ...args: unknown[]) => void>;
}

function renderer(id: number): FakeRenderer {
  const listeners: Array<() => void> = [];
  const r: FakeRenderer = {
    id,
    destroyed: false,
    isDestroyed: () => r.destroyed,
    once: (_event, listener) => {
      listeners.push(listener);
    },
    destroy: () => {
      r.destroyed = true;
      for (const l of listeners.splice(0)) l();
    },
    send: vi.fn<(channel: string, ...args: unknown[]) => void>(),
  };
  return r;
}

const CH = "plugin:acme.demo:tick";
const OTHER = "plugin:acme.demo:other";

function setup() {
  const scopes = new Map<string | null, PluginPushListenerTarget[]>();
  const registry = new PluginPushListenerRegistry((projectId) => scopes.get(projectId) ?? []);
  return { registry, scopes };
}

describe("PluginPushListenerRegistry", () => {
  it("delivers to a renderer that has not reported", () => {
    const { registry } = setup();
    expect(registry.shouldDeliver(1, CH, null)).toBe(true);
    expect(registry.shouldDeliver(1, CH, "panel-a")).toBe(true);
    expect(registry.isReported(1)).toBe(false);
  });

  it("skips what a reported renderer has no subscriber for, broadcast and targeted apart", () => {
    const { registry } = setup();
    const r = renderer(1);
    registry.report(r, [
      [CH, null],
      [OTHER, "panel-a"],
    ]);
    expect(registry.shouldDeliver(1, CH, null)).toBe(true);
    expect(registry.shouldDeliver(1, CH, "panel-a")).toBe(false);
    expect(registry.shouldDeliver(1, OTHER, "panel-a")).toBe(true);
    expect(registry.shouldDeliver(1, OTHER, null)).toBe(false);
    expect(registry.shouldDeliver(1, "plugin:acme.demo:never", null)).toBe(false);
  });

  it("replaces a renderer's state on every report rather than accumulating it", () => {
    const { registry } = setup();
    const r = renderer(1);
    registry.report(r, [[CH, null]]);
    registry.report(r, []);
    expect(registry.shouldDeliver(1, CH, null)).toBe(false);
  });

  it("treats a refused report (null) as unknown, restoring delivery", () => {
    const { registry } = setup();
    const r = renderer(1);
    registry.report(r, []);
    expect(registry.shouldDeliver(1, CH, null)).toBe(false);
    registry.report(r, null);
    expect(registry.shouldDeliver(1, CH, null)).toBe(true);
    expect(registry.isReported(1)).toBe(false);
  });

  it("forgets a destroyed renderer and ignores a report that arrives after", () => {
    const { registry, scopes } = setup();
    const r = renderer(1);
    scopes.set(null, [r]);
    registry.report(r, [[CH, null]]);
    r.destroy();
    expect(registry.isReported(1)).toBe(false);
    registry.report(r, [[CH, null]]);
    expect(registry.isReported(1)).toBe(false);
    expect(registry.hasListeners(null, CH)).toBe(false);
  });

  it("answers hasListeners over the scope, counting an unreported renderer as listening", () => {
    const { registry, scopes } = setup();
    const a = renderer(1);
    const b = renderer(2);
    scopes.set("p1", [a, b]);
    registry.report(a, []);
    expect(registry.hasListeners("p1", CH)).toBe(true);
    registry.report(b, [[CH, "panel-x"]]);
    expect(registry.hasListeners("p1", CH)).toBe(true);
    registry.report(b, []);
    expect(registry.hasListeners("p1", CH)).toBe(false);
    expect(registry.hasListeners("p2", CH)).toBe(false);
  });

  it("scopes hasListeners to the project's renderers", () => {
    const { registry, scopes } = setup();
    const mine = renderer(1);
    const theirs = renderer(2);
    scopes.set("p1", [mine]);
    scopes.set("p2", [theirs]);
    registry.report(mine, []);
    registry.report(theirs, [[CH, null]]);
    expect(registry.hasListeners("p1", CH)).toBe(false);
    expect(registry.hasListeners("p2", CH)).toBe(true);
  });

  it("fires watchers on transitions only, including a renderer being destroyed", () => {
    const { registry, scopes } = setup();
    const a = renderer(1);
    const b = renderer(2);
    scopes.set(null, [a, b]);
    registry.report(a, []);
    registry.report(b, []);
    const seen: boolean[] = [];
    const stop = registry.watch(null, CH, (has) => seen.push(has));
    registry.report(a, [[CH, null]]);
    registry.report(b, [[CH, null]]);
    registry.report(a, [
      [CH, null],
      [OTHER, null],
    ] as PluginPushListenerKey[]);
    registry.report(a, []);
    scopes.set(null, [b]);
    b.destroy();
    expect(seen).toEqual([true, false]);
    stop();
    registry.report(a, [[CH, null]]);
    expect(seen).toEqual([true, false]);
    expect(registry.watcherCount()).toBe(0);
  });

  it("keeps notifying other watchers when one throws", () => {
    const { registry, scopes } = setup();
    const a = renderer(1);
    scopes.set(null, [a]);
    registry.report(a, []);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    registry.watch(null, CH, () => {
      throw new Error("boom");
    });
    const second = vi.fn();
    registry.watch(null, CH, second);
    registry.report(a, [[CH, null]]);
    expect(second).toHaveBeenCalledWith(true);
    errors.mockRestore();
  });
});

describe("PluginPushBatcher with listener reports", () => {
  function batcherWith(registry: PluginPushListenerRegistry, targets: FakeRenderer[]) {
    const scheduled: Array<() => void> = [];
    const batcher = new PluginPushBatcher({
      schedule: (flush) => scheduled.push(flush),
      resolveScope: () => targets,
      hasListener: (id, channel, panelId) => registry.shouldDeliver(id, channel, panelId),
    });
    return { batcher, run: () => scheduled.splice(0).forEach((f) => f()) };
  }

  it("skips a broadcast for a renderer that reported no broadcast subscriber", () => {
    const { registry } = setup();
    const listening = renderer(1);
    const idle = renderer(2);
    const fresh = renderer(3);
    registry.report(listening, [[CH, null]]);
    registry.report(idle, [[CH, "panel-a"]]);
    const { batcher, run } = batcherWith(registry, [listening, idle, fresh]);
    const observer = vi.fn();
    batcher.setFlushObserver(observer);
    batcher.enqueue({
      pluginId: "acme.demo",
      projectId: null,
      channel: CH,
      panelId: null,
      payload: 1,
      bytes: 10,
    });
    run();
    expect(listening.send).toHaveBeenCalledTimes(1);
    expect(idle.send).not.toHaveBeenCalled();
    // Never reported: delivered exactly as before listener reports existed.
    expect(fresh.send).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledWith("acme.demo", 2, 20);
  });

  it("skips a targeted push for a renderer with no subscriber for that panel", () => {
    const { registry } = setup();
    const a = renderer(1);
    const b = renderer(2);
    registry.report(a, [[CH, null]]);
    registry.report(b, [[CH, "panel-a"]]);
    const { batcher, run } = batcherWith(registry, [a, b]);
    batcher.enqueue({
      pluginId: "acme.demo",
      projectId: null,
      channel: CH,
      panelId: "panel-a",
      payload: 1,
      bytes: 10,
      locatePanel: () => [],
    });
    run();
    expect(a.send).not.toHaveBeenCalled();
    expect(b.send).toHaveBeenCalledTimes(1);
  });

  it("decides at flush time, so a subscription reported before the flush is honoured", () => {
    const { registry } = setup();
    const a = renderer(1);
    registry.report(a, []);
    const { batcher, run } = batcherWith(registry, [a]);
    batcher.enqueue({
      pluginId: "acme.demo",
      projectId: null,
      channel: CH,
      panelId: null,
      payload: 1,
      bytes: 10,
    });
    registry.report(a, [[CH, null]]);
    run();
    expect(a.send).toHaveBeenCalledTimes(1);
  });

  it("delivers when the listener check throws", () => {
    const a = renderer(1);
    const scheduled: Array<() => void> = [];
    const batcher = new PluginPushBatcher({
      schedule: (flush) => scheduled.push(flush),
      resolveScope: () => [a],
      hasListener: () => {
        throw new Error("broken");
      },
    });
    batcher.enqueue({
      pluginId: "acme.demo",
      projectId: null,
      channel: CH,
      panelId: null,
      payload: 1,
      bytes: 10,
    });
    scheduled.splice(0).forEach((f) => f());
    expect(a.send).toHaveBeenCalledTimes(1);
  });
});

describe("PluginPushListenerRegistry reconciliation", () => {
  it("re-evaluates watchers when a renderer joins a scope without reporting", () => {
    vi.useFakeTimers();
    try {
      const scopes = new Map<string | null, PluginPushListenerTarget[]>();
      const registry = new PluginPushListenerRegistry((p) => scopes.get(p) ?? [], 2_000);
      const r = renderer(1);
      registry.report(r, [[CH, null]]);
      scopes.set("p1", []);
      const seen: boolean[] = [];
      const stop = registry.watch("p1", CH, (has) => seen.push(has));
      scopes.set("p1", [r]);
      vi.advanceTimersByTime(2_000);
      expect(seen).toEqual([true]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a crashed renderer as having no listeners until it reports again", () => {
    const scopes = new Map<string | null, PluginPushListenerTarget[]>();
    const registry = new PluginPushListenerRegistry((p) => scopes.get(p) ?? [], 0);
    let crash: (() => void) | undefined;
    const r = {
      ...renderer(1),
      on: (_event: "render-process-gone", listener: () => void) => {
        crash = listener;
      },
    };
    scopes.set(null, [r]);
    registry.report(r, [[CH, null]]);
    const seen: boolean[] = [];
    registry.watch(null, CH, (has) => seen.push(has));
    crash!();
    expect(registry.shouldDeliver(1, CH, null)).toBe(false);
    registry.report(r, [[CH, null]]);
    expect(seen).toEqual([false, true]);
  });
});
