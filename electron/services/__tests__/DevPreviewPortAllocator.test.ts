import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const netMock = vi.hoisted(() => ({
  // `${host}|${port}` entries that should fail to bind, mapped to the errno the
  // kernel would report. Host is the literal wildcard the allocator binds.
  busy: new Map<string, string>(),
  // Per-key: number of remaining failures before the address becomes free.
  busyForCalls: new Map<string, number>(),
  listens: [] as Array<{ port: number; host: string; ipv6Only: boolean }>,
}));

function bindError(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

vi.mock("node:net", () => {
  const createServer = vi.fn(() => {
    let listenPort = 0;
    const errorHandlers: Array<(err: Error) => void> = [];
    let closed = false;
    return {
      unref(this: unknown) {
        return this;
      },
      once(this: unknown, event: string, cb: (...args: unknown[]) => void) {
        if (event === "error") errorHandlers.push(cb as (err: Error) => void);
        return this;
      },
      listen(
        this: unknown,
        options: { port: number; host: string; ipv6Only?: boolean },
        cb?: () => void
      ) {
        listenPort = options.port;
        const key = `${options.host}|${options.port}`;
        netMock.listens.push({
          port: options.port,
          host: options.host,
          ipv6Only: options.ipv6Only === true,
        });
        queueMicrotask(() => {
          if (closed) return;
          const modeKey = `${key}|${options.ipv6Only === true}`;
          let code = netMock.busy.get(modeKey) ?? netMock.busy.get(key);
          const remaining = netMock.busyForCalls.get(key);
          if (remaining !== undefined && remaining > 0) {
            code = code ?? "EADDRINUSE";
            netMock.busyForCalls.set(key, remaining - 1);
          }
          if (code) {
            for (const h of errorHandlers) h(bindError(code));
          } else {
            cb?.();
          }
        });
        return this;
      },
      close(this: unknown, cb?: () => void) {
        closed = true;
        queueMicrotask(() => cb?.());
        return this;
      },
      address() {
        return { port: listenPort === 0 ? 5678 : listenPort };
      },
    };
  });
  return { default: { createServer }, createServer };
});

import {
  allocatePort,
  probePortFree,
  releasePort,
  waitForPortFree,
  PORT_FREE_POLL_INTERVAL_MS,
} from "../DevPreviewPortAllocator.js";

beforeEach(() => {
  netMock.busy.clear();
  netMock.busyForCalls.clear();
  netMock.listens.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("probePortFree", () => {
  it("probes every address and both IPv6 binding modes a dev server could use", async () => {
    await probePortFree(4100);

    expect(netMock.listens).toEqual([
      { port: 4100, host: "0.0.0.0", ipv6Only: false },
      { port: 4100, host: "127.0.0.1", ipv6Only: false },
      { port: 4100, host: "::", ipv6Only: true },
      { port: 4100, host: "::1", ipv6Only: true },
      { port: 4100, host: "::", ipv6Only: false },
    ]);
  });

  it("reports busy when only the dual-stack binding detects an occupied port", async () => {
    netMock.busy.set("::|4110|false", "EADDRINUSE");
    expect(await probePortFree(4110)).toBe(false);
  });

  it("reports busy when only the IPv6 loopback is occupied", async () => {
    // SO_REUSEADDR lets both wildcards bind while ::1 is held, so the
    // loopback leg is the only one that sees a localhost-bound dev server.
    netMock.busy.set("::1|4108", "EADDRINUSE");
    expect(await probePortFree(4108)).toBe(false);
  });

  it("reports busy when only the IPv4 loopback is occupied", async () => {
    netMock.busy.set("127.0.0.1|4109", "EADDRINUSE");
    expect(await probePortFree(4109)).toBe(false);
  });

  it("reports busy when only the IPv6 wildcard is occupied", async () => {
    netMock.busy.set("::|4101", "EADDRINUSE");
    expect(await probePortFree(4101)).toBe(false);
  });

  it("reports busy when only IPv4 is occupied", async () => {
    netMock.busy.set("0.0.0.0|4102", "EADDRINUSE");
    expect(await probePortFree(4102)).toBe(false);
  });

  it("reports free when every address binds", async () => {
    expect(await probePortFree(4103)).toBe(true);
  });

  it.each(["EAFNOSUPPORT", "EADDRNOTAVAIL", "ENOPROTOOPT", "EINVAL"])(
    "treats IPv6 %s as unsupported rather than occupied",
    async (code) => {
      netMock.busy.set("::|4104", code);
      netMock.busy.set("::1|4104", code);
      expect(await probePortFree(4104)).toBe(true);
    }
  );

  it("does not report free when the IPv6 leg fails for an unrecognised reason", async () => {
    netMock.busy.set("::|4105", "EACCES");
    expect(await probePortFree(4105)).toBe(false);
  });

  it("does not treat an unsupported-family errno on the IPv4 leg as free", async () => {
    netMock.busy.set("0.0.0.0|4106", "EAFNOSUPPORT");
    expect(await probePortFree(4106)).toBe(false);
  });

  it("returns false once the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await probePortFree(4107, controller.signal)).toBe(false);
  });
});

describe("allocatePort", () => {
  it("returns existing port from registry", async () => {
    const registry = new Map<string, number>();
    registry.set("session-1", 4000);
    const port = await allocatePort(registry, "session-1");
    expect(port).toBe(4000);
  });

  it("allocates and stores a new port", async () => {
    const registry = new Map<string, number>();
    const port = await allocatePort(registry, "session-new");
    expect(port).toBeGreaterThan(0);
    expect(registry.get("session-new")).toBe(port);
  });

  it("rejects a candidate whose IPv6 wildcard is taken", async () => {
    const registry = new Map<string, number>();
    // Every candidate is IPv6-busy, so the random loop exhausts and the
    // OS-assigned fallback (5678 from the mock) is checked too.
    for (let port = 3000; port < 10_000; port++) netMock.busy.set(`::|${port}`, "EADDRINUSE");
    netMock.busy.set("::|5678", "EADDRINUSE");

    await expect(allocatePort(registry, "session-v6")).rejects.toThrow("Failed to allocate port");
    expect(registry.has("session-v6")).toBe(false);
  });

  it("still allocates on a host with no usable IPv6", async () => {
    const registry = new Map<string, number>();
    for (let port = 3000; port < 10_000; port++) {
      netMock.busy.set(`::|${port}`, "EAFNOSUPPORT");
      netMock.busy.set(`::1|${port}`, "EAFNOSUPPORT");
    }
    netMock.busy.set("::|5678", "EAFNOSUPPORT");
    netMock.busy.set("::1|5678", "EAFNOSUPPORT");

    const port = await allocatePort(registry, "session-v4only");
    expect(port).toBeGreaterThan(0);
    expect(registry.get("session-v4only")).toBe(port);
  });

  it("does not hand the OS-assigned fallback port to a session that already holds it", async () => {
    const registry = new Map<string, number>();
    registry.set("other-session", 5678);
    for (let port = 3000; port < 10_000; port++) netMock.busy.set(`0.0.0.0|${port}`, "EADDRINUSE");

    await expect(allocatePort(registry, "session-collide")).rejects.toThrow(
      "Failed to allocate port"
    );
    expect(registry.get("other-session")).toBe(5678);
    expect(registry.has("session-collide")).toBe(false);
  });
});

describe("releasePort", () => {
  it("removes the session key from registry", () => {
    const registry = new Map<string, string | number>();
    registry.set("session-1", 4000);
    releasePort(registry as Map<string, number>, "session-1");
    expect(registry.has("session-1")).toBe(false);
  });

  it("is harmless for missing keys", () => {
    const registry = new Map<string, number>();
    expect(() => releasePort(registry, "nonexistent")).not.toThrow();
  });
});

describe("waitForPortFree", () => {
  it("resolves true when the port is free on the first probe", async () => {
    const free = await waitForPortFree(5000, new AbortController().signal, 1000);
    expect(free).toBe(true);
  });

  it("resolves true once the port becomes free after several probes", async () => {
    netMock.busyForCalls.set("0.0.0.0|6000", 3);
    const free = await waitForPortFree(6000, new AbortController().signal, 5000);
    expect(free).toBe(true);
  });

  it("keeps waiting while only the IPv6 wildcard is held", async () => {
    netMock.busy.set("::|4444", "EADDRINUSE");
    const free = await waitForPortFree(4444, new AbortController().signal, 50);
    expect(free).toBe(false);
  });

  it("resolves false on timeout when port stays busy", async () => {
    netMock.busy.set("0.0.0.0|4444", "EADDRINUSE");
    const free = await waitForPortFree(4444, new AbortController().signal, 50);
    expect(free).toBe(false);
  });

  it("resolves false when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const free = await waitForPortFree(5000, controller.signal, 1000);
    expect(free).toBe(false);
  });

  it("resolves false when aborted mid-poll", async () => {
    netMock.busy.set("0.0.0.0|4445", "EADDRINUSE");
    const controller = new AbortController();
    const promise = waitForPortFree(4445, controller.signal, 5000);
    // Wait long enough for the first probe failure + sleep to start
    await new Promise((resolve) => setTimeout(resolve, PORT_FREE_POLL_INTERVAL_MS / 2));
    controller.abort();
    const free = await promise;
    expect(free).toBe(false);
  });
});
