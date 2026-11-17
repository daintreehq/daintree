import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { appendFileSync } from "fs";

interface FakeWc {
  id: number;
  projectId: string;
  cached: boolean;
  sends: Array<{ channel: string; args: unknown[] }>;
  isDestroyed: () => boolean;
  send: (channel: string, ...args: unknown[]) => void;
}

const registry = vi.hoisted(() => ({
  views: [] as FakeWc[],
  projectViewsRegistered: true,
  // Mirrors the real registry pruning its last dead view inside
  // getRegisteredProjectViews after hasRegisteredProjectViews said yes.
  pruneOnRead: false,
}));
const bus = vi.hoisted(() => {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    listeners,
    on: (name: string, listener: (payload: unknown) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
      return () => listeners.get(name)?.delete(listener);
    },
    emit: (name: string, payload: unknown) => {
      for (const l of listeners.get(name) ?? []) l(payload);
    },
  };
});

const frozenIds = vi.hoisted(() => new Set<number>());
vi.mock("../../../../utils/webContentsLifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../utils/webContentsLifecycle.js")>()),
  isWebContentsFrozen: (wc: { id: number }) => frozenIds.has(wc.id),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

vi.mock("../../../../window/webContentsRegistry.js", () => ({
  getAllAppWebContents: () => registry.views,
  getAppWebContents: () => registry.views[0],
  hasRegisteredProjectViews: () => registry.projectViewsRegistered,
  getWebContentsForProject: (projectId: string) =>
    registry.views.filter((v) => v.projectId === projectId),
  isCachedViewWebContents: (id: number) => registry.views.some((v) => v.id === id && v.cached),
  getProjectForWebContents: (id: number) =>
    registry.views.find((v) => v.id === id)?.projectId ?? null,
  getRegisteredProjectViews: () =>
    registry.pruneOnRead
      ? []
      : registry.views.map((v) => ({ webContents: v, projectId: v.projectId })),
  resolveLiveWebContents: () => null,
  getWindowForWebContents: () => null,
}));
vi.mock("../../../../services/McpPaneConfigService.js", () => ({
  mcpPaneConfigService: { revokePaneConfig: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../../../services/pty/agentSessionCapturePersistence.js", () => ({
  acceptCapturedAgentSession: vi.fn(),
  acceptObservedAgentSession: vi.fn(),
  releaseSupersededCapturedSession: vi.fn(),
}));
vi.mock("../../../../services/events.js", () => ({
  events: bus,
}));

import { CHANNELS } from "../../../channels.js";
import { registerTerminalEventHandlers } from "../events.js";
import { registerEventsHandlers } from "../../events.js";
import type { HandlerDependencies } from "../../../types.js";

const PROJECTS = 6;
const TERMINALS_PER_PROJECT = 20;

function makeView(id: number, projectId: string, cached: boolean): FakeWc {
  const wc: FakeWc = {
    id,
    projectId,
    cached,
    sends: [],
    isDestroyed: () => false,
    send: (channel, ...args) => {
      wc.sends.push({ channel, args });
    },
  };
  return wc;
}

function makeBatch() {
  const metrics: Record<string, unknown> = {};
  for (let p = 0; p < PROJECTS; p++) {
    for (let t = 0; t < TERMINALS_PER_PROJECT; t++) {
      metrics[`p${p}-t${t}`] = {
        cpuPercent: 1.5,
        memoryKb: 51200,
        processCount: 3,
        breakdown: [
          { pid: 1000 + t, comm: "zsh", cpuPercent: 0.5, memoryKb: 20000 },
          { pid: 2000 + t, comm: "node", cpuPercent: 1, memoryKb: 31200 },
        ],
      };
    }
  }
  return metrics;
}

describe("terminal resource-metrics fan-out", () => {
  let ptyClient: EventEmitter & { getTerminalProjectId: (id: string) => string | null };
  let dispose: () => void;

  beforeEach(() => {
    // One visible view (project 0) and five cached views (projects 1-5).
    registry.projectViewsRegistered = true;
    registry.pruneOnRead = false;
    frozenIds.clear();
    registry.views = Array.from({ length: PROJECTS }, (_, p) => makeView(p + 1, `p${p}`, p !== 0));
    ptyClient = Object.assign(new EventEmitter(), {
      getTerminalProjectId: (id: string) => (id.includes("-") ? id.split("-")[0]! : null),
    });
    const disposeTerminal = registerTerminalEventHandlers({
      ptyClient,
    } as unknown as HandlerDependencies);
    const disposeEvents = registerEventsHandlers({ events: bus } as unknown as HandlerDependencies);
    dispose = () => {
      disposeTerminal();
      disposeEvents();
    };
  });

  afterEach(() => dispose());

  it("measures reliability-metric sends per event", () => {
    const EVENTS = 50;
    for (let i = 0; i < EVENTS; i++) {
      bus.emit("terminal:reliability-metric", {
        terminalId: `p${i % PROJECTS}-t0`,
        metricType: "pause-end",
        timestamp: i,
        durationMs: 1200,
      });
    }
    const delivered = registry.views.map(
      (v) =>
        v.sends.filter(
          (s) =>
            s.channel === CHANNELS.EVENTS_PUSH &&
            (s.args[0] as { name?: string })?.name === "terminal:reliability-metric"
        ).length
    );
    const total = delivered.reduce((a, b) => a + b, 0);
    if (process.env.BENCH_OUT) {
      appendFileSync(process.env.BENCH_OUT, `reliability-metric sends/event=${total / EVENTS}\n`);
    }
    // Only the owning project's view gets each event.
    expect(delivered).toEqual(registry.views.map((_, p) => (p < EVENTS % PROJECTS ? 9 : 8)));
  });

  it("falls back to every view when the terminal's project is unknown", () => {
    bus.emit("terminal:reliability-metric", {
      terminalId: "orphan",
      metricType: "pause-end",
      timestamp: 0,
      durationMs: 1200,
    });
    for (const view of registry.views) {
      expect(view.sends.filter((s) => s.channel === CHANNELS.EVENTS_PUSH)).toHaveLength(1);
    }
  });

  it("gives each view, cached or not, only its own project's terminals", () => {
    ptyClient.emit("resource-metrics", makeBatch(), 42);

    for (const [p, view] of registry.views.entries()) {
      expect(view.sends).toHaveLength(1);
      const { metrics, timestamp } = view.sends[0]!.args[0] as {
        metrics: Record<string, unknown>;
        timestamp: number;
      };
      expect(timestamp).toBe(42);
      expect(Object.keys(metrics)).toEqual(
        Array.from({ length: TERMINALS_PER_PROJECT }, (_, t) => `p${p}-t${t}`)
      );
    }
  });

  it("sends terminals with no known project to every view", () => {
    ptyClient.emit(
      "resource-metrics",
      { "p0-t0": { cpuPercent: 1 }, orphan: { cpuPercent: 2 } },
      1
    );

    const keys = registry.views.map((v) =>
      Object.keys((v.sends[0]?.args[0] as { metrics: Record<string, unknown> }).metrics)
    );
    expect(keys[0]).toEqual(["p0-t0", "orphan"]);
    for (const k of keys.slice(1)) expect(k).toEqual(["orphan"]);
  });

  it("sends terminals of a project with no resident view to every view", () => {
    // An evicted project's PTYs outlive its view; their samples still need a
    // leak detector somewhere, as they had before.
    ptyClient.emit("resource-metrics", { "p0-t0": { cpuPercent: 1 }, "gone-t0": {} }, 1);

    const keys = registry.views.map((v) =>
      Object.keys((v.sends[0]?.args[0] as { metrics: Record<string, unknown> }).metrics)
    );
    expect(keys[0]).toEqual(["p0-t0", "gone-t0"]);
    for (const k of keys.slice(1)) expect(k).toEqual(["gone-t0"]);
  });

  it("sends nothing to views with no sampled terminals (#17194)", () => {
    // Each pty-host shard reports its own terminals on its own tick; a view
    // none of them belong to has nothing to evaluate.
    ptyClient.emit("resource-metrics", { "p2-t0": { cpuPercent: 1 } }, 1);

    expect(registry.views.map((v) => v.sends.length)).toEqual([0, 0, 1, 0, 0, 0]);
    expect(registry.views[2]!.sends[0]!.args[0]).toEqual({
      metrics: { "p2-t0": { cpuPercent: 1 } },
      timestamp: 1,
    });
  });

  it("sends an empty batch to nobody, with or without project views", () => {
    ptyClient.emit("resource-metrics", {}, 1);
    registry.projectViewsRegistered = false;
    ptyClient.emit("resource-metrics", {}, 2);

    expect(registry.views.every((v) => v.sends.length === 0)).toBe(true);
  });

  it("sends a frozen cached view nothing until it thaws (#17038)", () => {
    // p0's view is active, so a freeze it may still be leaving never holds it.
    for (const view of registry.views) frozenIds.add(view.id);
    const batch = { "p0-t0": { cpuPercent: 1 }, "p1-t0": { cpuPercent: 2 } };

    for (let tick = 0; tick < 5; tick++) ptyClient.emit("resource-metrics", batch, tick);

    expect(registry.views.map((v) => v.sends.length)).toEqual([5, 0, 0, 0, 0, 0]);

    frozenIds.clear();
    ptyClient.emit("resource-metrics", batch, 9);
    expect(registry.views.map((v) => v.sends.length)).toEqual([6, 1, 0, 0, 0, 0]);
    expect(registry.views[1]!.sends[0]!.args[0]).toEqual({
      metrics: { "p1-t0": { cpuPercent: 2 } },
      timestamp: 9,
    });
  });

  it("leaves frozen cached views out of the whole-batch send too (#17038)", () => {
    registry.projectViewsRegistered = false;
    frozenIds.add(registry.views[3]!.id);

    ptyClient.emit("resource-metrics", makeBatch(), 7);

    expect(registry.views.map((v) => v.sends.length)).toEqual([1, 1, 1, 0, 1, 1]);
  });

  it("sends each view of a project the same slice", () => {
    registry.views.push(makeView(99, "p1", false));

    ptyClient.emit("resource-metrics", makeBatch(), 1);

    const [cached, visible] = registry.views.filter((v) => v.projectId === "p1");
    expect(visible!.sends[0]!.args[0]).toEqual(cached!.sends[0]!.args[0]);
  });

  it("keeps sending to other views when one send throws", () => {
    registry.views[0]!.send = () => {
      throw new Error("disposed");
    };

    ptyClient.emit("resource-metrics", makeBatch(), 1);

    expect(registry.views.slice(1).every((v) => v.sends.length === 1)).toBe(true);
  });

  it("falls back to a full broadcast when every project view was pruned", () => {
    const all = registry.views;
    registry.pruneOnRead = true;

    ptyClient.emit("resource-metrics", makeBatch(), 1);

    expect(all.every((v) => v.sends.length === 1)).toBe(true);
  });

  it("sends the whole batch to every renderer when no project views are registered", () => {
    registry.projectViewsRegistered = false;
    const batch = makeBatch();

    ptyClient.emit("resource-metrics", batch, 7);

    for (const view of registry.views) {
      expect(view.sends).toHaveLength(1);
      expect(view.sends[0]!.args[0]).toEqual({ metrics: batch, timestamp: 7 });
    }
  });
});
