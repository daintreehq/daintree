import { afterEach, describe, expect, it, vi } from "vitest";
import {
  magicPacket,
  sendWakePacket,
  wakeRouteFor,
  WAKE_PORT,
  type LocalInterfaces,
  type WakeSocket,
} from "../wakeOnLan.js";

const SETUP = { mac: "aa:bb:cc:dd:ee:f0", lan: "192.168.1.0/24" };

function iface(address: string, netmask: string, internal = false) {
  return {
    address,
    netmask,
    family: "IPv4" as const,
    mac: "00:00:00:00:00:00",
    internal,
    cidr: null,
  };
}

describe("wakeRouteFor", () => {
  it("sends from this machine's address on the host's LAN, to its broadcast address", () => {
    const interfaces = {
      lo0: [iface("127.0.0.1", "255.0.0.0", true)],
      utun3: [iface("100.64.0.5", "255.192.0.0")],
      en0: [iface("192.168.1.20", "255.255.255.0")],
    } as unknown as LocalInterfaces;
    expect(wakeRouteFor(SETUP, interfaces)).toEqual({
      kind: "route",
      localAddress: "192.168.1.20",
      broadcast: "192.168.1.255",
    });
  });

  it("says this machine isn't on the LAN rather than sending anywhere else", () => {
    const interfaces = {
      // An overlay address reaches the host, but carries no broadcast to its LAN.
      utun3: [iface("100.64.0.5", "255.192.0.0")],
      en0: [iface("10.0.0.7", "255.255.255.0")],
    } as unknown as LocalInterfaces;
    expect(wakeRouteFor(SETUP, interfaces)).toEqual({ kind: "not_on_lan" });
  });
});

describe("magicPacket", () => {
  it("is six 0xff bytes, then the address sixteen times", () => {
    const packet = magicPacket(SETUP.mac);
    expect(packet.length).toBe(102);
    expect([...packet.subarray(0, 6)]).toEqual(Array(6).fill(0xff));
    const address = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xf0];
    for (let i = 0; i < 16; i++) {
      expect([...packet.subarray(6 + i * 6, 12 + i * 6)]).toEqual(address);
    }
  });
});

interface FakeSocket extends WakeSocket {
  calls: string[];
  closes: number;
  errorListener: ((error: Error) => void) | null;
  sent: { packet: Buffer; port: number; address: string } | null;
}

function fakeSocket(behaviour: { sendError?: Error; hangBind?: boolean } = {}): FakeSocket {
  const socket: FakeSocket = {
    calls: [],
    closes: 0,
    errorListener: null,
    sent: null,
    bind(options, callback) {
      socket.calls.push(`bind ${options.address}:${options.port}`);
      if (!behaviour.hangBind) queueMicrotask(callback);
    },
    setBroadcast(flag) {
      socket.calls.push(`broadcast ${flag}`);
    },
    send(packet, port, address, callback) {
      socket.calls.push(`send ${address}:${port}`);
      socket.sent = { packet, port, address };
      queueMicrotask(() => callback(behaviour.sendError ?? null));
    },
    on(_event, listener) {
      socket.errorListener = listener;
    },
    close() {
      socket.closes++;
    },
  };
  return socket;
}

const ROUTE = { kind: "route" as const, localAddress: "192.168.1.20", broadcast: "192.168.1.255" };

describe("sendWakePacket", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("binds to the LAN address, turns on broadcast, sends once and closes", async () => {
    const socket = fakeSocket();
    await sendWakePacket(SETUP.mac, ROUTE, { createSocket: () => socket });
    expect(socket.calls).toEqual([
      "bind 192.168.1.20:0",
      "broadcast true",
      `send 192.168.1.255:${WAKE_PORT}`,
    ]);
    expect(socket.sent?.packet.equals(magicPacket(SETUP.mac))).toBe(true);
    expect(socket.closes).toBe(1);
  });

  it("rejects with the send's own error, and closes once", async () => {
    const socket = fakeSocket({ sendError: new Error("EHOSTUNREACH") });
    await expect(sendWakePacket(SETUP.mac, ROUTE, { createSocket: () => socket })).rejects.toThrow(
      "EHOSTUNREACH"
    );
    expect(socket.closes).toBe(1);
  });

  it("rejects on a socket error, and a late one changes nothing", async () => {
    const socket = fakeSocket({ hangBind: true });
    const sent = sendWakePacket(SETUP.mac, ROUTE, { createSocket: () => socket });
    socket.errorListener?.(new Error("EADDRNOTAVAIL"));
    await expect(sent).rejects.toThrow("EADDRNOTAVAIL");
    socket.errorListener?.(new Error("later"));
    expect(socket.closes).toBe(1);
  });

  it("gives up when the send doesn't finish in time", async () => {
    vi.useFakeTimers();
    const socket = fakeSocket({ hangBind: true });
    const sent = sendWakePacket(SETUP.mac, ROUTE, { createSocket: () => socket, timeoutMs: 50 });
    const settled = expect(sent).rejects.toThrow("in time");
    await vi.advanceTimersByTimeAsync(60);
    await settled;
    expect(socket.closes).toBe(1);
  });

  it("stops when cancelled, and never opens a socket once already cancelled", async () => {
    const socket = fakeSocket({ hangBind: true });
    const abort = new AbortController();
    const sent = sendWakePacket(SETUP.mac, ROUTE, {
      createSocket: () => socket,
      signal: abort.signal,
    });
    abort.abort();
    await expect(sent).rejects.toThrow("cancelled");
    expect(socket.closes).toBe(1);

    const create = vi.fn(() => fakeSocket());
    await expect(
      sendWakePacket(SETUP.mac, ROUTE, { createSocket: create, signal: abort.signal })
    ).rejects.toThrow("cancelled");
    expect(create).not.toHaveBeenCalled();
  });
});
