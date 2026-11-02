import { z } from "zod";

/**
 * How a paired host can be woken from the network (#16170): Wake-on-LAN, sent
 * by this machine to the host's own LAN. Recorded by the person per host;
 * Daintree never changes the host's own sleep, energy or adapter settings,
 * which have to allow it (macOS: "Wake for network access"; Linux: Wake-on-LAN
 * enabled in the firmware and on the adapter).
 */
export interface HostWakeSetup {
  /** The adapter's hardware address, as `aa:bb:cc:dd:ee:ff`. */
  mac: string;
  /** The host's LAN as IPv4 CIDR, e.g. `192.168.1.0/24`; this machine must be on it to send. */
  lan: string;
}

/** Shortest and longest LAN prefixes a wake can go to: a /31 or /32 has no broadcast address. */
export const HOST_WAKE_LAN_PREFIX_MIN = 8;
export const HOST_WAKE_LAN_PREFIX_MAX = 30;

const MAC_SEPARATED = /^([0-9a-f]{2})([:-])([0-9a-f]{2})(?:\2([0-9a-f]{2})){4}$/i;

/** `aa:bb:cc:dd:ee:ff` from the usual spellings, or null for anything that can't be a host's adapter. */
export function parseWakeMac(text: string): string | null {
  const trimmed = text.trim().toLowerCase();
  let hex: string;
  if (MAC_SEPARATED.test(trimmed)) hex = trimmed.replace(/[:-]/g, "");
  else if (/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/.test(trimmed)) hex = trimmed.replace(/\./g, "");
  else if (/^[0-9a-f]{12}$/.test(trimmed)) hex = trimmed;
  else return null;
  if (hex.length !== 12 || /^0+$/.test(hex)) return null;
  // A group address (multicast, or the broadcast address) names no one adapter.
  if ((Number.parseInt(hex.slice(0, 2), 16) & 1) === 1) return null;
  return hex.match(/../g)!.join(":");
}

function parseIpv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function formatIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

export interface WakeLan {
  /** The network address, as a number. */
  network: number;
  prefix: number;
  /** The LAN's broadcast address, as a number. */
  broadcast: number;
}

function maskOf(prefix: number): number {
  return (2 ** 32 - 2 ** (32 - prefix)) >>> 0;
}

/** The LAN a CIDR names, held to the network's own address; null for anything else. */
export function readWakeLan(text: string): WakeLan | null {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(text.trim());
  if (!match) return null;
  const address = parseIpv4(match[1]!);
  const prefix = Number(match[2]);
  if (address === null || prefix < HOST_WAKE_LAN_PREFIX_MIN || prefix > HOST_WAKE_LAN_PREFIX_MAX) {
    return null;
  }
  const mask = maskOf(prefix);
  const network = (address & mask) >>> 0;
  return { network, prefix, broadcast: (network | (~mask >>> 0)) >>> 0 };
}

/** `192.168.1.0/24` from any address on it with its prefix, or null. */
export function parseWakeLan(text: string): string | null {
  const lan = readWakeLan(text);
  return lan ? `${formatIpv4(lan.network)}/${lan.prefix}` : null;
}

export function wakeLanBroadcast(lan: WakeLan): string {
  return formatIpv4(lan.broadcast);
}

/** Whether an IPv4 address with the given netmask is on the LAN, with the same prefix. */
export function isOnWakeLan(lan: WakeLan, address: string, netmask: string): boolean {
  const ip = parseIpv4(address);
  const mask = parseIpv4(netmask);
  if (ip === null || mask === null || mask !== maskOf(lan.prefix)) return false;
  return (ip & mask) >>> 0 === lan.network;
}

/** A stored or sent wake setup, normalized; null when either part isn't usable. */
export function normalizeHostWake(value: unknown): HostWakeSetup | null {
  if (!value || typeof value !== "object") return null;
  const { mac, lan } = value as { mac?: unknown; lan?: unknown };
  if (typeof mac !== "string" || typeof lan !== "string") return null;
  const parsedMac = parseWakeMac(mac);
  const parsedLan = parseWakeLan(lan);
  return parsedMac && parsedLan ? { mac: parsedMac, lan: parsedLan } : null;
}

/**
 * How one attempt to bring a host back ended (#16170), from what this Shell
 * observed during it, never a cause it guessed:
 * - `connected`: the link came up with neither a wake sent nor a start seen.
 * - `woken`: a wake was sent, then the link came up (whether the host was asleep is unknown).
 * - `started`: Daintree was started there in Host mode, then the link came up.
 * - `unreachable`: ssh refused to log in, or the connection can't be used from here.
 * - `not_wakeable`: ssh didn't reach it, and no wake could be sent to it from here.
 * - `not_startable`: ssh reached it, and Daintree there wasn't, or couldn't be, started.
 * - `version_mismatch`: it answered on another protocol.
 * - `timed_out`: still not back when the attempt's time ran out.
 * - `cancelled`: the host was disconnected, removed or re-pointed meanwhile.
 */
export const HOST_BRING_BACK_STATUSES = [
  "connected",
  "woken",
  "started",
  "unreachable",
  "not_wakeable",
  "not_startable",
  "version_mismatch",
  "timed_out",
  "cancelled",
] as const;
export type HostBringBackStatus = (typeof HOST_BRING_BACK_STATUSES)[number];

/**
 * What became of the wake: `not_needed` when the link was already up or the
 * host is a WSL distro on this PC; `not_set_up` when no wake is recorded for
 * it; `not_on_lan` when this machine has no address on its LAN; `failed` when
 * sending it failed.
 */
export const HOST_WAKE_RESULTS = ["sent", "not_needed", "not_set_up", "not_on_lan", "failed"] as const;
export type HostWakeResult = (typeof HOST_WAKE_RESULTS)[number];

/** Longest observed text an answer carries. */
export const HOST_BRING_BACK_OBSERVED_MAX = 500;

export const HostBringBackAnswerSchema = z.object({
  status: z.enum(HOST_BRING_BACK_STATUSES),
  wake: z.enum(HOST_WAKE_RESULTS),
  /** ssh got in during the attempt. */
  reached: z.boolean(),
  startRequested: z.boolean(),
  /** What was last seen: ssh's or the start's own words, or why no start went. */
  observed: z.string().nullable(),
  elapsedMs: z.number(),
});
export type HostBringBackAnswer = z.infer<typeof HostBringBackAnswerSchema>;
