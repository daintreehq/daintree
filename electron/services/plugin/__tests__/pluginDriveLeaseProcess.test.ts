// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import path from "path";
import type { TerminalRecord } from "../../driveLeaseTargets.js";

const { owners } = vi.hoisted(() => ({
  owners: {
    projectsForPath: (_p: string): readonly string[] | Promise<readonly string[]> => [],
  },
}));

vi.mock("electron", () => ({
  app: { getPath: (key: string) => `/mock/electron/${key}`, getVersion: () => "0.0.0" },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [], fromId: () => null },
  clipboard: {},
  shell: {},
}));

vi.mock("../../driveLeaseTargetResolvers.js", () => ({
  createLeaseTargetResolvers: () => ({
    projectsForPath: (p: string) => owners.projectsForPath(p),
    describeTerminal: (): TerminalRecord => "missing",
    projectsForOperation: () => [],
    projectsForDevPreviewPanel: () => [],
    projectsForHelpSession: () => [],
    currentProjectId: () => null,
  }),
}));

import { buildProcessApi } from "../pluginHostProcessApi.js";
import { PluginDevWorkerMainBridge } from "../PluginDevWorkerMainBridge.js";
import type { PluginHostFactoryDeps } from "../pluginHostDeps.js";
import type { ManagedProcessHandle } from "../PluginProcessManager.js";
import { killPluginProcessForHost } from "../pluginInternalApprovers.js";
import {
  _resetPluginFrontendRoutingForTesting,
  currentPluginInvocation,
  runInPluginInvocation,
  runWithEndedPluginInvocation,
  setPluginFrontendRouter,
} from "../pluginFrontendRouting.js";
import {
  _resetDriveLeaseServiceForTesting,
  type DriveLeaseService,
} from "../../DriveLeaseService.js";
import type { ClientEndpoint } from "../../../ipc/endpoint.js";
import type { DriveLeaseHolder } from "../../../../shared/types/remoteHosts.js";
import type {
  PluginPtyProcessHandle,
  PluginDuplexProcessHandle,
  PluginProcessDataChunk,
  PluginProcessHandle,
  PluginProcessMode,
  PluginProcessSpawnOptions,
} from "../../../../shared/types/plugin.js";
import type { WorktreeSnapshot } from "../../../../shared/types/workspace-host.js";

/**
 * A process a plugin started from a view works on the project it runs in, so
 * every later write, resize, kill and restart is held to that view's drive
 * lease, as `spawn` was, even on a handle the view opened while it drove
 * (#15792).
 */
const PLUGIN_ID = "lease-process-test";
const PROJECT_ROOT = path.resolve("/lease-project");

function endpoint(endpointId: string, clientId: string): ClientEndpoint {
  return {
    endpointId,
    clientId,
    projectId: "p1",
    kind: "remote-view",
    handle: -1,
    send: vi.fn(),
    request: vi.fn(),
    onClose: () => ({ dispose: () => undefined }),
    isClosed: () => false,
  };
}

const VIEW = endpoint("remote:-4", "client-b");
const OTHER = endpoint("remote:-9", "client-c");

function holder(of: ClientEndpoint): DriveLeaseHolder {
  return {
    leaseId: 1,
    endpointId: of.endpointId,
    clientId: of.clientId,
    clientName: "greg-mbp",
    isHostLocal: false,
    acquiredAt: 0,
  };
}

/** projectId → the endpoint that drives it. */
function installLeases(leases: Map<string, ClientEndpoint>): void {
  const service = {
    projectsDrivenElsewhere: (caller: Pick<ClientEndpoint, "endpointId">) => {
      const out = new Map<string, DriveLeaseHolder>();
      for (const [projectId, by] of leases) {
        if (by.endpointId !== caller.endpointId) out.set(projectId, holder(by));
      }
      return out;
    },
    dispose: () => undefined,
  };
  _resetDriveLeaseServiceForTesting(service as unknown as DriveLeaseService);
}

type FakeChild = ManagedProcessHandle & { emitData: (chunk: PluginProcessDataChunk) => void };

function fakeChild(mode: PluginProcessMode = "pty"): FakeChild {
  let onData: ((chunk: PluginProcessDataChunk) => void) | undefined;
  return {
    id: "proc-1",
    mode,
    kill: vi.fn(),
    restart: vi.fn(async () => undefined),
    onExit: () => () => undefined,
    onCrash: () => () => undefined,
    onData: (cb) => {
      onData = cb;
      return () => undefined;
    },
    write: vi.fn(),
    resize: vi.fn(),
    emitData: (chunk) => onData?.(chunk),
  };
}

