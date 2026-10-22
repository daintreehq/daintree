import { afterEach, describe, expect, it } from "vitest";
import type { HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { TEST_HANDSHAKE, waitFor } from "../../link/__tests__/linkTestUtils.js";
import { HostRegistry, type RemoteHostsStore } from "../HostRegistry.js";
import { RemoteHostManager } from "../RemoteHostManager.js";
import { HostModeOffError, type LinkTransport } from "../transport.js";

function memoryStore(): RemoteHostsStore {
  let value: { hosts: HostDescriptor[] } | undefined;
  return { get: () => value, set: (_key, next) => void (value = next) };
}

const NOW = 10 * 60_000;

let manager: RemoteHostManager | null = null;

afterEach(async () => {
  await manager?.disposeAll();
  manager = null;
});

/** A host whose Daintree has gone: ssh reaches it and finds no host.json. */
function setup(lastSeenAt: number | null) {
  const transport: LinkTransport & { opens: number } = {
    opens: 0,
    async open(): Promise<never> {
      transport.opens++;
      throw new HostModeOffError("Daintree isn't running in Host mode there (no host.json).");
    },
  };
  const registry = new HostRegistry(memoryStore());
  const host = registry.add({ name: "studio", connection: { kind: "ssh", target: "studio" } });
  if (lastSeenAt !== null) registry.recordObservation(host.id, { lastSeenAt });
  manager = new RemoteHostManager({
    registry,
    createTransport: () => transport,
    handshake: () => TEST_HANDSHAKE,
    client: { clientId: "c", clientName: "mbp", platform: "darwin" },
    views: { send: () => true, watch: () => () => {}, resync: () => {} },
    backoff: { initialMs: 1, maxMs: 1, jitter: 0 },
    now: () => NOW,
    idleReleaseMs: 0,
  });
  return { manager, hostId: host.id, transport };
}

describe("RemoteHostManager after a host restart", () => {
  it("keeps a new connection retrying when an earlier one heard the host moments ago", async () => {
    // A link made at launch, or after the last one was released for being unused.
    const h = setup(NOW - 30_000);
    const connection = h.manager.connect(h.hostId);
    await waitFor(() => h.transport.opens >= 3);
    expect(connection.restarting).toBe(true);
    // Still trying, so a switch waits for it rather than being told to set the host up.
    await expect(connection.whenReady(20)).resolves.toBe("timeout");
  });

  it("parks a new connection to a host last heard from longer ago than a restart takes", async () => {
    for (const lastSeenAt of [NOW - 10 * 60_000, null]) {
      const h = setup(lastSeenAt);
      const connection = h.manager.connect(h.hostId);
      await expect(connection.whenReady(1_000)).resolves.toBe("host-mode-off");
      expect(connection.restarting).toBe(false);
      expect(h.manager.connectionState(h.hostId)).toMatchObject({
        status: "unreachable",
        lastSeenAt,
        hostModeOff: true,
        stoppedRetrying: true,
      });
      expect(h.transport.opens).toBe(1);
      await h.manager.disposeAll();
    }
  });
});
