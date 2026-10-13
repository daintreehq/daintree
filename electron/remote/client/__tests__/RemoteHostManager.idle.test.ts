import { afterEach, describe, expect, it } from "vitest";
import type { HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { TEST_HANDSHAKE, waitFor } from "../../link/__tests__/linkTestUtils.js";
import { HostRegistry, type RemoteHostsStore } from "../HostRegistry.js";
import { RemoteHostManager } from "../RemoteHostManager.js";
import { SshAccessError, TransportError, type LinkTransport } from "../transport.js";

function memoryStore(): RemoteHostsStore {
  let value: { hosts: HostDescriptor[] } | undefined;
  return { get: () => value, set: (_key, next) => void (value = next) };
}

/** A host that never answers: the link keeps trying, which is all these tests need. */
const unreachable: LinkTransport = {
  async open() {
    throw new TransportError("unreachable", "Connection timed out");
  },
};

let manager: RemoteHostManager | null = null;

afterEach(async () => {
  await manager?.disposeAll();
  manager = null;
});

function setup(transport: LinkTransport = unreachable) {
  let now = 0;
  const registry = new HostRegistry(memoryStore());
  const host = registry.add({ name: "studio", connection: { kind: "ssh", target: "studio" } });
  manager = new RemoteHostManager({
    registry,
    createTransport: () => transport,
    handshake: () => TEST_HANDSHAKE,
    client: { clientId: "c", clientName: "mbp", platform: "darwin" },
    views: { send: () => true, watch: () => () => {}, resync: () => {} },
    backoff: { initialMs: 60_000, maxMs: 60_000, jitter: 0 },
    now: () => now,
    idleReleaseMs: 1_000,
  });
  return {
    manager,
    registry,
    hostId: host.id,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("RemoteHostManager idle release", () => {
  it("closes a connection nothing has used for the release window", async () => {
    const h = setup();
    h.manager.connect(h.hostId);
    h.advance(999);
    h.manager.sweepIdle();
    expect(h.manager.get(h.hostId)).toBeDefined();

    h.advance(1);
    h.manager.sweepIdle();
    expect(h.manager.get(h.hostId)).toBeUndefined();
    expect(h.manager.connectionState(h.hostId)).toEqual({ status: "disconnected" });
  });

  it("keeps a held connection however long the work takes", () => {
    const h = setup();
    h.manager.connect(h.hostId);
    const release = h.manager.hold(h.hostId);
    h.advance(60_000);
    h.manager.sweepIdle();
    expect(h.manager.get(h.hostId)).toBeDefined();
    release();
    h.advance(999);
    h.manager.sweepIdle();
    expect(h.manager.get(h.hostId)).toBeDefined();
    h.advance(1);
    h.manager.sweepIdle();
    expect(h.manager.get(h.hostId)).toBeUndefined();
  });

  it("keeps a link that stopped retrying, so why it stopped isn't forgotten", async () => {
    // ssh refused the login: it waits for the user.
    const h = setup({
      async open() {
        throw new SshAccessError("Permission denied (publickey).");
      },
    });
    h.manager.connect(h.hostId);
    await waitFor(() => h.manager.connectionState(h.hostId).status === "unreachable");
    expect(h.manager.connectionState(h.hostId)).toMatchObject({ stoppedRetrying: true });
    h.advance(10_000);
    h.manager.sweepIdle();
    expect(h.manager.connectionState(h.hostId)).toMatchObject({
      status: "unreachable",
      stoppedRetrying: true,
    });
  });

  it("restarts the window on each use", () => {
    const h = setup();
    h.manager.connect(h.hostId);
    h.advance(800);
    h.manager.touch(h.hostId);
    h.advance(800);
    h.manager.sweepIdle();
    expect(h.manager.get(h.hostId)).toBeDefined();
  });

  it("keeps a connection something says it uses, and a host whose notifications are on", () => {
    const h = setup();
    let forwarding = true;
    const off = h.manager.addUseCheck((hostId) => forwarding && hostId === h.hostId);
    h.manager.connect(h.hostId);
    h.advance(5_000);
    h.manager.sweepIdle();
    expect(h.manager.get(h.hostId)).toBeDefined();

    forwarding = false;
    off();
    h.registry.update({ hostId: h.hostId, notificationsEnabled: true });
    h.advance(5_000);
    h.manager.sweepIdle();
    expect(h.manager.get(h.hostId)).toBeDefined();

    h.registry.update({ hostId: h.hostId, notificationsEnabled: false });
    // The window counts from when it was last found in use.
    h.manager.sweepIdle();
    expect(h.manager.get(h.hostId)).toBeDefined();
    h.advance(1_000);
    h.manager.sweepIdle();
    expect(h.manager.get(h.hostId)).toBeUndefined();
  });
});