function loadedPlugin(): unknown {
  return { isBuiltin: true, manifest: { capabilities: ["shell:exec"] } };
}

function setup(mode: PluginProcessMode = "pty"): {
  child: FakeChild;
  plugins: Map<string, unknown>;
  spawn: (as: ClientEndpoint | null, cwd?: string | null) => Promise<PluginProcessHandle>;
  spawnPty: (as: ClientEndpoint | null) => Promise<PluginPtyProcessHandle>;
} {
  const child = fakeChild(mode);
  const plugins = new Map<string, unknown>([[PLUGIN_ID, loadedPlugin()]]);
  const deps = {
    plugins,
    getProcessManager: () => ({ spawn: async () => child }),
  } as unknown as PluginHostFactoryDeps;
  // With no cwd a spawn runs in the active worktree, which is in the project.
  const api = buildProcessApi(deps, PLUGIN_ID, async () => [
    { path: PROJECT_ROOT, isCurrent: true } as WorktreeSnapshot,
  ]);
  /** `cwd` null spawns with none. */
  const spawn = (as: ClientEndpoint | null, cwd: string | null = PROJECT_ROOT) => {
    const run = () =>
      api.spawn("sh", { mode, ...(cwd !== null && { cwd }) } as PluginProcessSpawnOptions);
    return as === null ? run() : runInPluginInvocation(PLUGIN_ID, as, run);
  };
  const spawnPty = (as: ClientEndpoint | null) => spawn(as) as Promise<PluginPtyProcessHandle>;
  return { child, plugins, spawn, spawnPty };
}

/** A lookup that answers only once released. */
function stalledLookup(): { release: () => void } {
  let release!: () => void;
  const lookup = new Promise<void>((resolve) => (release = resolve));
  installLeases(
    new Map([
      ["p1", VIEW],
      ["p2", OTHER],
    ])
  );
  owners.projectsForPath = async (p) => {
    await lookup;
    return p.startsWith(PROJECT_ROOT) ? ["p1"] : [];
  };
  return { release };
}

const WAIT = { timeout: 5000 };

const flush = () => new Promise((resolve) => setImmediate(resolve));

function asCaller<T>(caller: ClientEndpoint, fn: () => T): T {
  return runInPluginInvocation(PLUGIN_ID, caller, fn);
}

/**
 * Wait until every operation made before it has been judged: ops on one handle
 * land in the order made, so once a background write reaches the child, every
 * earlier one has either reached it too or been dropped.
 */
async function settled(handle: PluginDuplexProcessHandle, child: ManagedProcessHandle) {
  const marker = `marker-${Math.random()}`;
  handle.write(marker);
  await vi.waitFor(() => expect(child.write).toHaveBeenCalledWith(marker), WAIT);
}

function written(child: ManagedProcessHandle): string[] {
  return vi
    .mocked(child.write)
    .mock.calls.map(([data]) => data)
    .filter((d) => !d.startsWith("marker-"));
}

