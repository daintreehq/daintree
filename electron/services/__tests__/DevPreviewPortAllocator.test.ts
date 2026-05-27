import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const netMock = vi.hoisted(() => ({
  // Ports that should fail to bind (simulating EADDRINUSE).
  busyPorts: new Set<number>(),
  // Per-port: number of remaining failures before the port becomes free.
  busyForCalls: new Map<number, number>(),
}));

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
      listen(this: unknown, port: number, _host: string, cb?: () => void) {
        listenPort = port;
        queueMicrotask(() => {
          if (closed) return;
          let isBusy = netMock.busyPorts.has(port);
          const remaining = netMock.busyForCalls.get(port);
          if (remaining !== undefined && remaining > 0) {
            isBusy = true;
            netMock.busyForCalls.set(port, remaining - 1);
          }
          if (isBusy) {
            for (const h of errorHandlers) h(new Error("EADDRINUSE"));
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
  releasePort,
  waitForPortFree,
  PORT_FREE_POLL_INTERVAL_MS,
} from "../DevPreviewPortAllocator.js";

beforeEach(() => {
  netMock.busyPorts.clear();
  netMock.busyForCalls.clear();
});

afterEach(() => {
  vi.useRealTimers();
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
    netMock.busyForCalls.set(6000, 3);
    const free = await waitForPortFree(6000, new AbortController().signal, 5000);
    expect(free).toBe(true);
  });

  it("resolves false on timeout when port stays busy", async () => {
    netMock.busyPorts.add(4444);
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
    netMock.busyPorts.add(4445);
    const controller = new AbortController();
    const promise = waitForPortFree(4445, controller.signal, 5000);
    // Wait long enough for the first probe failure + sleep to start
    await new Promise((resolve) => setTimeout(resolve, PORT_FREE_POLL_INTERVAL_MS / 2));
    controller.abort();
    const free = await promise;
    expect(free).toBe(false);
  });
});
