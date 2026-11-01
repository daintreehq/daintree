import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HostConnectionState,
  HostDescriptor,
  HostId,
} from "../../../../shared/types/remoteHosts.js";
import { TEST_HANDSHAKE } from "../../link/__tests__/linkTestUtils.js";
import { HostRegistry, type RemoteHostsStore } from "../HostRegistry.js";
import { HOST_MODE_OFF_REDIAL_MS, HostModeOffRedial } from "../hostModeOffRedial.js";
import { RemoteHostManager, type HostConnection } from "../RemoteHostManager.js";
import { HostModeOffError, TransportError, type LinkTransport } from "../transport.js";

function memoryStore(): RemoteHostsStore {
  let value: { hosts: HostDescriptor[] } | undefined;
  return { get: () => value, set: (_key, next) => void (value = next) };
}

let manager: RemoteHostManager | null = null;
let redial: HostModeOffRedial | null = null;
const pending: Array<() => void> = [];

afterEach(async () => {
  // A connection already out of the map is beyond disposeAll: let its stop finish.
  for (const finish of pending.splice(0)) finish();
  redial?.dispose();
  redial = null;
  await manager?.disposeAll();
  manager = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A host a window shows: its Daintree isn't listening, or (`hang`) a dial never settles. */
function setup() {
  const dial = { hang: false };
  const transport: LinkTransport = {
    open(signal): Promise<never> {
      if (!dial.hang) {
        return Promise.reject(
          new HostModeOffError("Daintree isn't running in Host mode there (no host.json).")
        );
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new TransportError("unreachable", "aborted"))
        );
      });
    },
  };
  const registry = new HostRegistry(memoryStore());
  const host = registry.add({ name: "studio", connection: { kind: "ssh", target: "studio" } });
  manager = new RemoteHostManager({
    registry,
    createTransport: () => transport,
    handshake: () => TEST_HANDSHAKE,
    client: { clientId: "c", clientName: "mbp", platform: "darwin" },
    views: { send: () => true, watch: () => () => {}, resync: () => {} },
    backoff: { initialMs: 1, maxMs: 1, jitter: 0 },
    idleReleaseMs: 0,
  });
  const redialled: HostId[] = [];
  const watch = new HostModeOffRedial({
    isShown: () => true,
    redial: (hostId) => redialled.push(hostId),
  });
  redial = watch;
  const published: HostConnectionState[] = [];
  manager.onStateChange((hostId, state) => {
    published.push(state);
    watch.onConnection(hostId, state);
  });
  return { manager, hostId: host.id, dial, published, redialled };
}

/**
 * Hold `stop()` past the link closing, as the GOODBYE wait and forward release
 * do. `closed` settles once the connection itself has stopped and the hold begins.
 */
function holdStop(connection: HostConnection): { closed: Promise<void>; finish: () => void } {
  let finish!: () => void;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => (finish = resolve));
  const closed = new Promise<void>((resolve) => (reached = resolve));
  const stop = connection.stop.bind(connection);
  vi.spyOn(connection, "stop").mockImplementation(async () => {
    await stop();
    reached();
    await held;
  });
  pending.push(finish);
  return { closed, finish };
}

function disconnectedCount(states: HostConnectionState[]): number {
  return states.filter((state) => state.status === "disconnected").length;
}

describe("RemoteHostManager disconnect", () => {
  it("publishes disconnected once, after the connection has stopped", async () => {
    const h = setup();
    const connection = h.manager.connect(h.hostId);
    await expect(connection.whenReady(1_000)).resolves.toBe("host-mode-off");
    const stopping = holdStop(connection);

    const disconnected = h.manager.disconnect(h.hostId);
    await stopping.closed;
    expect(disconnectedCount(h.published)).toBe(0);

    stopping.finish();
    await disconnected;
    expect(h.published.at(-1)).toEqual({ status: "disconnected" });
    expect(disconnectedCount(h.published)).toBe(1);
  });

  it("leaves a parked connection made while the last one stopped as the published state", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = setup();
    const first = h.manager.connect(h.hostId);
    await expect(first.whenReady(1_000)).resolves.toBe("host-mode-off");
    const { finish: finishStop } = holdStop(first);

    const disconnected = h.manager.disconnect(h.hostId);
    const second = h.manager.connect(h.hostId);
    expect(second).not.toBe(first);
    await expect(second.whenReady(1_000)).resolves.toBe("host-mode-off");
    const before = h.published.length;

    finishStop();
    await disconnected;
    const parked = h.manager.connectionState(h.hostId);
    expect(parked).toMatchObject({ status: "unreachable", hostModeOff: true });
    expect(h.published.length).toBe(before);
    expect(h.published.at(-1)).toEqual(parked);

    // The watch the new connection's park armed is still there to dial it again.
    vi.advanceTimersByTime(HOST_MODE_OFF_REDIAL_MS);
    expect(h.redialled).toEqual([h.hostId]);
  });

  it("leaves a connection still dialling as the published state", async () => {
    const h = setup();
    const first = h.manager.connect(h.hostId);
    await expect(first.whenReady(1_000)).resolves.toBe("host-mode-off");
    const { finish: finishStop } = holdStop(first);

    const disconnected = h.manager.disconnect(h.hostId);
    h.dial.hang = true;
    h.manager.connect(h.hostId);
    const dialling = h.manager.connectionState(h.hostId);
    expect(dialling).toMatchObject({ status: "connecting" });
    expect(h.published.at(-1)).toEqual(dialling);

    finishStop();
    await disconnected;
    expect(h.published.at(-1)).toEqual(dialling);
    expect(h.manager.connectionState(h.hostId)).toEqual(dialling);
  });
});