describe("plugin process handles after another screen takes the project (#15792)", () => {
  beforeEach(() => {
    owners.projectsForPath = (p) => (p.startsWith(PROJECT_ROOT) ? ["p1"] : []);
    setPluginFrontendRouter({ resolve: () => ({ kind: "local" }), onChange: () => () => {} });
    installLeases(new Map([["p1", VIEW]]));
  });

  afterEach(() => {
    _resetPluginFrontendRoutingForTesting();
    _resetDriveLeaseServiceForTesting(null);
  });

  it("drops write, resize and kill and refuses restart from the view that spawned it", async () => {
    const { child, spawnPty } = setup();
    const handle = await spawnPty(VIEW);

    installLeases(new Map([["p1", OTHER]]));
    asCaller(VIEW, () => {
      handle.write("rm -rf build\r");
      handle.resize(40, 10);
      handle.kill();
    });
    const restart = asCaller(VIEW, () => handle.restart());
    await expect(restart).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    await expect(restart).rejects.toThrow(/^DRIVEN_ELSEWHERE: .*Take control first\.$/);
    await settled(handle, child);

    expect(written(child)).toEqual([]);
    expect(child.resize).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.restart).not.toHaveBeenCalled();
  });

  it("lets the view that still drives write, resize, kill and restart, in order", async () => {
    const { child, spawnPty } = setup();
    const handle = await spawnPty(VIEW);

    asCaller(VIEW, () => {
      handle.write("a");
      handle.write("b");
      handle.resize(40, 10);
    });
    handle.write("c");
    await asCaller(VIEW, () => handle.restart());
    asCaller(VIEW, () => handle.kill());
    await settled(handle, child);

    expect(written(child)).toEqual(["a", "b", "c"]);
    expect(child.resize).toHaveBeenCalledWith(40, 10);
    expect(child.restart).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("judges each operation against the lease as it stands when it arrives", async () => {
    const { child, spawnPty } = setup();
    const handle = await spawnPty(VIEW);

    asCaller(VIEW, () => handle.write("before"));
    await settled(handle, child);
    installLeases(new Map([["p1", OTHER]]));
    asCaller(VIEW, () => handle.write("after"));
    await settled(handle, child);

    expect(written(child)).toEqual(["before"]);
  });

  it("holds work the call left behind to the lease, as the caller who made the call", async () => {
    const { child, spawnPty } = setup();
    const handle = await spawnPty(VIEW);
    installLeases(new Map([["p1", OTHER]]));

    runWithEndedPluginInvocation({ pluginId: PLUGIN_ID, caller: VIEW }, () => {
      handle.write("late");
      handle.kill();
    });
    const restart = runWithEndedPluginInvocation({ pluginId: PLUGIN_ID, caller: VIEW }, () =>
      handle.restart()
    );
    await expect(restart).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    await settled(handle, child);

    expect(written(child)).toEqual([]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("leaves the plugin's own background work as it was, applied at once", async () => {
    const { child, spawnPty } = setup();
    const handle = await spawnPty(null);
    installLeases(new Map([["p1", OTHER]]));

    handle.write("bg");
    handle.resize(80, 24);
    expect(child.write).toHaveBeenCalledWith("bg");
    expect(child.resize).toHaveBeenCalledWith(80, 24);
    await handle.restart();
    handle.kill();

    expect(child.restart).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("keeps background writes behind a call's writes still being judged", async () => {
    const { child, spawnPty } = setup();
    const handle = await spawnPty(VIEW);
    judgedSlowly();

    asCaller(VIEW, () => handle.write("from-view"));
    handle.write("from-background");
    expect(child.write).not.toHaveBeenCalled();
    await settled(handle, child);

    expect(written(child)).toEqual(["from-view", "from-background"]);
  });

  it("lands a long burst of background writes queued behind a call's write", async () => {
    const { child, spawnPty } = setup();
    const handle = await spawnPty(VIEW);
    judgedSlowly();

    asCaller(VIEW, () => handle.write("from-view"));
    const burst = Array.from({ length: 50_000 }, (_, i) => String(i));
    for (const data of burst) handle.write(data);
    await settled(handle, child);

    expect(written(child)).toEqual(["from-view", ...burst]);
  });

  it("keeps going after a refusal: later operations still land, in order", async () => {
    const { child, spawnPty } = setup();
    const handle = await spawnPty(VIEW);
    judgedSlowly();
    const watcher = endpoint("remote:-2", "client-w");

    asCaller(VIEW, () => handle.write("a"));
    asCaller(watcher, () => handle.write("refused"));
    asCaller(VIEW, () => handle.write("b"));
    handle.write("c");
    await settled(handle, child);

    expect(written(child)).toEqual(["a", "b", "c"]);
  });

  it("judges an operation when its turn comes, so a takeover while it waited counts", async () => {
    const { child, spawnPty } = setup();
    const handle = await spawnPty(VIEW);
    let release!: () => void;
    const lookup = new Promise<void>((resolve) => (release = resolve));
    const leases = new Map([
      ["p1", VIEW],
      ["p2", OTHER],
    ]);
    installLeases(leases);
    // Only the first lookup stalls: a check started on arrival for the second
    // write would have answered, before the takeover, that the view drives.
    let lookups = 0;
    owners.projectsForPath = async (p) => {
      if (lookups++ === 0) await lookup;
      return p.startsWith(PROJECT_ROOT) ? ["p1"] : [];
    };

    asCaller(VIEW, () => handle.write("first"));
    asCaller(VIEW, () => handle.write("second"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    leases.set("p1", OTHER);
    release();
    await settled(handle, child);

    expect(written(child)).toEqual([]);
  });

  it("checks nothing without a lease service", async () => {
    const { child, spawnPty } = setup();
    const handle = await spawnPty(VIEW);
    _resetDriveLeaseServiceForTesting(null);

    asCaller(VIEW, () => handle.write("x"));
    await asCaller(VIEW, () => handle.restart());
    await settled(handle, child);

    expect(written(child)).toEqual(["x"]);
    expect(child.restart).toHaveBeenCalledTimes(1);
  });

  it("drops operations still waiting when the plugin unloads", async () => {
    const { child, plugins, spawnPty } = setup();
    const handle = await spawnPty(VIEW);
    judgedSlowly();

    asCaller(VIEW, () => {
      handle.write("pending");
      handle.kill();
    });
    const restart = asCaller(VIEW, () => handle.restart());
    plugins.delete(PLUGIN_ID);

    await expect(restart).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(child.write).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.restart).not.toHaveBeenCalled();
  });

  it("lets the host kill the process past the lease, settling what still waits", async () => {
    const { child, spawnPty } = setup();
    const handle = await spawnPty(VIEW);
    const { release } = stalledLookup();
    asCaller(VIEW, () => handle.write("being judged"));
    const restart = asCaller(VIEW, () => handle.restart());

    asCaller(OTHER, () => killPluginProcessForHost(handle));
    expect(child.kill).toHaveBeenCalledTimes(1);
    await expect(restart).resolves.toBeUndefined();
    release();
    handle.write("after");
    await flush();
    await flush();

    expect(child.write).not.toHaveBeenCalled();
    expect(child.restart).not.toHaveBeenCalled();
  });

  it("holds duplex and pipe handles to it too", async () => {
    const duplex = setup("duplex");
    const writable = (await duplex.spawn(VIEW)) as PluginDuplexProcessHandle;
    const pipe = setup("pipe");
    const piped = await pipe.spawn(VIEW);
    installLeases(new Map([["p1", OTHER]]));

    asCaller(VIEW, () => {
      writable.write("{}\n");
      writable.kill();
      piped.kill();
    });
    await expect(asCaller(VIEW, () => writable.restart())).rejects.toMatchObject({
      code: "DRIVEN_ELSEWHERE",
    });
    await expect(asCaller(VIEW, () => piped.restart())).rejects.toMatchObject({
      code: "DRIVEN_ELSEWHERE",
    });

    expect(duplex.child.write).not.toHaveBeenCalled();
    for (const { child } of [duplex, pipe]) {
      expect(child.kill).not.toHaveBeenCalled();
      expect(child.restart).not.toHaveBeenCalled();
    }
  });

  it("judges a process spawned with no cwd by the active worktree's project", async () => {
    const { child, spawn } = setup();
    const handle = (await spawn(VIEW, null)) as PluginPtyProcessHandle;
    installLeases(new Map([["p1", OTHER]]));

    asCaller(VIEW, () => handle.write("x"));
    await settled(handle, child);

    expect(written(child)).toEqual([]);
  });

  it("drops what waited through an unload even if the plugin is loaded again", async () => {
    const { child, plugins, spawnPty } = setup();
    const handle = await spawnPty(VIEW);
    const { release } = stalledLookup();
    asCaller(VIEW, () => handle.write("before unload"));
    const restart = asCaller(VIEW, () => handle.restart());

    plugins.delete(PLUGIN_ID);
    plugins.set(PLUGIN_ID, loadedPlugin());
    release();

    await expect(restart).resolves.toBeUndefined();
    expect(child.write).not.toHaveBeenCalled();
    expect(child.restart).not.toHaveBeenCalled();
  });

  it("applies a waiting operation as the work that made it, not as the one ahead", async () => {
    const { child, spawnPty } = setup();
    const handle = await spawnPty(VIEW);
    const seen: Array<string | null> = [];
    vi.mocked(child.restart).mockImplementation(async () => {
      seen.push(currentPluginInvocation()?.endpoint.endpointId ?? null);
    });
    judgedSlowly();

    asCaller(VIEW, () => handle.write("from-view"));
    await handle.restart();

    expect(written(child)).toEqual(["from-view"]);
    expect(seen).toEqual([null]);
  });

  it("hands a callback that isn't a function to the manager as given, for it to refuse", async () => {
    const { child, spawnPty } = setup();
    const received: unknown[] = [];
    const record = (cb: unknown) => {
      received.push(cb);
      return () => undefined;
    };
    Object.assign(child, { onData: record, onExit: record, onCrash: record });
    const handle = await spawnPty(VIEW);

    handle.onData("nope" as never);
    handle.onExit(42 as never);
    handle.onCrash(null as never);

    expect(received).toEqual(["nope", 42, null]);
  });

  it("runs output callbacks as the plugin's own work, whichever call started the child", async () => {
    const { child, spawnPty } = setup();
    const handle = await spawnPty(VIEW);
    handle.onData(({ chunk }) => handle.write(`ack ${chunk}`));
    installLeases(new Map([["p1", OTHER]]));

    // The child's streams were opened inside the view's call, so its output
    // arrives in that call's context.
    asCaller(VIEW, () => child.emitData({ stream: "data", chunk: "ready" }));
    await settled(handle, child);

    expect(written(child)).toEqual(["ack ready"]);
  });
});

/**
 * Someone else drives a second project, so a check can't be skipped, and the
 * lookup answers on a later tick: an operation from a view sits waiting.
 */
function judgedSlowly(): void {
  installLeases(
    new Map([
      ["p1", VIEW],
      ["p2", OTHER],
    ])
  );
  owners.projectsForPath = async (p) => {
    await new Promise((resolve) => setTimeout(resolve, 2));
    return p.startsWith(PROJECT_ROOT) ? ["p1"] : [];
  };
}

class FakeWorkerHost extends EventEmitter {
  sent: Array<Record<string, unknown>> = [];
  send = vi.fn((msg: Record<string, unknown>) => {
    this.sent.push(msg);
    return true;
  });
  isReady = () => true;
  off = this.removeListener;
  dispose = vi.fn();
}

/**
 * The dev worker's process operations reach the same host handle over the
 * port, and a write sent while the worker handles a view's call is that view's,
 * not the plugin's background work (#15792).
 */
describe("dev worker process operations and the drive lease (#15792)", () => {
  beforeEach(() => {
    owners.projectsForPath = (p) => (p.startsWith(PROJECT_ROOT) ? ["p1"] : []);
    setPluginFrontendRouter({ resolve: () => ({ kind: "local" }), onChange: () => () => {} });
    installLeases(new Map([["p1", VIEW]]));
  });

  afterEach(() => {
    _resetPluginFrontendRoutingForTesting();
    _resetDriveLeaseServiceForTesting(null);
  });

  async function workerWithPty(spawning: Promise<void> = Promise.resolve()) {
    const child = fakeChild();
    let spawnStarted!: () => void;
    const started = new Promise<void>((resolve) => (spawnStarted = resolve));
    const deps = {
      plugins: new Map([[PLUGIN_ID, loadedPlugin()]]),
      getProcessManager: () => ({
        spawn: async () => {
          spawnStarted();
          await spawning;
          return child;
        },
      }),
    } as unknown as PluginHostFactoryDeps;
    const host = {
      pluginId: PLUGIN_ID,
      registerHandler: vi.fn((_channel: string, _handler: unknown) => Promise.resolve()),
      process: buildProcessApi(deps, PLUGIN_ID, async () => []),
    };
    const workerHost = new FakeWorkerHost();
    const bridge = new PluginDevWorkerMainBridge({
      pluginId: PLUGIN_ID,
      host: host as never,
      workerHost: workerHost as never,
      getCapabilities: () => [],
      clearPriorRegistrations: vi.fn(),
      onActivationResult: vi.fn(),
      onTerminalFailure: vi.fn(),
      onPushRejected: vi.fn(),
    });
    const emit = (msg: Record<string, unknown>) => workerHost.emit("worker-message", msg);
    emit({
      type: "host-notify",
      method: "registerHandler",
      params: { channel: "go", hasSchema: false },
    });
    await flush();
    const handler = host.registerHandler.mock.calls[0][1] as (...a: unknown[]) => unknown;
    /** Start a frontend invocation from `caller` and return its id. */
    const invokeAs = async (caller: ClientEndpoint) => {
      const before = workerHost.sent.filter((m) => m.type === "invoke").length;
      // Rejected when the bridge goes away, which one test makes it do.
      void Promise.resolve(runInPluginInvocation(PLUGIN_ID, caller, () => handler({}, {}))).catch(
        () => undefined
      );
      await flush();
      return workerHost.sent.filter((m) => m.type === "invoke")[before].requestId as string;
    };
    const call = async (requestId: string, method: string, params: unknown, id?: string) => {
      emit({ type: "host-call", requestId, method, params, invocationId: id });
      const answer = () =>
        workerHost.sent.find((m) => m.type === "host-result" && m.requestId === requestId);
      await vi.waitFor(() => expect(answer()).toBeDefined(), WAIT);
      return answer();
    };
    const notify = (method: string, params: unknown, id?: string) =>
      emit({
        type: "host-notify",
        method,
        params,
        ...(id !== undefined && { invocationId: id }),
      });
    const invocationId = await invokeAs(VIEW);
    const spawnParams = { command: "sh", options: { mode: "pty", cwd: PROJECT_ROOT } };
    const spawned = call("spawn", "process.spawn", spawnParams, invocationId);
    const processId = "proc-1";
    /** A background write, landing only once everything before it was judged. */
    const settledAll = async () => {
      const marker = `marker-${Math.random()}`;
      notify("process.write", { processId, data: marker });
      await vi.waitFor(() => expect(child.write).toHaveBeenCalledWith(marker), WAIT);
    };
    const settle = (requestId: string) =>
      emit({ type: "invoke-result", requestId, ok: true, result: null });
    return {
      child,
      bridge,
      started,
      processId,
      invocationId,
      spawned,
      call,
      emit,
      notify,
      settledAll,
      settle,
    };
  }

  /** A worker whose spawn has answered. */
  async function workerWithLivePty() {
    const worker = await workerWithPty();
    expect(await worker.spawned).toMatchObject({ ok: true, result: { id: "proc-1" } });
    return worker;
  }

  it("judges a write, resize and kill sent inside the view's call as that view's", async () => {
    const { child, processId, invocationId, call, notify, settledAll } = await workerWithLivePty();
    installLeases(new Map([["p1", OTHER]]));

    notify("process.write", { processId, data: "typed\r" }, invocationId);
    notify("process.resize", { processId, cols: 40, rows: 10 }, invocationId);
    notify("process.kill", { processId }, invocationId);
    const restart = await call("restart", "process.restart", { processId }, invocationId);
    await settledAll();

    expect(restart).toMatchObject({ ok: false, errorFields: { code: "DRIVEN_ELSEWHERE" } });
    expect(written(child)).toEqual([]);
    expect(child.resize).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.restart).not.toHaveBeenCalled();
  });

  it("holds work sent after the call returned to the caller who made it", async () => {
    const { child, processId, invocationId, notify, settledAll, settle } =
      await workerWithLivePty();
    settle(invocationId);
    installLeases(new Map([["p1", OTHER]]));

    notify("process.write", { processId, data: "late" }, invocationId);
    await settledAll();

    expect(written(child)).toEqual([]);
  });

  it("lets work sent after the call returned through while its caller still drives", async () => {
    const { child, processId, invocationId, notify, settledAll, settle } =
      await workerWithLivePty();
    settle(invocationId);

    notify("process.write", { processId, data: "late" }, invocationId);
    await settledAll();

    expect(written(child)).toEqual(["late"]);
  });

  it("kills a spawn the worker gave up on, even after its caller lost the project", async () => {
    let finishSpawn!: () => void;
    const { child, emit, spawned, started } = await workerWithPty(
      new Promise<void>((resolve) => (finishSpawn = resolve))
    );
    // Past spawn's own lease checks, with the child being started.
    await started;
    emit({ type: "host-cancel", requestId: "spawn" });
    installLeases(new Map([["p1", OTHER]]));
    finishSpawn();
    await spawned;

    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("kills the worker's processes when it goes away, without waiting on a check", async () => {
    const { child, bridge, processId, invocationId, notify } = await workerWithLivePty();
    const { release } = stalledLookup();
    notify("process.write", { processId, data: "being judged" }, invocationId);

    bridge.dispose();
    expect(child.kill).toHaveBeenCalledTimes(1);
    release();
    await flush();
    await flush();

    expect(child.write).not.toHaveBeenCalled();
  });

  it("lets the view that drives, and background work, through", async () => {
    const { child, processId, invocationId, call, notify, settledAll } = await workerWithLivePty();

    notify("process.write", { processId, data: "a" }, invocationId);
    notify("process.write", { processId, data: "b" });
    notify("process.resize", { processId, cols: 40, rows: 10 }, invocationId);
    const restart = await call("restart", "process.restart", { processId }, invocationId);
    await settledAll();

    expect(restart).toMatchObject({ ok: true });
    expect(written(child)).toEqual(["a", "b"]);
    expect(child.resize).toHaveBeenCalledWith(40, 10);
    expect(child.restart).toHaveBeenCalledTimes(1);
  });

  it("leaves operations with no invocation as background after a takeover", async () => {
    const { child, processId, notify, settledAll } = await workerWithLivePty();
    installLeases(new Map([["p1", OTHER]]));

    notify("process.write", { processId, data: "bg" });
    notify("process.kill", { processId });
    await settledAll();

    expect(written(child)).toEqual(["bg"]);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
