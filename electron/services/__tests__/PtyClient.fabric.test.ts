import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { EventEmitter } from "events";

vi.mock("electron", () => ({
  utilityProcess: {
    fork: vi.fn(),
  },
  dialog: {
    showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
  },
  app: {
    getPath: vi.fn().mockReturnValue("/mock/user/data"),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock("../TrashedPidTracker.js", () => ({
  getTrashedPidTracker: () => ({
    removeTrashed: vi.fn(),
    persistTrashed: vi.fn().mockResolvedValue(undefined),
    clearAll: vi.fn(),
  }),
}));

interface MockUtilityProcess extends EventEmitter {
  postMessage: Mock;
  kill: Mock;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

interface ForkedShard {
  child: MockUtilityProcess;
  serviceName: string;
  execArgv: string[];
  env: Record<string, string>;
}

function createMockChild(): MockUtilityProcess {
  return Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

function createMockPort() {
  return {
    close: vi.fn(),
    start: vi.fn(),
    on: vi.fn(),
    postMessage: vi.fn(),
  };
}

function messagesOfType(child: MockUtilityProcess, type: string): Record<string, unknown>[] {
  return child.postMessage.mock.calls
    .map((call: unknown[]) => call[0] as Record<string, unknown>)
    .filter((msg) => msg?.type === type);
}

/**
 * PTY fabric (DAINTREE_PTY_FABRIC) — per-project host shards behind the
 * PtyClient facade. These tests drive the fabric through the public API with
 * the flag forced on via config and assert the routing/aggregation/lifecycle
 * invariants the sharding must re-provide: per-project placement, port
 * routing + reroute, crash isolation (scoped orphan cleanup), crash-loop
 * migration to the default shard, idle retirement, cap overflow, and
 * OR-aggregated host signals.
 */
describe("PtyClient fabric", () => {
  let forks: ForkedShard[];
  let failNextFork: boolean;
  let PtyClientClass: typeof import("../PtyClient.js").PtyClient;
  let pluginProcessTools: typeof import("../../../shared/config/pluginProcessToolRegistry.js");
  let fabricConfig: typeof import("../pty/fabricConfig.js");

  beforeEach(async () => {
    forks = [];
    failNextFork = false;

    vi.resetModules();
    vi.doMock("electron", () => ({
      utilityProcess: {
        fork: vi.fn((_path: string, _args: string[], opts: Record<string, unknown>) => {
          if (failNextFork) {
            failNextFork = false;
            throw new Error("simulated fork failure");
          }
          const child = createMockChild();
          forks.push({
            child,
            serviceName: opts.serviceName as string,
            execArgv: (opts.execArgv as string[]) ?? [],
            env: (opts.env as Record<string, string>) ?? {},
          });
          return child;
        }),
      },
      dialog: {
        showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
      },
      app: {
        getPath: vi.fn().mockReturnValue("/mock/user/data"),
        on: vi.fn(),
        off: vi.fn(),
      },
    }));
    vi.doMock("../TrashedPidTracker.js", () => ({
      getTrashedPidTracker: () => ({
        removeTrashed: vi.fn(),
        persistTrashed: vi.fn().mockResolvedValue(undefined),
        clearAll: vi.fn(),
      }),
    }));

    PtyClientClass = (await import("../PtyClient.js")).PtyClient;
    fabricConfig = await import("../pty/fabricConfig.js");
    // Must come from the post-`resetModules` graph: a static top-level import
    // would be a different module instance than the one PtyClient reads, so
    // registrations here would be invisible to the code under test.
    pluginProcessTools = await import("../../../shared/config/pluginProcessToolRegistry.js");

    // Install after imports: fake timers can stall module re-execution (#11661).
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const shardByService = (match: (name: string) => boolean): ForkedShard => {
    const found = forks.find((f) => match(f.serviceName));
    if (!found)
      throw new Error(
        `no fork matching predicate; forks: ${forks.map((f) => f.serviceName).join(", ")}`
      );
    return found;
  };

  const defaultShard = () => shardByService((n) => n === "daintree-pty-host");
  const projectShard = (projectId: string) =>
    shardByService((n) => n.startsWith(`daintree-pty-host:${projectId.slice(0, 16)}-`));

  const createFabricClient = (opts?: { maxProjectShards?: number }) => {
    // Pin the shard cap: the production fallback derives it from os.cpus(),
    // which is 1 on 3-vCPU CI runners and would collapse project shards.
    const client = new PtyClientClass({ fabric: true, maxProjectShards: 4, ...opts });
    defaultShard().child.emit("message", { type: "ready" });
    return client;
  };

  describe("flag off (singleton parity)", () => {
    it("keeps a single host with the legacy service name regardless of projectIds", () => {
      const client = new PtyClientClass({ fabric: false });
      defaultShard().child.emit("message", { type: "ready" });

      client.spawn("t1", { cwd: "/tmp", cols: 80, rows: 24, projectId: "project-a" });
      client.spawn("t2", { cwd: "/tmp", cols: 80, rows: 24, projectId: "project-b" });

      expect(forks).toHaveLength(1);
      expect(forks[0].serviceName).toBe("daintree-pty-host");
      expect(messagesOfType(forks[0].child, "spawn")).toHaveLength(2);
      client.dispose();
    });

    it("forks with the configured 512MB heap and mirrors it into the governor env", () => {
      const client = new PtyClientClass({ fabric: false });
      expect(forks[0].execArgv).toContain("--max-old-space-size=512");
      expect(forks[0].env.DAINTREE_PTY_HEAP_BUDGET_MB).toBe("512");
      client.dispose();
    });
  });

  describe("placement", () => {
    it("gives each project its own shard and routes terminal ops to the owner", () => {
      const client = createFabricClient();

      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      client.spawn("t2", { cwd: "/b", cols: 80, rows: 24, projectId: "project-b" });

      expect(forks).toHaveLength(3);
      const shardA = projectShard("project-a");
      const shardB = projectShard("project-b");
      // On-demand project shards deliver their queued spawn on first ready; the
      // pre-ready send is gated so it isn't delivered twice (once queued, once
      // by the first-ready replay).
      shardA.child.emit("message", { type: "ready" });
      shardB.child.emit("message", { type: "ready" });
      expect(shardA.serviceName).not.toBe(shardB.serviceName);
      expect(messagesOfType(shardA.child, "spawn").map((m) => m.id)).toEqual(["t1"]);
      expect(messagesOfType(shardB.child, "spawn").map((m) => m.id)).toEqual(["t2"]);

      client.write("t1", "echo hi\r");
      client.write("t2", "ls\r");
      expect(messagesOfType(shardA.child, "write").map((m) => m.id)).toEqual(["t1"]);
      expect(messagesOfType(shardB.child, "write").map((m) => m.id)).toEqual(["t2"]);

      // Unknown ids fall back to the default shard.
      client.write("t-unknown", "x");
      expect(messagesOfType(defaultShard().child, "write").map((m) => m.id)).toEqual(["t-unknown"]);
      client.dispose();
    });

    it("keeps projectless terminals on the default shard", () => {
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/tmp", cols: 80, rows: 24 });
      expect(forks).toHaveLength(1);
      expect(messagesOfType(defaultShard().child, "spawn").map((m) => m.id)).toEqual(["t1"]);
      client.dispose();
    });

    it("groups fleet broadcast writes per owning shard", () => {
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      client.spawn("t2", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      client.spawn("t3", { cwd: "/b", cols: 80, rows: 24, projectId: "project-b" });

      client.broadcastWrite(["t1", "t2", "t3"], "hello");

      const shardA = projectShard("project-a");
      const shardB = projectShard("project-b");
      expect(messagesOfType(shardA.child, "broadcast-write")).toEqual([
        { type: "broadcast-write", ids: ["t1", "t2"], data: "hello" },
      ]);
      expect(messagesOfType(shardB.child, "broadcast-write")).toEqual([
        { type: "broadcast-write", ids: ["t3"], data: "hello" },
      ]);
      expect(messagesOfType(defaultShard().child, "broadcast-write")).toHaveLength(0);
      client.dispose();
    });

    it("routes kill-by-project to the owning shard and resolves its broker response", async () => {
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });

      const promise = client.killByProject("project-a");
      const request = messagesOfType(shardA.child, "kill-by-project")[0];
      expect(request).toBeDefined();
      expect(messagesOfType(defaultShard().child, "kill-by-project")).toHaveLength(0);

      shardA.child.emit("message", {
        type: "kill-by-project-result",
        requestId: request.requestId,
        killed: 1,
      });
      await expect(promise).resolves.toBe(1);
      client.dispose();
    });

    it("pins projects beyond the shard cap to the default shard", () => {
      const client = createFabricClient({ maxProjectShards: 1 });
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      client.spawn("t2", { cwd: "/b", cols: 80, rows: 24, projectId: "project-b" });

      expect(forks).toHaveLength(2); // default + project-a only
      expect(messagesOfType(defaultShard().child, "spawn").map((m) => m.id)).toEqual(["t2"]);

      // Placement is sticky: subsequent per-project ops for the overflow
      // project stay on the default shard.
      client.killByProject("project-b");
      expect(messagesOfType(defaultShard().child, "kill-by-project")).toHaveLength(1);
      client.dispose();
    });

    it("RAM-scales the shard heap budget and mirrors it into the governor env", () => {
      const client = createFabricClient();
      const arg = forks[0].execArgv.find((a) => a.startsWith("--max-old-space-size="));
      const heapMb = Number(arg?.split("=")[1]);
      expect(heapMb).toBeGreaterThanOrEqual(512);
      expect(heapMb).toBeLessThanOrEqual(2048);
      expect(forks[0].env.DAINTREE_PTY_HEAP_BUDGET_MB).toBe(String(heapMb));
      client.dispose();
    });
  });

  describe("shard ready replay", () => {
    it("replays owned spawns and cached host-wide config on a project shard's first ready", () => {
      const client = createFabricClient();
      client.setResourceProfile("efficiency" as never);
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      shardA.child.postMessage.mockClear();

      shardA.child.emit("message", { type: "ready" });

      expect(messagesOfType(shardA.child, "set-log-level-overrides")).toHaveLength(1);
      expect(messagesOfType(shardA.child, "set-plugin-agent-registry")).toHaveLength(1);
      expect(messagesOfType(shardA.child, "set-plugin-process-tool-registry")).toHaveLength(1);
      expect(messagesOfType(shardA.child, "set-resource-profile")).toHaveLength(1);
      // The pre-ready spawn send was dropped by the real host; ready replays it.
      expect(messagesOfType(shardA.child, "spawn").map((m) => m.id)).toEqual(["t1"]);
      // Only this shard's terminals replay — never siblings'.
      client.dispose();
    });

    it("fans a plugin process-tool sync out to every ready shard, carrying live content (#11613)", () => {
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });
      const defaultChild = defaultShard().child;
      defaultChild.emit("message", { type: "ready" });
      shardA.child.postMessage.mockClear();
      defaultChild.postMessage.mockClear();

      try {
        pluginProcessTools.registerPluginProcessTools("acme.tools", [
          { command: "acme-cli", iconId: "sparkles" },
        ]);
        client.syncPluginProcessToolRegistry();

        // Every ready shard gets it — a per-project shard is not covered by the
        // default shard's copy — and the payload reflects the registry at call
        // time rather than an empty or cached snapshot.
        for (const child of [shardA.child, defaultChild]) {
          const sent = messagesOfType(child, "set-plugin-process-tool-registry");
          expect(sent).toHaveLength(1);
          expect(sent[0].registry).toEqual({ "acme-cli": "sparkles" });
        }
      } finally {
        pluginProcessTools.clearPluginProcessToolRegistryForTests();
        client.dispose();
      }
    });

    it("mirrors the process-tool registry before replaying spawns (#11613)", () => {
      // Ordering is the contract: a terminal replayed onto a restarted host must
      // resolve its tab icon from the first process-tree poll, so the registry
      // has to land before the spawn, not after.
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      shardA.child.postMessage.mockClear();

      shardA.child.emit("message", { type: "ready" });

      const types = shardA.child.postMessage.mock.calls.map(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.type
      );
      expect(types).toContain("set-plugin-process-tool-registry");
      expect(types).toContain("spawn");
      expect(types.indexOf("set-plugin-process-tool-registry")).toBeLessThan(
        types.indexOf("spawn")
      );
      client.dispose();
    });
  });

  describe("crash isolation", () => {
    it.skipIf(process.platform === "win32")(
      "scopes orphan-PID cleanup to the crashed shard's terminals",
      async () => {
        const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
        try {
          const client = createFabricClient();
          client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
          client.spawn("t2", { cwd: "/tmp", cols: 80, rows: 24 });
          const shardA = projectShard("project-a");
          shardA.child.emit("message", { type: "ready" });
          shardA.child.emit("message", { type: "terminal-pid", id: "t1", pid: 11111 });
          defaultShard().child.emit("message", { type: "terminal-pid", id: "t2", pid: 22222 });

          shardA.child.emit("exit", 1);
          await vi.advanceTimersByTimeAsync(0);

          const killedPids = killSpy.mock.calls.map((c) => c[0]);
          expect(killedPids).toContain(-11111);
          expect(killedPids).not.toContain(-22222);
          expect(killedPids).not.toContain(22222);
          client.dispose();
        } finally {
          killSpy.mockRestore();
        }
      }
    );

    it("respawns only the crashed shard's terminals on its restarted host", async () => {
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      client.spawn("t2", { cwd: "/tmp", cols: 80, rows: 24 });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });
      const defaultChild = defaultShard().child;
      defaultChild.postMessage.mockClear();
      const forkCountBefore = forks.length;

      shardA.child.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(15_000);

      expect(forks.length).toBe(forkCountBefore + 1);
      const restarted = forks[forks.length - 1];
      expect(restarted.serviceName).toBe(shardA.serviceName);
      restarted.child.emit("message", { type: "ready" });

      const respawns = messagesOfType(restarted.child, "spawn");
      expect(respawns.map((m) => m.id)).toEqual(["t1"]);
      // A restarted host is a fresh process with an empty plugin registry, so
      // the mirror has to be replayed here too — and before the respawn, or the
      // recovered terminal resolves its icon against an empty map. The
      // first-ready test can't catch a restart-only regression.
      const restartedTypes = restarted.child.postMessage.mock.calls.map(
        (call: unknown[]) => (call[0] as Record<string, unknown>)?.type
      );
      expect(restartedTypes).toContain("set-plugin-process-tool-registry");
      expect(restartedTypes.indexOf("set-plugin-process-tool-registry")).toBeLessThan(
        restartedTypes.indexOf("spawn")
      );
      // The respawn is a NEW incarnation.
      expect(
        (respawns[0].options as { launchGeneration?: number }).launchGeneration
      ).toBeGreaterThan(1);
      // The healthy default shard saw no respawn traffic.
      expect(messagesOfType(defaultChild, "spawn")).toHaveLength(0);
      client.dispose();
    });

    it("sends a move to the owning shard only, and refuses a foreign project's", async () => {
      // The crash-replay specs below prove only the cache. Without this one, a
      // fix that mutated the cache but never sent would leave the live record —
      // the thing the palette actually reads — stale until a host crash.
      const client = createFabricClient();
      client.spawn("t1", {
        cwd: "/a",
        cols: 80,
        rows: 24,
        projectId: "project-a",
        worktreeId: "/repo",
      });
      client.spawn("t2", { cwd: "/tmp", cols: 80, rows: 24 });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });
      const defaultChild = defaultShard().child;
      shardA.child.postMessage.mockClear();
      defaultChild.postMessage.mockClear();

      client.updateWorktreeId("t1", "/repo/.worktrees/feature", "project-a");

      const sent = messagesOfType(shardA.child, "update-worktree-id");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        id: "t1",
        worktreeId: "/repo/.worktrees/feature",
        expectedProjectId: "project-a",
      });
      expect(messagesOfType(defaultChild, "update-worktree-id")).toHaveLength(0);

      // A sender on another project must not reach into this run's replay cache,
      // or a refused live write would still come true on the next crash respawn.
      client.updateWorktreeId("t1", "/elsewhere", "project-b");

      shardA.child.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(15_000);
      const restarted = forks[forks.length - 1];
      restarted.child.emit("message", { type: "ready" });
      const respawns = messagesOfType(restarted.child, "spawn");
      expect((respawns[0].options as { worktreeId?: string }).worktreeId).toBe(
        "/repo/.worktrees/feature"
      );
      client.dispose();
    });

    it("respawns under the worktree a run was moved to, not the one it launched in", async () => {
      // `pendingSpawns` is replayed verbatim on a crash respawn, so a move that
      // only reached the live record would be silently undone by the next host
      // crash — the run would reappear in the palette under the worktree the
      // user dragged it out of (#12060).
      const client = createFabricClient();
      client.spawn("t1", {
        cwd: "/a",
        cols: 80,
        rows: 24,
        projectId: "project-a",
        worktreeId: "/repo/.worktrees/old",
      });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });

      client.updateWorktreeId("t1", "/repo/.worktrees/new", "project-a");

      shardA.child.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(15_000);
      const restarted = forks[forks.length - 1];
      restarted.child.emit("message", { type: "ready" });

      const respawns = messagesOfType(restarted.child, "spawn");
      expect((respawns[0].options as { worktreeId?: string }).worktreeId).toBe(
        "/repo/.worktrees/new"
      );
      client.dispose();
    });

    it("respawns with no worktree at all after an explicit clear", async () => {
      // The clear has to delete the cached key, not blank it: a replay carrying
      // `worktreeId: ""` would re-file the run under a worktree named "".
      const client = createFabricClient();
      client.spawn("t1", {
        cwd: "/a",
        cols: 80,
        rows: 24,
        projectId: "project-a",
        worktreeId: "/repo/.worktrees/old",
      });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });

      client.updateWorktreeId("t1", null, "project-a");

      shardA.child.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(15_000);
      const restarted = forks[forks.length - 1];
      restarted.child.emit("message", { type: "ready" });

      const respawns = messagesOfType(restarted.child, "spawn");
      expect(respawns[0].options as Record<string, unknown>).not.toHaveProperty("worktreeId");
      client.dispose();
    });

    it("migrates a crash-looping project shard's terminals to the default shard without a global host-crash", async () => {
      const client = createFabricClient();
      const hostCrash = vi.fn();
      client.on("host-crash", hostCrash);
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      projectShard("project-a").child.emit("message", { type: "ready" });

      // Three crashes inside the window exhaust the shard's restart budget.
      for (let i = 0; i < 3; i++) {
        const shardChild = forks[forks.length - 1].child;
        shardChild.emit("exit", 1);
        await vi.advanceTimersByTimeAsync(15_000);
      }

      expect(hostCrash).not.toHaveBeenCalled();
      const migrated = messagesOfType(defaultShard().child, "spawn");
      expect(migrated.map((m) => m.id)).toEqual(["t1"]);

      // The project is pinned to the default shard for the session.
      const forkCount = forks.length;
      client.spawn("t3", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      expect(forks.length).toBe(forkCount);
      expect(messagesOfType(defaultShard().child, "spawn").map((m) => m.id)).toEqual(["t1", "t3"]);
      client.dispose();
    });

    it("still emits host-crash when the default shard exhausts its restart budget", async () => {
      const client = createFabricClient();
      const hostCrash = vi.fn();
      client.on("host-crash", hostCrash);

      for (let i = 0; i < 3; i++) {
        const child = forks[forks.length - 1].child;
        child.emit("exit", 1);
        await vi.advanceTimersByTimeAsync(15_000);
      }

      expect(hostCrash).toHaveBeenCalledTimes(1);
      client.dispose();
    });
  });

  describe("window port routing", () => {
    it("routes a window's port to its active project's shard and disconnects the previous shard", () => {
      const client = createFabricClient();
      const refresh = vi.fn();
      client.setPortRefreshCallback(refresh);

      // No context yet: the port lands on the default shard.
      const portA = createMockPort();
      client.connectMessagePort(1, portA as never);
      expect(messagesOfType(defaultShard().child, "connect-port")).toHaveLength(1);

      // Activating a project on another shard triggers a targeted re-mint.
      client.setActiveProject(1, "project-a", "/projects/a");
      expect(refresh).toHaveBeenCalledWith(1);

      const shardA = projectShard("project-a");
      const portB = createMockPort();
      client.connectMessagePort(1, portB as never);
      // Old shard is told to drop its per-window connection state...
      expect(messagesOfType(defaultShard().child, "disconnect-port")).toEqual([
        { type: "disconnect-port", windowId: 1 },
      ]);
      // ...and the new port lands on the owning shard.
      const connect = shardA.child.postMessage.mock.calls.find(
        (c: unknown[]) => (c[0] as { type?: string }).type === "connect-port"
      );
      expect(connect).toBeDefined();
      expect(connect?.[1]).toEqual([portB]);

      // Focus routing follows the port.
      shardA.child.postMessage.mockClear();
      client.setFocusedTerminal(1, "t1");
      expect(messagesOfType(shardA.child, "set-focused-terminal")).toEqual([
        { type: "set-focused-terminal", windowId: 1, id: "t1" },
      ]);
      client.dispose();
    });

    it("sends the pool-warming projectPath only to the owning shard on context resync", () => {
      const client = createFabricClient();
      client.setActiveProject(1, "project-a", "/projects/a");
      const shardA = projectShard("project-a");
      shardA.child.postMessage.mockClear();

      // First ready resyncs window contexts (pre-ready sends were dropped).
      shardA.child.emit("message", { type: "ready" });
      expect(messagesOfType(shardA.child, "set-active-project")).toEqual([
        {
          type: "set-active-project",
          windowId: 1,
          projectId: "project-a",
          projectPath: "/projects/a",
        },
      ]);

      // A sibling shard restarting must NOT warm its pool to project-a's path.
      client.spawn("t2", { cwd: "/b", cols: 80, rows: 24, projectId: "project-b" });
      const shardB = projectShard("project-b");
      shardB.child.postMessage.mockClear();
      shardB.child.emit("message", { type: "ready" });
      const contextsOnB = messagesOfType(shardB.child, "set-active-project");
      expect(contextsOnB).toEqual([
        { type: "set-active-project", windowId: 1, projectId: "project-a" },
      ]);
      client.dispose();
    });
  });

  describe("idle retirement", () => {
    it("retires a project shard once its last terminal exits and no window shows the project", async () => {
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });

      shardA.child.emit("message", { type: "exit", id: "t1", exitCode: 0 });
      await vi.advanceTimersByTimeAsync(fabricConfig.PTY_SHARD_IDLE_LINGER_MS + 1);

      // Retirement disposes the shard: host asked to dispose, then force-killed.
      expect(messagesOfType(shardA.child, "dispose")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(shardA.child.kill).toHaveBeenCalled();

      // A later spawn for the project gets a fresh shard.
      const forkCount = forks.length;
      client.spawn("t2", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      expect(forks.length).toBe(forkCount + 1);
      client.dispose();
    });

    it("does not retire a shard while a window still shows its project", async () => {
      const client = createFabricClient();
      client.setActiveProject(1, "project-a", "/projects/a");
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });

      await vi.advanceTimersByTimeAsync(fabricConfig.PTY_SHARD_IDLE_LINGER_MS * 3);
      expect(messagesOfType(shardA.child, "dispose")).toHaveLength(0);
      client.dispose();
    });
  });

  describe("aggregated host signals", () => {
    it("ORs host-throttled across shards and only forwards aggregate edges", () => {
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });

      const events: boolean[] = [];
      client.on("host-throttled", (payload: { isThrottled: boolean }) => {
        events.push(payload.isThrottled);
      });

      shardA.child.emit("message", { type: "host-throttled", isThrottled: true, timestamp: 1 });
      defaultShard().child.emit("message", {
        type: "host-throttled",
        isThrottled: true,
        timestamp: 2,
      });
      // Shard A releasing must not clear the aggregate while main still holds.
      shardA.child.emit("message", { type: "host-throttled", isThrottled: false, timestamp: 3 });
      defaultShard().child.emit("message", {
        type: "host-throttled",
        isThrottled: false,
        timestamp: 4,
      });

      expect(events).toEqual([true, false]);
      client.dispose();
    });

    it("ORs host-memory-warning across shards", () => {
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });

      const events: boolean[] = [];
      client.on("host-memory-warning", (payload: { isWarning: boolean }) => {
        events.push(payload.isWarning);
      });

      shardA.child.emit("message", {
        type: "host-memory-warning",
        isWarning: true,
        utilizationPercent: 80,
        timestamp: 1,
      });
      defaultShard().child.emit("message", {
        type: "host-memory-warning",
        isWarning: false,
        utilizationPercent: 10,
        timestamp: 2,
      });
      shardA.child.emit("message", {
        type: "host-memory-warning",
        isWarning: false,
        utilizationPercent: 20,
        timestamp: 3,
      });

      expect(events).toEqual([true, false]);
      client.dispose();
    });
  });

  describe("cross-shard aggregation", () => {
    it("merges memory rollups across shards", async () => {
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });

      const promise = client.getMemoryRollup();
      const defaultReq = messagesOfType(defaultShard().child, "get-memory-rollup")[0];
      const shardAReq = messagesOfType(shardA.child, "get-memory-rollup")[0];
      expect(defaultReq).toBeDefined();
      expect(shardAReq).toBeDefined();

      defaultShard().child.emit("message", {
        type: "memory-rollup",
        requestId: defaultReq.requestId,
        rollup: {
          byProject: [
            { projectId: null, terminalCount: 1, processCount: 2, memoryKb: 100, topProcesses: [] },
          ],
          totalMemoryKb: 100,
          totalProcessCount: 2,
          terminalCount: 1,
          available: true,
          sampledAt: 10,
        },
      });
      shardA.child.emit("message", {
        type: "memory-rollup",
        requestId: shardAReq.requestId,
        rollup: {
          byProject: [
            {
              projectId: "project-a",
              terminalCount: 2,
              processCount: 5,
              memoryKb: 900,
              topProcesses: [],
            },
          ],
          totalMemoryKb: 900,
          totalProcessCount: 5,
          terminalCount: 2,
          available: true,
          sampledAt: 20,
        },
      });

      const merged = await promise;
      expect(merged.totalMemoryKb).toBe(1000);
      expect(merged.totalProcessCount).toBe(7);
      expect(merged.terminalCount).toBe(3);
      expect(merged.available).toBe(true);
      expect(merged.sampledAt).toBe(20);
      expect(merged.byProject).toHaveLength(2);
      client.dispose();
    });

    it("merges flow-control snapshots with a worst-shard governor view and per-shard breakdown", async () => {
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });

      const promise = client.getFlowControlSnapshotAsync();
      const mkSnapshot = (over: Record<string, unknown>) => ({
        timestamp: 1,
        terminals: [],
        queueDepth: [],
        totalPendingBytes: 0,
        stats: { pauseCount: 0, resumeCount: 0, suspendCount: 0, forceResumeCount: 0 },
        resourceGovernor: {
          isThrottling: false,
          isWarning: false,
          activeProfile: "balanced",
          smoothedUtilizationPercent: null,
          throttleDurationMs: 0,
        },
        eventLoop: null,
        ...over,
      });
      const defaultReq = messagesOfType(defaultShard().child, "get-flow-control-snapshot")[0];
      const shardAReq = messagesOfType(shardA.child, "get-flow-control-snapshot")[0];
      defaultShard().child.emit("message", {
        type: "flow-control-snapshot",
        requestId: defaultReq.requestId,
        snapshot: mkSnapshot({
          totalPendingBytes: 10,
          eventLoop: { p99Ms: 5, maxMs: 9, utilization: 0.2 },
        }),
      });
      shardA.child.emit("message", {
        type: "flow-control-snapshot",
        requestId: shardAReq.requestId,
        snapshot: mkSnapshot({
          totalPendingBytes: 90,
          resourceGovernor: {
            isThrottling: true,
            isWarning: true,
            activeProfile: "balanced",
            smoothedUtilizationPercent: 88,
            throttleDurationMs: 1200,
          },
          eventLoop: { p99Ms: 42, maxMs: 60, utilization: 0.9 },
        }),
      });

      const merged = await promise;
      expect(merged.totalPendingBytes).toBe(100);
      expect(merged.resourceGovernor.isThrottling).toBe(true);
      expect(merged.resourceGovernor.smoothedUtilizationPercent).toBe(88);
      expect(merged.eventLoop?.p99Ms).toBe(42);
      expect(merged.shards).toHaveLength(2);
      expect(merged.shards?.map((s) => s.shardKey).sort()).toEqual(["main", "project-a"]);
      client.dispose();
    });

    it("concatenates get-all-terminals across shards", async () => {
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });

      const promise = client.getAllTerminalsAsync();
      const defaultReq = messagesOfType(defaultShard().child, "get-all-terminals")[0];
      const shardAReq = messagesOfType(shardA.child, "get-all-terminals")[0];
      defaultShard().child.emit("message", {
        type: "all-terminals",
        requestId: defaultReq.requestId,
        terminals: [{ id: "t0", cwd: "/", spawnedAt: 1 }],
      });
      shardA.child.emit("message", {
        type: "all-terminals",
        requestId: shardAReq.requestId,
        terminals: [{ id: "t1", cwd: "/a", spawnedAt: 2 }],
      });

      const all = await promise;
      expect(all.map((t) => t.id).sort()).toEqual(["t0", "t1"]);
      client.dispose();
    });
  });

  describe("fan-out control messages", () => {
    it("sends pause-all/resume-all and trim-state to every shard", () => {
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      // trim-state is an RPC now, so it fans out over ready shards (as
      // get-memory-rollup and get-all-terminals do) — a shard that cannot
      // reply yet would only contribute a timeout.
      shardA.child.emit("message", { type: "ready" });

      client.pauseAll();
      client.resumeAll();
      void client.trimState(1000, "idle-only").catch(() => {});

      for (const child of [defaultShard().child, shardA.child]) {
        expect(messagesOfType(child, "pause-all")).toHaveLength(1);
        expect(messagesOfType(child, "resume-all")).toHaveLength(1);
        const trims = messagesOfType(child, "trim-state");
        expect(trims).toHaveLength(1);
        expect(trims[0]).toEqual({
          type: "trim-state",
          targetLines: 1000,
          scope: "idle-only",
          requestId: expect.any(String),
        });
      }
      client.dispose();
    });

    it("sums trim-state counts across shards (#11674)", async () => {
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });

      const promise = client.trimState(500, "idle-only");
      const defaultReq = messagesOfType(defaultShard().child, "trim-state")[0];
      const shardAReq = messagesOfType(shardA.child, "trim-state")[0];
      defaultShard().child.emit("message", {
        type: "trim-state-result",
        requestId: defaultReq.requestId,
        result: { trimmed: 1, skipped: 2 },
      });
      shardA.child.emit("message", {
        type: "trim-state-result",
        requestId: shardAReq.requestId,
        result: { trimmed: 3, skipped: 4 },
      });

      expect(await promise).toEqual({
        trimmed: 4,
        skipped: 6,
        shardsTotal: 2,
        shardsFailed: 0,
      });
      client.dispose();
    });

    it("keeps a responding shard's counts when a sibling never answers", async () => {
      // A silent shard must surface as shardsFailed, not fold into `skipped` —
      // an incomplete fan-out read as "nothing was eligible" is the same class
      // of unfalsifiable signal #11674 is about.
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });

      const promise = client.trimState(500, "idle-only");
      const defaultReq = messagesOfType(defaultShard().child, "trim-state")[0];
      defaultShard().child.emit("message", {
        type: "trim-state-result",
        requestId: defaultReq.requestId,
        result: { trimmed: 5, skipped: 1 },
      });

      // Just past the shard broker's 5s default request deadline — advancing
      // further would drive unrelated shard timers for no added coverage.
      await vi.advanceTimersByTimeAsync(6_000);

      expect(await promise).toEqual({
        trimmed: 5,
        skipped: 1,
        shardsTotal: 2,
        shardsFailed: 1,
      });
      client.dispose();
    });

    it("counts an unreachable shard against the total instead of dropping it", async () => {
      // A shard still booting cannot be sent to, but excluding it from the
      // denominator would report a complete fan-out that never happened.
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      // Deliberately never ready.

      const promise = client.trimState(500, "idle-only");
      const defaultReq = messagesOfType(defaultShard().child, "trim-state")[0];
      defaultShard().child.emit("message", {
        type: "trim-state-result",
        requestId: defaultReq.requestId,
        result: { trimmed: 2, skipped: 0 },
      });

      expect(messagesOfType(shardA.child, "trim-state")).toHaveLength(0);
      expect(await promise).toEqual({
        trimmed: 2,
        skipped: 0,
        shardsTotal: 2,
        shardsFailed: 1,
      });
      client.dispose();
    });
  });

  describe("failure containment hardening", () => {
    it("migrates to the default shard when a project shard's fork fails, without a global host-crash", async () => {
      const client = createFabricClient();
      const hostCrash = vi.fn();
      client.on("host-crash", hostCrash);

      failNextFork = true;
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      // Fork threw synchronously; the containment defers one tick so the
      // in-flight spawn registration lands before migration replays it.
      await vi.advanceTimersByTimeAsync(0);

      expect(hostCrash).not.toHaveBeenCalled();
      expect(messagesOfType(defaultShard().child, "spawn").map((m) => m.id)).toEqual(["t1"]);

      // The project is pinned to the default shard — no refork attempts.
      const forkCount = forks.length;
      client.spawn("t2", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      expect(forks.length).toBe(forkCount);
      expect(messagesOfType(defaultShard().child, "spawn").map((m) => m.id)).toEqual(["t1", "t2"]);
      client.dispose();
    });

    it("still emits host-crash when the default shard's fork fails", () => {
      const hostCrash = vi.fn();
      failNextFork = true;
      const client = new PtyClientClass({ fabric: true });
      client.on("host-crash", hostCrash);
      // Constructor fork already failed; a manual re-fork failure emits too.
      failNextFork = true;
      client.manualRestart();
      expect(hostCrash).toHaveBeenCalledWith(-1);
      client.dispose();
    });

    it("does not broadcast host-crash-details for a project shard crash, only for the default shard", async () => {
      const client = createFabricClient();
      const crashDetails = vi.fn();
      client.on("host-crash-details", crashDetails);
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });

      shardA.child.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(crashDetails).not.toHaveBeenCalled();

      defaultShard().child.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(crashDetails).toHaveBeenCalledTimes(1);
      client.dispose();
    });

    it("marks a merged memory rollup unavailable when a shard fails to report", async () => {
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });

      const promise = client.getMemoryRollup();
      const shardAReq = messagesOfType(shardA.child, "get-memory-rollup")[0];
      shardA.child.emit("message", {
        type: "memory-rollup",
        requestId: shardAReq.requestId,
        rollup: {
          byProject: [
            {
              projectId: "project-a",
              terminalCount: 1,
              processCount: 1,
              memoryKb: 500,
              topProcesses: [],
            },
          ],
          totalMemoryKb: 500,
          totalProcessCount: 1,
          terminalCount: 1,
          available: true,
          sampledAt: 5,
        },
      });
      // The default shard never answers — its broker request times out.
      await vi.advanceTimersByTimeAsync(5_001);

      const rollup = await promise;
      expect(rollup.totalMemoryKb).toBe(500);
      expect(rollup.available).toBe(false);
      client.dispose();
    });

    it("routes graceful-kill-by-project to the owning shard", async () => {
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });

      const promise = client.gracefulKillByProject("project-a");
      const request = messagesOfType(shardA.child, "graceful-kill-by-project")[0];
      expect(request).toBeDefined();
      expect(messagesOfType(defaultShard().child, "graceful-kill-by-project")).toHaveLength(0);

      shardA.child.emit("message", {
        type: "graceful-kill-by-project-result",
        requestId: request.requestId,
        results: [{ id: "t1", agentSessionId: "sess-1" }],
      });
      await expect(promise).resolves.toEqual([{ id: "t1", agentSessionId: "sess-1" }]);
      client.dispose();
    });

    it("dispose during a pending retirement timer neither throws nor revives the shard", async () => {
      const client = createFabricClient();
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });
      shardA.child.emit("message", { type: "exit", id: "t1", exitCode: 0 });

      client.dispose();
      await vi.advanceTimersByTimeAsync(fabricConfig.PTY_SHARD_IDLE_LINGER_MS * 2);
      // Dispose already sent the shard its dispose message; the retirement
      // timer must not fire a second teardown after dispose cleared it.
      expect(messagesOfType(shardA.child, "dispose")).toHaveLength(1);
    });

    it("project switch ping-pong reuses the existing shards", () => {
      const client = createFabricClient();
      client.setActiveProject(1, "project-a", "/a");
      client.setActiveProject(1, "project-b", "/b");
      const forkCount = forks.length;
      client.setActiveProject(1, "project-a", "/a");
      client.setActiveProject(1, "project-b", "/b");
      expect(forks.length).toBe(forkCount);
      client.dispose();
    });

    it("supports deferStart with the fabric: shards fork on start() and replay owned spawns", () => {
      const client = new PtyClientClass({ fabric: true, deferStart: true });
      client.spawn("t1", { cwd: "/a", cols: 80, rows: 24, projectId: "project-a" });
      expect(forks).toHaveLength(0);

      client.start();
      expect(forks).toHaveLength(2);
      const shardA = projectShard("project-a");
      shardA.child.emit("message", { type: "ready" });
      expect(messagesOfType(shardA.child, "spawn").map((m) => m.id)).toEqual(["t1"]);
      expect(messagesOfType(defaultShard().child, "spawn")).toHaveLength(0);
      client.dispose();
    });

    it("disconnectMessagePort drops a pending port before it was ever delivered", () => {
      const client = new PtyClientClass({ fabric: true, deferStart: true });
      const port = createMockPort();
      client.connectMessagePort(7, port as never);
      client.disconnectMessagePort(7);

      client.start();
      defaultShard().child.emit("message", { type: "ready" });
      expect(messagesOfType(defaultShard().child, "connect-port")).toHaveLength(0);
      client.dispose();
    });
  });
});
