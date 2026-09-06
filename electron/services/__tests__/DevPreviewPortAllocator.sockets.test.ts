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

const IPV6_CAPABILITY_CODES = new Set(["EAFNOSUPPORT", "EADDRNOTAVAIL", "ENOPROTOOPT", "EINVAL"]);

function listen(options: net.ListenOptions): Promise<net.Server | { code?: string }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (err) => resolve({ code: (err as NodeJS.ErrnoException).code }));
    try {
      server.listen(options, () => {
        servers.push(server);
        resolve(server);
      });
    } catch (err) {
      resolve({ code: (err as NodeJS.ErrnoException).code });
    }
  });
}

function isServer(value: net.Server | { code?: string }): value is net.Server {
  return value instanceof net.Server;
}

async function freePort(): Promise<number> {
  const server = await listen({ port: 0, host: "127.0.0.1" });
  if (!isServer(server)) throw new Error(`could not reserve a probe port: ${server.code}`);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  servers.splice(servers.indexOf(server), 1);
  return port;
}

async function hasUsableIpv6(): Promise<boolean> {
  const server = await listen({ port: 0, host: "::1", ipv6Only: true });
  if (!isServer(server)) {
    // Only a genuine capability failure disables the IPv6 cases; anything else
    // (a permission or resource error) should surface as a real failure.
    if (server.code && IPV6_CAPABILITY_CODES.has(server.code)) return false;
    throw new Error(`unexpected IPv6 probe failure: ${server.code}`);
  }
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
    expect(isServer(await listen({ port, host: "0.0.0.0" }))).toBe(true);
    expect(await probePortFree(port)).toBe(false);
  });

  // The audit's exact repro: a fixture bound `::1` with ipv6Only was reported
  // free and the port was handed out.
  it.skipIf(!ipv6Available)("reports a port held only on IPv6 as busy", async () => {
    const port = await freePort();
    expect(isServer(await listen({ port, host: "::1", ipv6Only: true }))).toBe(true);
    expect(await probePortFree(port)).toBe(false);
  });

  it("reports a port held only on the IPv4 loopback as busy", async () => {
    const port = await freePort();
    expect(isServer(await listen({ port, host: "127.0.0.1" }))).toBe(true);
    expect(await probePortFree(port)).toBe(false);
  });

  it.skipIf(!ipv6Available)("reports a dual-stack listener's port as busy", async () => {
    const port = await freePort();
    expect(isServer(await listen({ port, host: "::", ipv6Only: false }))).toBe(true);
    expect(await probePortFree(port)).toBe(false);
  });

  it.skipIf(!ipv6Available)(
    "reports the port free again once the IPv6 listener closes",
    async () => {
      const port = await freePort();
      const server = await listen({ port, host: "::1", ipv6Only: true });
      expect(isServer(server)).toBe(true);
      expect(await probePortFree(port)).toBe(false);

      const held = server as net.Server;
      await new Promise<void>((resolve) => held.close(() => resolve()));
      servers.splice(servers.indexOf(held), 1);

      expect(await waitForPortFree(port, new AbortController().signal, 5000)).toBe(true);
    }
  );
});
