import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceOptions } from "@homebridge/ciao";
import { RemoteDiscoveryService } from "../RemoteDiscoveryService.js";

function harness() {
  let available = true;
  const services: Array<{
    options: ServiceOptions;
    advertise: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }> = [];
  const responders: Array<{ shutdown: ReturnType<typeof vi.fn> }> = [];
  const discovery = new RemoteDiscoveryService(
    { publicIdentity: () => ({ hostId: "host-stable-id" }) } as never,
    { certificateFingerprint: () => "sha256:abcdefghijklmnop-rest-is-private" } as never,
    "0.30.1",
    () => {
      const responder = { shutdown: vi.fn(async () => undefined) };
      responders.push(responder);
      return {
        ...responder,
        createService: (options: ServiceOptions) => {
          const service = {
            options,
            advertise: vi.fn(async () => undefined),
            destroy: vi.fn(async () => undefined),
          };
          services.push(service);
          return service;
        },
      };
    },
    () => available,
    () => "Studio Mac",
    "darwin"
  );
  return {
    discovery,
    services,
    responders,
    setAvailable: (value: boolean) => {
      available = value;
    },
  };
}

describe("RemoteDiscoveryService", () => {
  afterEach(() => vi.useRealTimers());

  it("advertises the selected LAN address with the bounded public metadata contract", async () => {
    const h = harness();
    await h.discovery.start(45_123, {
      enabled: true,
      bindAddress: "192.168.1.8",
      port: 0,
      discoveryEnabled: true,
      displayName: "Development Mac",
    });

    expect(h.services).toHaveLength(1);
    expect(h.services[0]?.options).toEqual({
      name: "Development Mac",
      type: "daintree-portal",
      port: 45_123,
      restrictedAddresses: ["192.168.1.8", "lo0"],
      txt: {
        name: "Development Mac",
        id: "host-stable-id",
        pmin: "1",
        pmax: "1",
        ver: "0.30.1",
        os: "macos",
        addr: "192.168.1.8",
        port: "45123",
        fp: "abcdefghijklmnop",
      },
    });
    expect(JSON.stringify(h.services[0]?.options)).not.toMatch(
      /project|path|device|capabilit|token|secret|pair/i
    );

    await h.discovery.stop();
    expect(h.services[0]?.destroy).toHaveBeenCalledOnce();
    expect(h.responders[0]?.shutdown).toHaveBeenCalledOnce();
  });

  it("does not advertise when discovery is disabled", async () => {
    const h = harness();
    await h.discovery.start(45_123, {
      enabled: true,
      bindAddress: "192.168.1.8",
      port: 45_123,
      discoveryEnabled: false,
    });

    expect(h.services).toEqual([]);
    await h.discovery.stop();
  });

  it("withdraws on interface loss and advertises coherently after recovery", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.discovery.start(45_123, {
      enabled: true,
      bindAddress: "10.0.0.8",
      port: 45_123,
      discoveryEnabled: true,
    });
    expect(h.services).toHaveLength(1);

    h.setAvailable(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.services[0]?.destroy).toHaveBeenCalledOnce();

    h.setAvailable(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.services).toHaveLength(2);
    expect(h.services[1]?.advertise).toHaveBeenCalledOnce();

    await h.discovery.stop();
  });

  it("keeps advertisement absent until the selected interface appears", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.setAvailable(false);
    await h.discovery.start(45_123, {
      enabled: true,
      bindAddress: "10.0.0.8",
      port: 45_123,
      discoveryEnabled: true,
    });
    expect(h.services).toEqual([]);

    h.setAvailable(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.services).toHaveLength(1);
    await h.discovery.stop();
  });
});
