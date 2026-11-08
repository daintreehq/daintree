import { afterEach, describe, expect, it } from "vitest";
import type { HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { TEST_HANDSHAKE, waitFor } from "../../link/__tests__/linkTestUtils.js";
import { HostRegistry, type RemoteHostsStore } from "../HostRegistry.js";
import { RemoteHostManager } from "../RemoteHostManager.js";
import { TransportError, type LinkTransport } from "../transport.js";

function memoryStore(): RemoteHostsStore {
  let value: { hosts: HostDescriptor[] } | undefined;
  return { get: () => value, set: (_key, next) => void (value = next) };
}

/** A host that never answers, counting its dials. */
function unreachable(): LinkTransport & { opens: number } {
  const transport = {
    opens: 0,
    async open(): Promise<never> {
      transport.opens++;
      throw new TransportError("unreachable", "Network is unreachable");
    },
  };
  return transport;
}

let manager: RemoteHostManager | null = null;

afterEach(async () => {
  await manager?.disposeAll();
  manager = null;
});

function setup() {
  let now = 0;
  const store = memoryStore();
  const registry = new HostRegistry(store);
  const studio = registry.add({ name: "studio", connection: { kind: "ssh", target: "studio" } });
  const lab = registry.add({ name: "lab", connection: { kind: "ssh", target: "lab" } });
  // Only Windows adds WSL hosts; a stored one stands in for it here.
  const ubuntu: HostDescriptor = {
    ...lab,
    id: "host-ubuntu",
    name: "ubuntu",
    connection: { kind: "wsl", distro: "Ubuntu" },
  };
  store.set("remoteHosts", { hosts: [...registry.list(), ubuntu] });
  const transports = new Map<string, ReturnType<typeof unreachable>>();
  const watch = { starts: 0, stops: 0, onChange: null as (() => void) | null };
  manager = new RemoteHostManager({
    registry,
    createTransport: (descriptor) => {
      const transport = unreachable();
      transports.set(descriptor.id, transport);
      return transport;
    },
    handshake: () => TEST_HANDSHAKE,
    client: { clientId: "c", clientName: "mbp", platform: "darwin" },
    views: { send: () => true, watch: () => () => {}, resync: () => {} },
    backoff: { initialMs: 60_000, maxMs: 60_000, jitter: 0 },
    now: () => now,
    idleReleaseMs: 0,
    watchNetwork: (onChange) => {
      watch.starts++;
      watch.onChange = onChange;
      return () => {
        watch.stops++;
        watch.onChange = null;
      };
    },
  });
  const unreachableState = (hostId: string) =>
    manager!.connectionState(hostId).status === "unreachable";
  return {
    manager,
    watch,
    studio: studio.id,
    lab: lab.id,
    ubuntu: ubuntu.id,
    opens: (hostId: string) => transports.get(hostId)?.opens ?? 0,
    async waitingOn(...hostIds: string[]) {
      await waitFor(() => hostIds.every(unreachableState));
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("RemoteHostManager network watch (#16386)", () => {
  it("watches the network only while an ssh host's connection is wanted", async () => {
    const h = setup();
    expect(h.watch.starts).toBe(0);

    // A WSL link runs over a local process: nothing to watch for it.
    h.manager.connect(h.ubuntu);
    expect(h.watch.starts).toBe(0);

    h.manager.connect(h.studio);
    h.manager.connect(h.lab);
    expect(h.watch).toMatchObject({ starts: 1, stops: 0 });

    await h.manager.disconnect(h.studio);
    expect(h.watch).toMatchObject({ starts: 1, stops: 0 });
    await h.manager.disconnect(h.lab);
    expect(h.watch).toMatchObject({ starts: 1, stops: 1 });

    h.manager.connect(h.lab);
    expect(h.watch).toMatchObject({ starts: 2, stops: 1 });
    await h.manager.disposeAll();
    expect(h.watch).toMatchObject({ starts: 2, stops: 2 });
  });

  it("stops watching as soon as the last ssh host is let go, and again when one is dialled during the stop", async () => {
    const h = setup();
    h.manager.connect(h.studio);
    const stopping = h.manager.disconnect(h.studio);
    expect(h.watch.stops).toBe(1);
    h.manager.connect(h.studio);
    await stopping;
    expect(h.watch).toMatchObject({ starts: 2, stops: 1 });
  });

  it("hands a network change to every ssh link and a focused window to its own host's", async () => {
    const h = setup();
    h.manager.connect(h.studio);
    h.manager.connect(h.lab);
    h.manager.connect(h.ubuntu);
    await h.waitingOn(h.studio, h.lab, h.ubuntu);
    h.advance(5_000);

    h.watch.onChange!();
    await waitFor(() => h.opens(h.studio) === 2 && h.opens(h.lab) === 2);
    await h.waitingOn(h.studio, h.lab);
    expect(h.opens(h.ubuntu)).toBe(1);

    h.advance(5_000);
    h.manager.hostForegrounded(h.ubuntu);
    await waitFor(() => h.opens(h.ubuntu) === 2);
    expect(h.opens(h.studio)).toBe(2);
    expect(h.opens(h.lab)).toBe(2);
  });

  it("never dials a host nothing asked for when its window is focused", async () => {
    const h = setup();
    h.manager.connect(h.studio);
    await h.waitingOn(h.studio);
    h.manager.hostForegrounded(h.lab);
    expect(h.manager.get(h.lab)).toBeUndefined();
    expect(h.manager.connectionState(h.lab)).toEqual({ status: "disconnected" });
  });
});
