import dgram from "node:dgram";
import os from "node:os";
import {
  isOnWakeLan,
  readWakeLan,
  wakeLanBroadcast,
  type HostWakeSetup,
} from "../../../shared/types/hostWake.js";

/** The port Wake-on-LAN listeners conventionally watch ("discard"). */
export const WAKE_PORT = 9;
/** Longest a send may take before it counts as failed. */
const SEND_TIMEOUT_MS = 2_000;

/**
 * Where a wake for a host goes from this machine: out of the local address it
 * has on the host's LAN, to that LAN's broadcast address. Never to the ssh
 * target, which an overlay network (Tailscale) routes but won't broadcast.
 */
export type WakeRoute =
  | { kind: "route"; localAddress: string; broadcast: string }
  | { kind: "not_on_lan" };

/** This machine's IPv4 addresses with their netmasks, as `os.networkInterfaces()` lists them. */
export type LocalInterfaces = ReturnType<typeof os.networkInterfaces>;

/** Whether this machine has an address on the host's LAN, and which one to send from. */
export function wakeRouteFor(
  setup: HostWakeSetup,
  interfaces: LocalInterfaces = os.networkInterfaces()
): WakeRoute {
  const lan = readWakeLan(setup.lan);
  if (!lan) return { kind: "not_on_lan" };
  const names = Object.keys(interfaces).sort();
  for (const name of names) {
    for (const info of interfaces[name] ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      if (isOnWakeLan(lan, info.address, info.netmask)) {
        return { kind: "route", localAddress: info.address, broadcast: wakeLanBroadcast(lan) };
      }
    }
  }
  return { kind: "not_on_lan" };
}

/** Six 0xff bytes, then the hardware address sixteen times. */
export function magicPacket(mac: string): Buffer {
  const address = Buffer.from(mac.replace(/:/g, ""), "hex");
  if (address.length !== 6) throw new Error("A hardware address is six bytes");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => address)]);
}

export interface WakeSocket {
  bind(options: { address: string; port: number }, callback: () => void): void;
  setBroadcast(flag: boolean): void;
  send(packet: Buffer, port: number, address: string, callback: (error: Error | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  close(): void;
}

export interface SendWakeOptions {
  signal?: AbortSignal;
  /** The socket to send through; a UDP socket of this machine's unless given. */
  createSocket?: () => WakeSocket;
  timeoutMs?: number;
}

/**
 * Sends one magic packet for `mac` along `route`. Resolves once the system
 * took it; rejects with what failed. Taking it says nothing about whether the
 * host heard it, or was asleep at all.
 */
export function sendWakePacket(
  mac: string,
  route: Extract<WakeRoute, { kind: "route" }>,
  options: SendWakeOptions = {}
): Promise<void> {
  const packet = magicPacket(mac);
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("The wake was cancelled"));
      return;
    }
    const socket = (options.createSocket ?? (() => dgram.createSocket("udp4")))();
    let done = false;
    const finish = (error: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        socket.close();
      } catch {
        // Already closed by its own error.
      }
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(new Error("The wake was cancelled"));
    const timer = setTimeout(
      () => finish(new Error("The wake wasn't sent in time")),
      options.timeoutMs ?? SEND_TIMEOUT_MS
    );
    timer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("error", (error) => finish(error));
    try {
      // Bound to the address on the host's LAN, so the packet leaves on that network.
      socket.bind({ address: route.localAddress, port: 0 }, () => {
        if (done) return;
        try {
          socket.setBroadcast(true);
          socket.send(packet, WAKE_PORT, route.broadcast, (error) => finish(error));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
