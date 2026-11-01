import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HostConnectionState,
  HostDescriptor,
  HostId,
} from "../../../../shared/types/remoteHosts.js";
import { TEST_HANDSHAKE } from "../../link/__tests__/linkTestUtils.js";
import { HostRegistry, type RemoteHostsStore } from "../HostRegistry.js";
import { HOST_MODE_OFF_REDIAL_MS, HostModeOffRedial } from "../hostModeOffRedial.js";
import { RemoteHostManager } from "../RemoteHostManager.js";
import { HostModeOffError, type LinkTransport } from "../transport.js";

function memoryStore(): RemoteHostsStore {
  let value: { hosts: HostDescriptor[] } | undefined;
  return { get: () => value, set: (_key, next) => void (value = next) };
}

let manager: RemoteHostManager | null = null;
let redial: HostModeOffRedial | null = null;

afterEach(async () => {
  redial?.dispose();
  redial = null;
  await manager?.disposeAll();
  manager = null;
  vi.useRealTimers();
});

/** A host a window shows whose Daintree isn't listening: every link to it parks. */
function setup() {
  const transport: LinkTransport = {
    async open(): Promise<never> {
      throw new HostModeOffError("Daintree isn't running in Host mode there (no host.json).");
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
  redial = new HostModeOffRedial({
    isShown: () => true,
    redial: (hostId) => redialled.push(hostId),
  });
  const published: HostConnectionState[] = [];
  const watch = redial;
  manager.onStateChange((hostId, state) => {
    published.push(state);
    watch.onConnection(hostId, state);
  });
  return { manager, hostId: host.id, published, redialled };
}

describe("RemoteHostManager disconnect", () => {
  it("publishes disconnected once the connection has stopped", async () => {
    const h = setup();
    await expect(h.manager.connect(h.hostId).whenReady(1_000)).resolves.toBe("host-mode-off");
    await h.manager.disconnect(h.hostId);
    expect(h.published.at(-1)).toEqual({ status: "disconnected" });
  });

  it("leaves a connection made while the last one stopped as the published state", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = setup();
    const first = h.manager.connect(h.hostId);
    await expect(first.whenReady(1_000)).resolves.toBe("host-mode-off");

    // The GOODBYE wait and forward release, still under way when the host is dialled again.
    let finishStop!: () => void;
    const stopping = new Promise<void>((resolve) => (finishStop = resolve));
    const stop = first.stop.bind(first);
    vi.spyOn(first, "stop").mockImplementation(async () => {
      await stop();
      await stopping;
    });
    const disconnected = h.manager.disconnect(h.hostId);
    const second = h.manager.connect(h.hostId);
    expect(second).not.toBe(first);
    await expect(second.whenReady(1_000)).resolves.toBe("host-mode-off");

    finishStop();
    await disconnected;
    const parked = h.manager.connectionState(h.hostId);
    expect(parked).toMatchObject({ status: "unreachable", hostModeOff: true });
    expect(h.published.at(-1)).toEqual(parked);

    vi.advanceTimersByTime(HOST_MODE_OFF_REDIAL_MS);
    expect(h.redialled).toEqual([h.hostId]);
  });
});
