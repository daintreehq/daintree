/**
 * Real sockets, no `node:net` mock. The IPv4-only probe that shipped in
 * #12295 handed out a port an `ipv6Only` `::1` listener was holding, and a
 * mocked bind can't catch that class of bug — only the kernel can say whether
 * `0.0.0.0` and `::` are actually independent.
 */
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { probePortFree, waitForPortFree } from "../DevPreviewPortAllocator.js";

const servers: net.Server[] = [];

function listen(options: net.ListenOptions): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(null));
    try {
      server.listen(options, () => {
        servers.push(server);
        resolve(server);
      });
    } catch {
      resolve(null);
    }
  });
}

async function freePort(): Promise<number> {
  const server = await listen({ port: 0, host: "127.0.0.1" });
  if (!server) throw new Error("could not reserve a probe port");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  servers.splice(servers.indexOf(server), 1);
  return port;
}

async function hasUsableIpv6(): Promise<boolean> {
  const server = await listen({ port: 0, host: "::1", ipv6Only: true });
  if (!server) return false;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  servers.splice(servers.indexOf(server), 1);
  return true;
}

const ipv6Available = await hasUsableIpv6();

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server) continue;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("probePortFree against real sockets", () => {
  it("reports a genuinely unused port as free", async () => {
    expect(await probePortFree(await freePort())).toBe(true);
  });

  it("reports a port held on IPv4 as busy", async () => {
    const port = await freePort();
    expect(await listen({ port, host: "0.0.0.0" })).toBeTruthy();
    expect(await probePortFree(port)).toBe(false);
  });

  // The audit's exact repro: a fixture bound `::1` with ipv6Only was reported
  // free and the port was handed out.
  it.skipIf(!ipv6Available)("reports a port held only on IPv6 as busy", async () => {
    const port = await freePort();
    expect(await listen({ port, host: "::1", ipv6Only: true })).toBeTruthy();
    expect(await probePortFree(port)).toBe(false);
  });

  it.skipIf(!ipv6Available)("reports a dual-stack listener's port as busy", async () => {
    const port = await freePort();
    expect(await listen({ port, host: "::", ipv6Only: false })).toBeTruthy();
    expect(await probePortFree(port)).toBe(false);
  });

  it.skipIf(!ipv6Available)(
    "reports the port free again once the IPv6 listener closes",
    async () => {
      const port = await freePort();
      const server = await listen({ port, host: "::1", ipv6Only: true });
      expect(server).toBeTruthy();
      expect(await probePortFree(port)).toBe(false);

      await new Promise<void>((resolve) => server!.close(() => resolve()));
      servers.splice(servers.indexOf(server!), 1);

      expect(await waitForPortFree(port, new AbortController().signal, 5000)).toBe(true);
    }
  );
});
