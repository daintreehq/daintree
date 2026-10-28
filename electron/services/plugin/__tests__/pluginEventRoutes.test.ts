import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/daintree-test"), getVersion: vi.fn(() => "0.0.0") },
}));

const terminalProjects = new Map<string, string>();
vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: vi.fn(() => ({
    getTerminalProjectId: (terminalId: string) => terminalProjects.get(terminalId) ?? null,
  })),
}));

import {
  createPluginEventRoutes,
  createRouteWakeScheduler,
  type PluginEventRouteDeps,
} from "../pluginEventRoutes.js";
import type {
  PluginWorktreeEventPayload,
  PluginWorktreeSnapshotFetchResult,
} from "../pluginEventScope.js";
import { events } from "../../events.js";
import {
  ProjectPresenceTracker,
  _setProjectPresenceTrackerForTests,
} from "../../ProjectPresenceTracker.js";
import { toPluginAgentSnapshot } from "../../../../shared/utils/pluginAgentSnapshot.js";
import {
  UNBOUND_PLUGIN_HOST_BINDING,
  type BuiltInPluginCapability,
  type PluginEventRoute,
  type PluginEventRouteWake,
  type PluginHostBinding,
} from "../../../../shared/types/plugin.js";
import type { WorktreeSnapshot } from "../../../../shared/types/workspace-host.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const PLUGIN_ID = "acme.router";
const ALPHA = "a".repeat(64);
const BETA = "b".repeat(64);
const SCRATCH = "11111111-2222-4333-8444-555555555555";
const ROOT_A = path.join(path.sep, "repos", "alpha");
const ROOT_B = path.join(path.sep, "repos", "beta");
const BOUND: PluginHostBinding = { projectId: ALPHA, projectRoot: ROOT_A };

function worktree(id: string, root = ROOT_A): WorktreeSnapshot {
  return {
    id,
    path: path.join(root, id),
    branch: id,
    isCurrent: false,
    worktreeChanges: { changes: [] },
  } as unknown as WorktreeSnapshot;
}

const ok = (
  projectId: string,
  snapshots: WorktreeSnapshot[]
): PluginWorktreeSnapshotFetchResult => ({
  status: "ok",
  projectId,
  snapshots,
});

interface Harness {
  deps: PluginEventRouteDeps;
  plugins: Map<string, LoadedPlugin>;
  dispatched: Array<{ actionId: string; wake: PluginEventRouteWake }>;
  capabilities: Set<BuiltInPluginCapability>;
  workerFailed: { value: boolean };
  /** What the next worktree read answers; replaced between events. */
  read: { ambient: PluginWorktreeSnapshotFetchResult; bound: PluginWorktreeSnapshotFetchResult };
  /** Fire a raw worktree event at every attached listener. */
  emitWorktree: (payload?: PluginWorktreeEventPayload) => void;
  attached: () => number;
}

