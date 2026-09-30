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
  it("counts a renderer that has not reported as listening", () => {
    const { registry, scopes } = setup();
    scopes.set(null, [renderer(1)]);
    expect(registry.hasListeners(null, CH)).toBe(true);
    expect(registry.isReported(1)).toBe(false);
    expect(registry.reportedListeners(1)).toBeNull();
  });

  it("records a report's broadcast and targeted pairs apart", () => {
    const { registry, scopes } = setup();
    const r = renderer(1);
    scopes.set(null, [r]);
    registry.report(r, [
      [CH, null],
      [OTHER, "panel-a"],
    ]);
    expect(registry.reportedListeners(1)).toEqual([
      [CH, null],
      [OTHER, "panel-a"],
    ]);
    expect(registry.hasListeners(null, CH)).toBe(true);
    expect(registry.hasListeners(null, OTHER)).toBe(true);
    expect(registry.hasListeners(null, "plugin:acme.demo:never")).toBe(false);
  });

  it("replaces a renderer's state on every report rather than accumulating it", () => {
    const { registry, scopes } = setup();
    const r = renderer(1);
    scopes.set(null, [r]);
    registry.report(r, [[CH, null]]);
    registry.report(r, []);
    expect(registry.hasListeners(null, CH)).toBe(false);
    expect(registry.reportedListeners(1)).toEqual([]);
  });

  it("treats a refused report (null) as unknown, counting it as listening again", () => {
    const { registry, scopes } = setup();
    const r = renderer(1);
    scopes.set(null, [r]);
    registry.report(r, []);
    expect(registry.hasListeners(null, CH)).toBe(false);
    registry.report(r, null);
    expect(registry.hasListeners(null, CH)).toBe(true);
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

describe("PluginPushBatcher ignores listener reports", () => {
  it("delivers to a renderer that reported no subscriber, so a later subscriber is not starved", () => {
    const { registry } = setup();
    const reportedNone = renderer(1);
    const reportedPanel = renderer(2);
    registry.report(reportedNone, []);
    registry.report(reportedPanel, [[CH, "panel-a"]]);
    const scheduled: Array<() => void> = [];
    const batcher = new PluginPushBatcher({
      schedule: (flush) => scheduled.push(flush),
      resolveScope: () => [reportedNone, reportedPanel],
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
    expect(reportedNone.send).toHaveBeenCalledTimes(1);
    expect(reportedPanel.send).toHaveBeenCalledTimes(1);
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

  it("runs the periodic reconcile only while an active watcher exists", () => {
    vi.useFakeTimers();
    try {
      const scopes = new Map<string | null, PluginPushListenerTarget[]>();
      const registry = new PluginPushListenerRegistry((p) => scopes.get(p) ?? [], 2_000);
      const stopPassive = registry.watch(null, CH, () => {}, { passive: true });
      expect(registry.isReconciling()).toBe(false);
      const stopActive = registry.watch(null, CH, () => {});
      expect(registry.isReconciling()).toBe(true);
      stopActive();
      stopActive();
      expect(registry.isReconciling()).toBe(false);
      expect(registry.watcherCount()).toBe(1);
      stopPassive();
      expect(registry.watcherCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still notifies a passive watcher on reports and teardown", () => {
    const { registry, scopes } = setup();
    const r = renderer(1);
    scopes.set(null, [r]);
    registry.report(r, []);
    const seen: boolean[] = [];
    registry.watch(null, CH, (has) => seen.push(has), { passive: true });
    registry.report(r, [[CH, null]]);
    scopes.set(null, []);
    r.destroy();
    expect(seen).toEqual([true, false]);
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
    expect(registry.reportedListeners(1)).toEqual([]);
    registry.report(r, [[CH, null]]);
    expect(seen).toEqual([false, true]);
  });
});
