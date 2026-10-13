import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { listenIpv6Relay } from "../localListener.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function upstream(): Promise<{ port: number; server: net.Server }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.on("error", () => {}));
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      cleanups.push(() => server.close());
      resolve({ port: (server.address() as net.AddressInfo).port, server });
    });
  });
}

describe("listenIpv6Relay", () => {
  it("closes promptly with a relayed connection still open", async () => {
    const { port } = await upstream();
    const relay = await listenIpv6Relay(port);
    // No IPv6 loopback here: nothing is relayed, so nothing to close.
    if (!relay) return;

    const client = net.connect({ port, host: "::1" });
    client.on("error", () => {});
    cleanups.push(() => client.destroy());
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    const ended = new Promise<void>((resolve) => client.once("close", () => resolve()));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      relay.close().then(() => "closed" as const),
      new Promise<"hung">((resolve) => {
        timer = setTimeout(() => resolve("hung"), 2_000);
      }),
    ]);
    clearTimeout(timer);

    expect(outcome).toBe("closed");
    await ended;
    expect(client.destroyed).toBe(true);
  });
});
