import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, on: () => undefined },
  ipcMain: {
    handle: () => undefined,
    handleOnce: () => undefined,
    removeHandler: () => undefined,
    on: () => undefined,
    removeListener: () => undefined,
    removeAllListeners: () => undefined,
    off: () => undefined,
  },
  session: { defaultSession: {}, fromPartition: () => ({}) },
}));

vi.mock("../../../services/TelemetryService.js", () => ({
  getCurrentCorrelationId: vi.fn(() => "corr-1"),
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getProjectForWebContents: () => null,
  getAppWebContents: vi.fn(),
  getAllAppWebContents: vi.fn(() => []),
  getWebContentsForProject: vi.fn(() => []),
  hasRegisteredProjectViews: vi.fn(() => false),
  isCachedViewWebContents: vi.fn(() => false),
}));

import type { CanopyHostEvent } from "../../../../shared/types/ipc/canopyHost.js";
import type { HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { wrapError, wrapSuccess } from "../../../../shared/utils/ipcErrorSerialization.js";
import { getIpcDispatcher } from "../../../ipc/dispatcher.js";
import { getEndpointRegistry } from "../../../ipc/endpointRegistry.js";
import type { IpcContext } from "../../../ipc/types.js";
import { AppError } from "../../../utils/errorTypes.js";
import { HostRegistry, type RemoteHostsStore } from "../../client/HostRegistry.js";
import { RemoteHostManager } from "../../client/RemoteHostManager.js";
import { createDirectTransport } from "../../client/transport.js";
import { HostServer } from "../../host/HostServer.js";
import { hostSocketLocation } from "../../host/hostSocketPath.js";
import { SessionHost } from "../../host/SessionHost.js";
import {
  TEST_HANDSHAKE,
  makeTempDir,
  removeTempDir,
  waitFor,
} from "../../link/__tests__/linkTestUtils.js";
import {
  enableCanopyOnHosts,
  type BulkTransport,
} from "../../../../shared/utils/canopyBulkEnable.js";
import type { CanopyMode } from "../../../../shared/types/ipc/canopy.js";
import { CanopyHostsClient } from "../client.js";
import { installCanopyHostWith } from "../host.js";
import { CanopyViewers } from "../viewer.js";
import { Lane } from "../../link/frames.js";
import { InteractiveKind } from "../../link/messages.js";
import { LinkSession } from "../../link/session.js";

const VIEW = 21;
const CHANNEL = "canopy:get-snapshot";

function memoryStore(): RemoteHostsStore {
  let value: { hosts: HostDescriptor[] } | undefined;
  return { get: () => value, set: (_key, next) => void (value = next) };
}

function viewersOnDispatcher(): CanopyViewers {
  return new CanopyViewers({
    source: { observeCanopy: () => () => {}, observeFleet: () => null },
    invoke: (invocation, channel, args) =>
      getIpcDispatcher().invokeForEndpoint(invocation, channel, args),
  });
}

const cleanups: Array<() => unknown> = [];

beforeEach(() => {
  getIpcDispatcher().setInvokeEnveloper(async (_channel, _args, call) => {
    try {
      return wrapSuccess(await call());
    } catch (error) {
      return wrapError(error);
    }
  });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  getIpcDispatcher().setInvokeEnveloper(null);
});

/**
 * One handler stands in for Canopy's: it answers with who called and pushes
 * a snapshot to the caller's endpoint, as `canopy:set-active` does.
 */
function registerFakeCanopy() {
  const calls: Array<{ handle: number; kind: string; clientId: string }> = [];
  const closed: number[] = [];
  const off = getIpcDispatcher().registerInvoke(CHANNEL, (ctx) => {
    const { endpoint, client } = ctx as IpcContext;
    calls.push({ handle: endpoint.handle, kind: endpoint.kind, clientId: client.clientId });
    endpoint.onClose(() => closed.push(endpoint.handle));
    endpoint.send({
      type: "event",
      channel: "canopy:snapshot-updated",
      args: [{ n: calls.length }],
    });
    // Never reaches a viewer: only Canopy's own pushes do.
    endpoint.send({ type: "event", channel: "terminal:data", args: ["x"] });
    return { handle: endpoint.handle };
  });
  cleanups.push(off);
  return { calls, closed };
}

const clock = { now: 0 };

async function startHost() {
  const dir = await makeTempDir();
  const location = hostSocketLocation({ platform: "darwin", userDataDir: dir });
  const server = new HostServer({
    location,
    handshake: TEST_HANDSHAKE,
    hostName: "studio",
    resumeGraceMs: 150,
    session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
  });
  await server.listen();
  const sessionHost = new SessionHost(server, {
    dispatcher: getIpcDispatcher(),
    registry: getEndpointRegistry(),
    setAttachedFrontendCount: () => {},
    describeProject: () => null,
    listProjects: () => [],
  });
  const viewers = viewersOnDispatcher();
  const uninstall = installCanopyHostWith(server, viewers);

  const registry = new HostRegistry(memoryStore());
  const host = registry.add({ name: "studio", connection: { kind: "ssh", target: "studio" } });
  const transport = createDirectTransport({ socketPath: location.socketPath, token: server.token });
  const manager = new RemoteHostManager({
    registry,
    createTransport: () => transport,
    handshake: () => TEST_HANDSHAKE,
    client: { clientId: "client-1", clientName: "greg-mbp", platform: "darwin" },
    views: { send: () => true, watch: () => () => {}, resync: () => {}, hostOf: () => null },
    session: { pingIntervalMs: 0, idleTimeoutMs: 0 },
    backoff: { initialMs: 20, maxMs: 40, jitter: 0 },
    now: () => clock.now,
    idleReleaseMs: 1_000,
  });
  cleanups.push(async () => {
    await manager.disposeAll();
    uninstall();
    sessionHost.dispose();
    await server.close();
    await removeTempDir(dir);
  });
  return { manager, registry, hostId: host.id, viewers };
}

function shellClient(
  h: Awaited<ReturnType<typeof startHost>>,
  hostForView: (webContentsId: number) => string | null
) {
  const sent: Array<{ webContentsId: number; event: CanopyHostEvent }> = [];
  const gone = new Map<number, () => void>();
  const client = new CanopyHostsClient({
    manager: h.manager,
    registry: h.registry,
    hostForView,
    local: viewersOnDispatcher(),
    localClient: { clientId: "local", clientName: "mbp", platform: "darwin", kind: "local" },
    send: (webContentsId, event) => {
      sent.push({ webContentsId, event });
      return true;
    },
    watchView: (webContentsId, onGone) => {
      gone.set(webContentsId, onGone);
      return () => gone.delete(webContentsId);
    },
  });
  client.start();
  cleanups.push(() => client.dispose());
  return { client, sent, gone };
}

describe("Canopy on a host the view isn't bound to", () => {
  it("reaches a remote host's Canopy with no endpoint bound, and tags its pushes", async () => {
    const fake = registerFakeCanopy();
    const h = await startHost();
    const shell = shellClient(h, () => null);
    h.manager.connect(h.hostId);
    await waitFor(() => h.manager.connectionState(h.hostId).status === "connected");

    const answer = (await shell.client.invoke(VIEW, h.hostId, CHANNEL, [])) as {
      handle: number;
    };

    expect(fake.calls).toEqual([
      { handle: answer.handle, kind: "remote-view", clientId: "client-1" },
    ]);
    await waitFor(() => shell.sent.length > 0);
    expect(shell.sent).toEqual([
      {
        webContentsId: VIEW,
        event: { kind: "canopy-snapshot", hostId: h.hostId, snapshot: { n: 1 } },
      },
    ]);
    // The view is no endpoint of the host's: nothing was opened for it.
    expect(h.manager.get(h.hostId)?.boundViews()).toEqual([]);

    // The same viewer serves its next call; releasing ends its panel on the host.
    await shell.client.invoke(VIEW, h.hostId, CHANNEL, []);
    expect(fake.calls[1].handle).toBe(answer.handle);
    shell.client.release(VIEW, h.hostId);
    await waitFor(() => fake.closed.includes(answer.handle));
  });

  it("keeps the link up while a panel reads the host, and releases it once none does", async () => {
    registerFakeCanopy();
    const h = await startHost();
    const shell = shellClient(h, () => null);
    h.manager.connect(h.hostId);
    await waitFor(() => h.manager.connectionState(h.hostId).status === "connected");
    await shell.client.invoke(VIEW, h.hostId, CHANNEL, []);

    clock.now += 60_000;
    h.manager.sweepIdle();
    expect(h.manager.get(h.hostId)).toBeDefined();

    // The view reloading ends the panel it showed; the idle window counts from then.
    shell.gone.get(VIEW)?.();
    h.manager.sweepIdle();
    expect(h.manager.get(h.hostId)).toBeDefined();
    clock.now += 1_000;
    h.manager.sweepIdle();
    expect(h.manager.get(h.hostId)).toBeUndefined();
  });

  it("holds a panel reading This Mac to the drive lease, as any caller from a link", async () => {
    const h = await startHost();
    const shell = shellClient(h, () => h.hostId);
    const trashed = vi.fn();
    cleanups.push(getIpcDispatcher().registerInvoke("canopy:trash", trashed));
    const gated: string[] = [];
    cleanups.push(
      getIpcDispatcher().setLeaseGate((channel, caller) => {
        gated.push(`${channel}:${caller.kind}`);
        return new AppError({ code: "DRIVEN_ELSEWHERE", message: "driven elsewhere" });
      })
    );

    await expect(
      shell.client.invoke(VIEW, "local", "canopy:trash", ["run-1", { spawnedAt: 1 }])
    ).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    expect(gated).toEqual(["canopy:trash:link"]);
    expect(trashed).not.toHaveBeenCalled();
  });

  it("serves This Mac's Canopy to a view bound to a remote host", async () => {
    const fake = registerFakeCanopy();
    const h = await startHost();
    const shell = shellClient(h, () => h.hostId);

    const answer = (await shell.client.invoke(VIEW, "local", CHANNEL, [])) as { handle: number };

    expect(fake.calls).toEqual([{ handle: answer.handle, kind: "remote-view", clientId: "local" }]);
    expect(shell.sent).toEqual([
      {
        webContentsId: VIEW,
        event: { kind: "canopy-snapshot", hostId: "local", snapshot: { n: 1 } },
      },
    ]);
    shell.client.release(VIEW, "local");
    expect(fake.closed).toEqual([answer.handle]);
  });

  it("refuses the view's own host, which its ordinary Canopy route reads", async () => {
    const fake = registerFakeCanopy();
    const h = await startHost();
    const remote = shellClient(h, () => h.hostId);
    const local = shellClient(h, () => null);

    await expect(remote.client.invoke(VIEW, h.hostId, CHANNEL, [])).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(local.client.invoke(VIEW, "local", CHANNEL, [])).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(fake.calls).toEqual([]);
  });

  it("carries the watched terminal's stream across the link on the interactive lane", async () => {
    const chunk = { kind: "data", watchId: 4, runId: "run-1", data: "hi", streamEnd: 2 };
    const off = getIpcDispatcher().registerInvoke("canopy:watch-terminal", (ctx) => {
      const { endpoint } = ctx as IpcContext;
      endpoint.send({ type: "event", channel: "canopy:terminal-data", args: [chunk] });
      return { watchId: 4, snapshot: null };
    });
    cleanups.push(off);
    const post = vi.spyOn(LinkSession.prototype, "post");
    cleanups.push(() => post.mockRestore());
    const h = await startHost();
    const shell = shellClient(h, () => null);
    h.manager.connect(h.hostId);
    await waitFor(() => h.manager.connectionState(h.hostId).status === "connected");

    await shell.client.invoke(VIEW, h.hostId, "canopy:watch-terminal", ["run-1", { spawnedAt: 1 }]);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ lane: Lane.INTERACTIVE, kind: InteractiveKind.CANOPY_TERMINAL })
    );

    await waitFor(() => shell.sent.some(({ event }) => event.kind === "terminal-data"));
    expect(shell.sent).toContainEqual({
      webContentsId: VIEW,
      event: { kind: "terminal-data", hostId: h.hostId, chunk },
    });
  });

  describe("turning Canopy on across hosts", () => {
    /** A host whose mode behaves as the real handler's: guarded by revision and epoch. */
    function registerModeHost(initial: CanopyMode, epoch = "boot-1") {
      const state = { mode: initial, revision: 0, epoch, sets: [] as unknown[][] };
      const snapshot = () => ({
        mode: state.mode,
        modeRevision: state.revision,
        hostEpoch: state.epoch,
        activated: state.mode === "on",
      });
      const closed: number[] = [];
      cleanups.push(
        getIpcDispatcher().registerInvoke(CHANNEL, (ctx) => {
          const { endpoint } = ctx as IpcContext;
          endpoint.onClose(() => closed.push(endpoint.handle));
          return snapshot();
        }),
        getIpcDispatcher().registerInvoke("canopy:set-mode", (_ctx, ...args) => {
          const [mode, revision, hostEpoch] = args as [CanopyMode, number, string];
          state.sets.push([mode, revision, hostEpoch]);
          if (revision !== state.revision || hostEpoch !== state.epoch) return snapshot();
          if (mode === "on" && state.mode === "hidden") {
            throw new AppError({ code: "PERMISSION", message: "Canopy is hidden" });
          }
          if (mode !== state.mode) state.revision += 1;
          state.mode = mode;
          return snapshot();
        })
      );
      return { state, closed };
    }

    function bulkTransport(
      h: Awaited<ReturnType<typeof startHost>>,
      shell: ReturnType<typeof shellClient>
    ): BulkTransport {
      return {
        getSnapshot: () => shell.client.invoke(VIEW, h.hostId, CHANNEL, []) as never,
        setMode: (mode, revision, epoch) =>
          shell.client.invoke(VIEW, h.hostId, "canopy:set-mode", [mode, revision, epoch]) as never,
        connect: async () => {
          h.manager.connect(h.hostId);
          await waitFor(() => h.manager.connectionState(h.hostId).status === "connected");
          return true;
        },
        release: () => shell.client.release(VIEW, h.hostId),
      };
    }

    it("dials a saved, disconnected host and takes a hidden one through unset to on", async () => {
      const host = registerModeHost("hidden");
      const h = await startHost();
      const shell = shellClient(h, () => null);
      expect(h.manager.get(h.hostId)).toBeUndefined();

      const [result] = await enableCanopyOnHosts([{ hostId: h.hostId, name: "studio" }], {
        transportFor: () => bulkTransport(h, shell),
      });

      expect(result).toMatchObject({ outcome: "enabled" });
      expect(host.state.sets).toEqual([
        ["unset", 0, "boot-1"],
        ["on", 1, "boot-1"],
      ]);
      expect(host.state.mode).toBe("on");
      // Nothing the run opened is left: no viewer on the host, no panel reading it.
      await waitFor(() => host.closed.length === 1);
      expect(shell.client.isRead(h.hostId)).toBe(false);
      expect(h.manager.get(h.hostId)?.boundViews()).toEqual([]);
      clock.now += 1_000;
      h.manager.sweepIdle();
      expect(h.manager.get(h.hostId)).toBeUndefined();
    });

    it("leaves an already-on host untouched and never writes over a restarted one", async () => {
      const on = registerModeHost("on");
      const h = await startHost();
      const shell = shellClient(h, () => null);
      h.manager.connect(h.hostId);
      await waitFor(() => h.manager.connectionState(h.hostId).status === "connected");

      const run = () =>
        enableCanopyOnHosts([{ hostId: h.hostId, name: "studio" }], {
          transportFor: () => bulkTransport(h, shell),
        });
      expect((await run())[0]).toMatchObject({ outcome: "already-enabled" });
      expect(on.state.sets).toEqual([]);

      // The host restarted between the read and the write: same revision, new epoch.
      on.state.mode = "unset";
      const transport = bulkTransport(h, shell);
      const [result] = await enableCanopyOnHosts([{ hostId: h.hostId, name: "studio" }], {
        transportFor: () => ({
          ...transport,
          setMode: (mode, revision, epoch) => {
            on.state.epoch = "boot-2";
            return transport.setMode(mode, revision, epoch);
          },
        }),
      });
      expect(result).toMatchObject({ outcome: "conflicted" });
      expect(on.state.mode).toBe("unset");
    });
  });
});