function makeHarness(): Harness {
  const plugins = new Map<string, LoadedPlugin>([
    [PLUGIN_ID, { manifest: { name: PLUGIN_ID } } as unknown as LoadedPlugin],
  ]);
  const dispatched: Harness["dispatched"] = [];
  const capabilities = new Set<BuiltInPluginCapability>(["agent:read"]);
  const workerFailed = { value: false };
  const read: Harness["read"] = { ambient: ok(ALPHA, []), bound: ok(ALPHA, []) };
  // One entry per attachment: the routes attach the same handler for both events.
  const listeners = new Set<{ handler: (payload?: PluginWorktreeEventPayload) => void }>();
  const deps: PluginEventRouteDeps = {
    plugins,
    declaredCapabilities: () => capabilities,
    fetchWorktreeSnapshotsResult: async () => read.ambient,
    fetchWorktreeSnapshotsForProjectResult: async () => read.bound,
    getWorktreeCustomTitles: () => ({}),
    attachWorktreeEvent: (_event, handler) => {
      const entry = { handler };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    isWorkerFailed: () => workerFailed.value,
    dispatch: async (actionId, wake) => {
      dispatched.push({ actionId, wake });
    },
  };
  return {
    deps,
    plugins,
    dispatched,
    capabilities,
    workerFailed,
    read,
    emitWorktree: (payload) => {
      // Once per distinct handler, as one WorkspaceClient event reaches each listener once.
      for (const handler of new Set([...listeners].map((entry) => entry.handler))) handler(payload);
    },
    attached: () => listeners.size,
  };
}

const route = (event: PluginEventRoute["event"], command = "onWake"): PluginEventRoute => ({
  event,
  command,
});

function emitAgent(terminalId: string, state: string, previousState: string): void {
  events.emit("agent:state-changed", {
    terminalId,
    state,
    previousState,
    timestamp: 1,
  } as never);
}

describe("createRouteWakeScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const wake = (projectId: string): PluginEventRouteWake => ({
    event: "projectForeground",
    presence: { projectId, state: "foreground" },
  });

  it("delivers one wake per key, carrying the latest value offered", async () => {
    const ran: PluginEventRouteWake[] = [];
    const scheduler = createRouteWakeScheduler({
      run: async (w) => void ran.push(w),
      suspended: () => false,
    });
    scheduler.offer("k", () => wake("one"));
    scheduler.offer("k", () => wake("two"));
    scheduler.offer("k", () => wake("three"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ran).toEqual([wake("three")]);
  });

  it("runs distinct keys one at a time, spaced by the minimum interval", async () => {
    const starts: number[] = [];
    const scheduler = createRouteWakeScheduler({
      run: async () => void starts.push(performance.now()),
      suspended: () => false,
      coalesceMs: 10,
      minIntervalMs: 1_000,
    });
    const t0 = performance.now();
    scheduler.offer("a", () => wake("a"));
    scheduler.offer("b", () => wake("b"));
    scheduler.offer("c", () => wake("c"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(starts).toHaveLength(3);
    expect(starts[0] - t0).toBeLessThan(1_000);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1_000);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(1_000);
  });

  it("starts the next wake only once the running one settles", async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const scheduler = createRouteWakeScheduler({
      run: (w) => {
        started.push(w.event === "projectForeground" ? w.presence.projectId : "");
        return new Promise<void>((resolve) => releases.push(resolve));
      },
      suspended: () => false,
      minIntervalMs: 0,
    });
    scheduler.offer("a", () => wake("a"));
    scheduler.offer("b", () => wake("b"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started).toEqual(["a"]);
    releases[0]();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toEqual(["a", "b"]);
    releases[1]();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toEqual(["a", "b"]);
  });

  it("cannot be postponed by a key that keeps changing", async () => {
    const starts: number[] = [];
    const scheduler = createRouteWakeScheduler({
      run: async () => void starts.push(performance.now()),
      suspended: () => false,
      coalesceMs: 100,
    });
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      scheduler.offer("k", () => wake(String(i)));
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(starts.length).toBeGreaterThan(0);
    expect(starts[0] - t0).toBeLessThanOrEqual(100);
  });

  it("drops a cancelled wake, and a key whose wake has become moot costs no interval", async () => {
    const ran: string[] = [];
    const scheduler = createRouteWakeScheduler({
      run: async (w) => void ran.push(w.event === "projectForeground" ? w.presence.projectId : ""),
      suspended: () => false,
      minIntervalMs: 1_000,
    });
    scheduler.offer("cancelled", () => wake("cancelled"));
    scheduler.offer("moot", () => null);
    scheduler.offer("kept", () => wake("kept"));
    scheduler.cancel("cancelled");
    await vi.advanceTimersByTimeAsync(500);
    expect(ran).toEqual(["kept"]);
  });

  it("holds at most maxPending keys, forgetting the oldest", async () => {
    const ran: string[] = [];
    const scheduler = createRouteWakeScheduler({
      run: async (w) => void ran.push(w.event === "projectForeground" ? w.presence.projectId : ""),
      suspended: () => false,
      minIntervalMs: 0,
      maxPending: 2,
    });
    scheduler.offer("a", () => wake("a"));
    scheduler.offer("b", () => wake("b"));
    scheduler.offer("c", () => wake("c"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ran).toEqual(["b", "c"]);
  });

  it("drops everything while suspended rather than replaying it later", async () => {
    const ran: PluginEventRouteWake[] = [];
    const suspended = { value: false };
    const scheduler = createRouteWakeScheduler({
      run: async (w) => void ran.push(w),
      suspended: () => suspended.value,
    });
    scheduler.offer("held", () => wake("held"));
    suspended.value = true;
    await vi.advanceTimersByTimeAsync(5_000);
    scheduler.offer("refused", () => wake("refused"));
    suspended.value = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ran).toEqual([]);
  });

  it("keeps going after a wake rejects", async () => {
    const ran: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const scheduler = createRouteWakeScheduler({
      run: async (w) => {
        const id = w.event === "projectForeground" ? w.presence.projectId : "";
        ran.push(id);
        if (id === "a") throw new Error("boom");
      },
      suspended: () => false,
      minIntervalMs: 0,
    });
    scheduler.offer("a", () => wake("a"));
    scheduler.offer("b", () => wake("b"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ran).toEqual(["a", "b"]);
    errorSpy.mockRestore();
  });
});

describe("createPluginEventRoutes", () => {
  let tracker: ProjectPresenceTracker;
  let shown: string[];
  // Disposed after every test, pass or fail, so no route outlives its test on
  // the shared event bus.
  const live: Array<{ dispose(): void }> = [];

  const routesFor = (...args: Parameters<typeof createPluginEventRoutes>) => {
    const routes = createPluginEventRoutes(...args);
    live.push(routes);
    return routes;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    terminalProjects.clear();
    shown = [];
    tracker = new ProjectPresenceTracker(() => shown);
    _setProjectPresenceTrackerForTests(tracker);
  });

  afterEach(() => {
    for (const routes of live.splice(0)) routes.dispose();
    _setProjectPresenceTrackerForTests(null);
    vi.useRealTimers();
  });

  describe("agentWaiting", () => {
    it("runs the routed command with the projected snapshot when an agent starts waiting", async () => {
      const h = makeHarness();
      terminalProjects.set("t1", ALPHA);
      const routes = routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [
        route("agentWaiting"),
      ]);
      const payload = {
        terminalId: "t1",
        state: "waiting",
        previousState: "working",
        waitingReason: "prompt",
        timestamp: 7,
      } as const;
      events.emit("agent:state-changed", payload as never);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched).toEqual([
        {
          actionId: `${PLUGIN_ID}.onWake`,
          wake: {
            event: "agentWaiting",
            agent: toPluginAgentSnapshot(payload as never, { workspaceId: ALPHA }),
          },
        },
      ]);
      routes.dispose();
    });

    it("wakes nothing on other transitions, or on waiting to waiting", async () => {
      const h = makeHarness();
      const routes = routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [
        route("agentWaiting"),
      ]);
      emitAgent("t1", "working", "idle");
      emitAgent("t2", "waiting", "waiting");
      emitAgent("t3", "completed", "working");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched).toEqual([]);
      routes.dispose();
    });

    it("cancels the wake when the agent stops waiting before it runs", async () => {
      const h = makeHarness();
      const routes = routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [
        route("agentWaiting"),
      ]);
      emitAgent("t1", "waiting", "working");
      emitAgent("t1", "working", "waiting");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched).toEqual([]);
      routes.dispose();
    });

    it("hears nothing without agent:read, like the subscription", async () => {
      const h = makeHarness();
      h.capabilities.clear();
      const routes = routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [
        route("agentWaiting"),
      ]);
      emitAgent("t1", "waiting", "working");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched).toEqual([]);
      routes.dispose();
    });

    it("keeps a project plugin to its own project's agents", async () => {
      const h = makeHarness();
      terminalProjects.set("mine", ALPHA);
      terminalProjects.set("theirs", BETA);
      const routes = routesFor(h.deps, PLUGIN_ID, BOUND, [route("agentWaiting")]);
      emitAgent("theirs", "waiting", "working");
      emitAgent("unattributed", "waiting", "working");
      emitAgent("mine", "waiting", "working");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.dispatched.map((d) => d.wake)).toEqual([
        expect.objectContaining({
          event: "agentWaiting",
          agent: expect.objectContaining({ terminalId: "mine", workspaceId: ALPHA }),
        }),
      ]);
      routes.dispose();
    });
  });

  describe("projectForeground", () => {
    it("wakes on a project coming to the foreground, without replaying the current one", async () => {
      const h = makeHarness();
      tracker.markOpened(ALPHA);
      tracker.markOpened(BETA);
      shown = [ALPHA];
      tracker.refresh();
      const routes = routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [
        route("projectForeground", "onShown"),
      ]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched).toEqual([]);

      shown = [BETA];
      tracker.refresh();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched).toEqual([
        {
          actionId: `${PLUGIN_ID}.onShown`,
          wake: { event: "projectForeground", presence: { projectId: BETA, state: "foreground" } },
        },
      ]);
      routes.dispose();
    });

    it("cancels the wake when the project goes back before it runs", async () => {
      const h = makeHarness();
      tracker.markOpened(ALPHA);
      tracker.markOpened(BETA);
      shown = [ALPHA];
      tracker.refresh();
      const routes = routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [
        route("projectForeground"),
      ]);
      shown = [BETA];
      tracker.refresh();
      shown = [ALPHA];
      tracker.refresh();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched.map((d) => d.wake)).toEqual([
        { event: "projectForeground", presence: { projectId: ALPHA, state: "foreground" } },
      ]);
      routes.dispose();
    });

    it("never wakes an installed plugin for a scratch, nor a project plugin for another project", async () => {
      const installed = makeHarness();
      const bound = makeHarness();
      const a = routesFor(installed.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [
        route("projectForeground"),
      ]);
      const b = routesFor(bound.deps, PLUGIN_ID, BOUND, [route("projectForeground")]);
      tracker.markOpened(SCRATCH);
      tracker.markOpened(BETA);
      shown = [SCRATCH, BETA];
      tracker.refresh();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(installed.dispatched.map((d) => d.wake)).toEqual([
        { event: "projectForeground", presence: { projectId: BETA, state: "foreground" } },
      ]);
      expect(bound.dispatched).toEqual([]);
      a.dispose();
      b.dispose();
    });
  });

  describe("worktree routes", () => {
    it("seeds silently, then wakes the add route with the net change", async () => {
      const h = makeHarness();
      h.read.ambient = ok(ALPHA, [worktree("main")]);
      const routes = routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [
        route("worktreeAdded", "onAdded"),
        route("worktreeRemoved", "onRemoved"),
      ]);
      await vi.advanceTimersByTimeAsync(2_000);
      h.emitWorktree({ projectPath: ROOT_A });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched).toEqual([]);

      h.read.ambient = ok(ALPHA, [worktree("main"), worktree("feature")]);
      h.emitWorktree({ projectPath: ROOT_A });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched).toHaveLength(1);
      const [{ actionId, wake }] = h.dispatched;
      expect(actionId).toBe(`${PLUGIN_ID}.onAdded`);
      expect(wake).toMatchObject({
        event: "worktreeAdded",
        change: { added: ["feature"], removed: [], changed: [] },
      });
      expect(wake.event === "worktreeAdded" && wake.worktrees.map((w) => w.id)).toEqual([
        "main",
        "feature",
      ]);
      routes.dispose();
    });

    it("wakes each route once for a change that both adds and removes", async () => {
      const h = makeHarness();
      h.read.ambient = ok(ALPHA, [worktree("main"), worktree("old")]);
      const routes = routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [
        route("worktreeAdded", "onAdded"),
        route("worktreeRemoved", "onRemoved"),
      ]);
      await vi.advanceTimersByTimeAsync(2_000);
      h.read.ambient = ok(ALPHA, [worktree("main"), worktree("new")]);
      h.emitWorktree();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.dispatched.map((d) => d.actionId).sort()).toEqual([
        `${PLUGIN_ID}.onAdded`,
        `${PLUGIN_ID}.onRemoved`,
      ]);
      routes.dispose();
    });

    it("cancels an add that is removed again while its wake waits its turn", async () => {
      const h = makeHarness();
      h.read.ambient = ok(ALPHA, [worktree("main")]);
      const routes = routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [
        route("worktreeAdded"),
      ]);
      await vi.advanceTimersByTimeAsync(2_000);
      h.read.ambient = ok(ALPHA, [worktree("main"), worktree("first")]);
      h.emitWorktree();
      await vi.advanceTimersByTimeAsync(300);
      expect(h.dispatched).toHaveLength(1);

      // The next wake is held by the interval; the worktree goes before it runs.
      h.read.ambient = ok(ALPHA, [worktree("main"), worktree("first"), worktree("brief")]);
      h.emitWorktree();
      await vi.advanceTimersByTimeAsync(300);
      h.read.ambient = ok(ALPHA, [worktree("main"), worktree("first")]);
      h.emitWorktree();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.dispatched).toHaveLength(1);
      routes.dispose();
    });

    it("wakes the remove route for a worktree whose add was delivered earlier", async () => {
      const h = makeHarness();
      h.read.ambient = ok(ALPHA, [worktree("main")]);
      routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [
        route("worktreeAdded", "onAdded"),
        route("worktreeRemoved", "onRemoved"),
      ]);
      await vi.advanceTimersByTimeAsync(2_000);
      h.read.ambient = ok(ALPHA, [worktree("main"), worktree("feature")]);
      h.emitWorktree();
      await vi.advanceTimersByTimeAsync(2_000);
      h.read.ambient = ok(ALPHA, [worktree("main")]);
      h.emitWorktree();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched.map((d) => [d.actionId, d.wake])).toEqual([
        [
          `${PLUGIN_ID}.onAdded`,
          expect.objectContaining({ change: { added: ["feature"], removed: [], changed: [] } }),
        ],
        [
          `${PLUGIN_ID}.onRemoved`,
          expect.objectContaining({ change: { added: [], removed: ["feature"], changed: [] } }),
        ],
      ]);
    });

    it("hears a removal with only the remove route declared, after an unrouted add", async () => {
      const h = makeHarness();
      h.read.ambient = ok(ALPHA, [worktree("main")]);
      routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [route("worktreeRemoved")]);
      await vi.advanceTimersByTimeAsync(2_000);
      h.read.ambient = ok(ALPHA, [worktree("main"), worktree("feature")]);
      h.emitWorktree();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched).toEqual([]);
      h.read.ambient = ok(ALPHA, [worktree("main")]);
      h.emitWorktree();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched.map((d) => d.wake)).toEqual([
        expect.objectContaining({
          event: "worktreeRemoved",
          change: { added: [], removed: ["feature"], changed: [] },
        }),
      ]);
    });

    it("does not replay a change whose wake was dropped while the worker had failed", async () => {
      const h = makeHarness();
      h.read.ambient = ok(ALPHA, [worktree("main")]);
      routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [route("worktreeAdded")]);
      await vi.advanceTimersByTimeAsync(2_000);
      h.workerFailed.value = true;
      h.read.ambient = ok(ALPHA, [worktree("main"), worktree("missed")]);
      h.emitWorktree();
      await vi.advanceTimersByTimeAsync(2_000);
      h.workerFailed.value = false;
      // A status poll with the same membership must not resurrect "missed".
      h.emitWorktree();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched).toEqual([]);
      // A new add after recovery still wakes, and reports only itself.
      h.read.ambient = ok(ALPHA, [worktree("main"), worktree("missed"), worktree("after")]);
      h.emitWorktree();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched.map((d) => d.wake)).toEqual([
        expect.objectContaining({ change: { added: ["after"], removed: [], changed: [] } }),
      ]);
    });

    it("does not deliver a change heard while failed when the worker recovers before the read", async () => {
      const h = makeHarness();
      h.read.ambient = ok(ALPHA, [worktree("main")]);
      routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [route("worktreeAdded")]);
      await vi.advanceTimersByTimeAsync(2_000);
      h.workerFailed.value = true;
      h.read.ambient = ok(ALPHA, [worktree("main"), worktree("missed")]);
      h.emitWorktree();
      // Recovered inside the read's coalescing window, before the read runs.
      await vi.advanceTimersByTimeAsync(20);
      h.workerFailed.value = false;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched).toEqual([]);
      h.read.ambient = ok(ALPHA, [worktree("main"), worktree("missed"), worktree("after")]);
      h.emitWorktree();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched.map((d) => d.wake)).toEqual([
        expect.objectContaining({ change: { added: ["after"], removed: [], changed: [] } }),
      ]);
    });

    it("never reads an unavailable set as every worktree removed", async () => {
      const h = makeHarness();
      h.read.ambient = ok(ALPHA, [worktree("main"), worktree("feature")]);
      const routes = routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [
        route("worktreeRemoved"),
      ]);
      await vi.advanceTimersByTimeAsync(2_000);
      h.read.ambient = { status: "unavailable", reason: "project-unavailable" };
      h.emitWorktree();
      await vi.advanceTimersByTimeAsync(2_000);
      // A workspace-host restart replays the same set: still nothing removed.
      h.read.ambient = ok(ALPHA, [worktree("main"), worktree("feature")]);
      h.emitWorktree();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched).toEqual([]);
      routes.dispose();
    });

    it("treats focus moving to another project as a new baseline, not a change", async () => {
      const h = makeHarness();
      h.read.ambient = ok(ALPHA, [worktree("main")]);
      const routes = routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [
        route("worktreeAdded"),
        route("worktreeRemoved"),
      ]);
      await vi.advanceTimersByTimeAsync(2_000);
      h.read.ambient = ok(BETA, [worktree("trunk", ROOT_B), worktree("spike", ROOT_B)]);
      h.emitWorktree();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched).toEqual([]);

      // Back on alpha, which gained a worktree while unfocused.
      h.read.ambient = ok(ALPHA, [worktree("main"), worktree("feature")]);
      h.emitWorktree();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.dispatched.map((d) => d.wake)).toEqual([
        expect.objectContaining({
          event: "worktreeAdded",
          change: { added: ["feature"], removed: [], changed: [] },
        }),
      ]);
      routes.dispose();
    });

    it("drops another project's worktree events for a project plugin", async () => {
      const h = makeHarness();
      h.read.bound = ok(ALPHA, [worktree("main")]);
      const routes = routesFor(h.deps, PLUGIN_ID, BOUND, [route("worktreeAdded")]);
      await vi.advanceTimersByTimeAsync(2_000);
      const reads = vi.spyOn(h.deps, "fetchWorktreeSnapshotsForProjectResult");
      h.emitWorktree({ projectPath: ROOT_B });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(reads).not.toHaveBeenCalled();
      routes.dispose();
    });
  });

  it("delivers nothing while the worker has failed", async () => {
    const h = makeHarness();
    h.workerFailed.value = true;
    const routes = routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [
      route("agentWaiting"),
    ]);
    emitAgent("t1", "waiting", "working");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.dispatched).toEqual([]);

    // Recovery resumes with new events; the ones dropped stay dropped.
    h.workerFailed.value = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.dispatched).toEqual([]);
    emitAgent("t2", "waiting", "working");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.dispatched).toHaveLength(1);
    routes.dispose();
  });

  it("stops for an instance that was unloaded or replaced", async () => {
    const h = makeHarness();
    const routes = routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [
      route("agentWaiting"),
    ]);
    h.plugins.set(PLUGIN_ID, { manifest: { name: PLUGIN_ID } } as unknown as LoadedPlugin);
    emitAgent("t1", "waiting", "working");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.dispatched).toEqual([]);
    routes.dispose();
  });

  it("detaches every listener and drops pending wakes on dispose", async () => {
    const h = makeHarness();
    const busUnsubscribes: Array<ReturnType<typeof vi.fn>> = [];
    const on = events.on.bind(events);
    const busSpy = vi.spyOn(events, "on").mockImplementation(((
      event: Parameters<typeof events.on>[0],
      listener: Parameters<typeof events.on>[1]
    ) => {
      const unsubscribe = vi.fn(on(event, listener));
      busUnsubscribes.push(unsubscribe);
      return unsubscribe;
    }) as typeof events.on);
    const presenceUnsubscribes: Array<ReturnType<typeof vi.fn>> = [];
    const subscribe = tracker.subscribe.bind(tracker);
    vi.spyOn(tracker, "subscribe").mockImplementation((listener) => {
      const unsubscribe = vi.fn(subscribe(listener));
      presenceUnsubscribes.push(unsubscribe);
      return unsubscribe;
    });
    const routes = routesFor(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING, [
      route("agentWaiting"),
      route("worktreeAdded"),
      route("projectForeground"),
    ]);
    busSpy.mockRestore();
    expect(h.attached()).toBe(2);
    expect(busUnsubscribes).toHaveLength(1);
    expect(presenceUnsubscribes).toHaveLength(1);
    emitAgent("t1", "waiting", "working");
    routes.dispose();
    expect(h.attached()).toBe(0);
    expect(busUnsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(presenceUnsubscribes[0]).toHaveBeenCalledTimes(1);
    tracker.markOpened(BETA);
    shown = [BETA];
    tracker.refresh();
    emitAgent("t2", "waiting", "working");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.dispatched).toEqual([]);
  });
});
