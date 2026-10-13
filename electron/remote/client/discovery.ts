import os from "node:os";
import {
  sameHostAccount,
  sshConnection,
  sshMachineKey,
  type HostConnection,
  type HostPlatform,
} from "../../../shared/types/remoteHosts.js";
import type { DiscoveredHost } from "../../../shared/types/ipc/remoteHosts.js";
import type { CommandRunner } from "./commandRunner.js";
import { sshTargetOf } from "./connection.js";
import { isValidSshTarget } from "./sshTransport.js";
import { displaySafeText } from "../../../shared/utils/displaySafeText.js";

/**
 * Finding machines to add: tailnet peers from `tailscale status --json`, and
 * hosts advertising `_daintree._tcp` (Host mode on) or `_ssh._tcp` (a Mac with
 * Remote Login, a Linux box running avahi's ssh service) on the LAN (dns-sd on
 * macOS, avahi on Linux). Discovery only says a machine answered; whether Daintree runs there
 * is learned by probing it. Every machine found is reached over ssh (a
 * tailnet name, a LAN address). Every source is optional: a missing tool is an
 * empty list, never an error.
 */

export const BONJOUR_SERVICE_TYPE = "_daintree._tcp";
export const SSH_SERVICE_TYPE = "_ssh._tcp";
/** Daintree adverts first: they carry the platform, so they win the merge with a plain ssh one. */
const LAN_SERVICE_TYPES = [BONJOUR_SERVICE_TYPE, SSH_SERVICE_TYPE] as const;

/** The CLI on PATH first, then the macOS app's bundled one (GUI and App Store builds). */
export const TAILSCALE_CANDIDATES = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
];

export interface DiscoveryCandidate {
  name: string;
  sshTarget: string;
  source: "tailscale" | "bonjour";
  platform: HostPlatform | null;
  online: boolean;
  /**
   * Other names the same source vouches for as this machine (a tailnet node's
   * addresses and MagicDNS name, an mDNS record's resolved address). Matching
   * across sources and against the host list uses only these and the target.
   */
  aliases?: string[];
}

function platformFromOs(os: unknown): HostPlatform | null {
  if (typeof os !== "string") return null;
  const value = os.trim().toLowerCase();
  if (value === "macos" || value === "darwin" || value === "mac") return "darwin";
  if (value === "linux") return "linux";
  return null;
}

function stripDot(name: string): string {
  return name.endsWith(".") ? name.slice(0, -1) : name;
}

function firstString(values: unknown): string | null {
  if (!Array.isArray(values)) return null;
  const hit = values.find((v): v is string => typeof v === "string" && v.length > 0);
  return hit ?? null;
}

/**
 * Tailnet peers running macOS or Linux that are online. Accepts the shapes
 * different Tailscale releases print: `Peer` as a map or an array, absent or
 * null when alone on the tailnet, `OS` in either case, and `DNSName` missing
 * when MagicDNS is off (the first Tailscale IP is used then).
 */
export function parseTailscaleStatus(text: string): DiscoveryCandidate[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object") return [];
  const peerField = (raw as { Peer?: unknown }).Peer;
  const peers: unknown[] = Array.isArray(peerField)
    ? peerField
    : peerField && typeof peerField === "object"
      ? Object.values(peerField)
      : [];
  const out: DiscoveryCandidate[] = [];
  for (const entry of peers) {
    if (!entry || typeof entry !== "object") continue;
    const peer = entry as Record<string, unknown>;
    const platform = platformFromOs(peer.OS);
    if (!platform) continue;
    if (peer.Online !== true) continue;
    const dnsName = typeof peer.DNSName === "string" ? stripDot(peer.DNSName.trim()) : "";
    const target = dnsName || firstString(peer.TailscaleIPs) || "";
    if (!target || !isValidSshTarget(target)) continue;
    const hostName = typeof peer.HostName === "string" ? peer.HostName.trim() : "";
    const ips = Array.isArray(peer.TailscaleIPs)
      ? peer.TailscaleIPs.filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];
    out.push({
      name: hostName || (isIpAddress(target) ? target : target.split(".")[0]) || target,
      sshTarget: target,
      source: "tailscale",
      platform,
      online: true,
      aliases: dnsName ? [dnsName, ...ips] : ips,
    });
  }
  return out;
}

/** `\DDD` decimal escapes, as avahi's parsable output and dns-sd instance names use them. */
function unescapeDecimal(value: string): string {
  return value.replace(/\\(\d{3})/g, (_, code: string) => String.fromCharCode(Number(code)));
}

function parseTxt(parts: string[]): Record<string, string> {
  const txt: Record<string, string> = {};
  for (const part of parts) {
    const unquoted = part.replace(/^"|"$/g, "");
    const eq = unquoted.indexOf("=");
    if (eq <= 0) continue;
    const key = unquoted.slice(0, eq).toLowerCase();
    if (!(key in txt)) txt[key] = unquoted.slice(eq + 1);
  }
  return txt;
}

/**
 * An advert's port is the ssh port (`transport=ssh` for Daintree's own), and a
 * target string can't carry one, so only port 22 (or none given) is offered.
 * Another port is reachable through an ~/.ssh/config alias entered by hand.
 */
function isDefaultSshPort(port: string | number | undefined): boolean {
  if (port === undefined || port === "") return true;
  return Number(port) === 22;
}

function bonjourTarget(host: string, txt: Record<string, string>): string | null {
  const bare = stripDot(host.trim());
  if (!bare) return null;
  const user = txt.user;
  const target = user && /^[A-Za-z0-9._-]{1,64}$/.test(user) ? `${user}@${bare}` : bare;
  return isValidSshTarget(target) ? target : null;
}

/** `avahi-browse -rpt _daintree._tcp`: resolved (`=`) lines only. */
export function parseAvahiBrowse(text: string): DiscoveryCandidate[] {
  const out: DiscoveryCandidate[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("=;")) continue;
    const fields = line.split(";");
    if (fields.length < 9) continue;
    const name = unescapeDecimal(fields[3] ?? "");
    const host = unescapeDecimal(fields[6] ?? "");
    const txtRaw = fields.slice(9).join(";");
    const txt = parseTxt(txtRaw.match(/"[^"]*"/g) ?? []);
    if (!isDefaultSshPort(fields[8])) continue;
    const target = bonjourTarget(host, txt);
    if (!target) continue;
    const address = (fields[7] ?? "").trim();
    out.push({
      name: name || host,
      sshTarget: target,
      source: "bonjour",
      platform: platformFromOs(txt.platform),
      online: true,
      aliases: address ? [address] : [],
    });
  }
  return out;
}

/** Instance names from `dns-sd -B <type>` (added, not removed, in the local domain). */
export function parseDnsSdBrowse(
  text: string,
  serviceType: string = BONJOUR_SERVICE_TYPE
): Array<{ instance: string; domain: string }> {
  const added = new Map<string, { instance: string; domain: string }>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    // The timestamp's hour is space-padded (` 7:37:59.921`) before 10:00.
    const match = /^\s*\S+\s+(Add|Rmv)\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const [, action, domain, type, instance] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (!type.startsWith(serviceType)) continue;
    const key = `${instance}\u0000${domain}`;
    if (action === "Add") added.set(key, { instance: instance.trim(), domain });
    else added.delete(key);
  }
  return [...added.values()];
}

/** The host name and TXT record from `dns-sd -L <instance> <type> <domain>`. */
export function parseDnsSdLookup(
  text: string
): { host: string; port: number; txt: Record<string, string> } | null {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const index = lines.findIndex((line) => line.includes(" can be reached at "));
  if (index < 0) return null;
  const match = / can be reached at (\S+?):(\d+)/.exec(lines[index]!);
  if (!match) return null;
  const txtLine = lines[index + 1] ?? "";
  const txt = /^\s/.test(txtLine) ? parseTxt(txtLine.trim().split(/\s+/)) : {};
  return { host: match[1]!, port: Number(match[2]), txt };
}

export interface DiscoverDeps {
  run: CommandRunner;
  platform: NodeJS.Platform;
  /** How the hosts already in the list are reached. */
  knownConnections: readonly HostConnection[];
  /** How long to listen for LAN advertisements. */
  browseMs?: number;
  /** This machine's own mDNS names, so its own adverts aren't offered; read from the system unless given. */
  localHostNames?: readonly string[];
  signal?: AbortSignal;
}

async function discoverTailscale(deps: DiscoverDeps): Promise<DiscoveryCandidate[]> {
  for (const command of TAILSCALE_CANDIDATES) {
    const result = await deps.run(command, ["status", "--json"], {
      timeoutMs: 8_000,
      signal: deps.signal,
    });
    if (result.spawnError !== null) continue;
    // A stopped or logged-out tailscale still prints JSON, with no peers online.
    return parseTailscaleStatus(result.stdout);
  }
  return [];
}

async function discoverBonjourMac(deps: DiscoverDeps): Promise<DiscoveryCandidate[]> {
  const found = await Promise.all(LAN_SERVICE_TYPES.map((type) => browseDnsSd(deps, type)));
  return found.flat();
}

async function browseDnsSd(deps: DiscoverDeps, serviceType: string): Promise<DiscoveryCandidate[]> {
  const browseMs = deps.browseMs ?? 2_000;
  const browse = await deps.run("dns-sd", ["-B", serviceType], {
    collectForMs: browseMs,
    timeoutMs: browseMs + 2_000,
    signal: deps.signal,
  });
  if (browse.spawnError !== null) return [];
  const instances = parseDnsSdBrowse(browse.stdout, serviceType).slice(0, 32);
  const resolved = await Promise.all(
    instances.map(async ({ instance, domain }) => {
      const lookup = await deps.run("dns-sd", ["-L", instance, serviceType, domain], {
        collectForMs: 1_500,
        timeoutMs: 3_500,
        signal: deps.signal,
      });
      const parsed = parseDnsSdLookup(lookup.stdout);
      if (!parsed || !isDefaultSshPort(parsed.port)) return null;
      const target = bonjourTarget(parsed.host, parsed.txt);
      if (!target) return null;
      const candidate: DiscoveryCandidate = {
        name: unescapeDecimal(instance),
        sshTarget: target,
        source: "bonjour",
        platform: platformFromOs(parsed.txt.platform),
        online: true,
      };
      return candidate;
    })
  );
  return resolved.filter((c): c is DiscoveryCandidate => c !== null);
}

async function discoverBonjourLinux(deps: DiscoverDeps): Promise<DiscoveryCandidate[]> {
  const found = await Promise.all(
    LAN_SERVICE_TYPES.map(async (type) => {
      // `-l`: avahi's own flag for this machine's services, whatever name it publishes under.
      const result = await deps.run("avahi-browse", ["-rptl", type], {
        timeoutMs: (deps.browseMs ?? 2_000) + 4_000,
        signal: deps.signal,
      });
      return result.spawnError !== null ? [] : parseAvahiBrowse(result.stdout);
    })
  );
  return found.flat();
}

/**
 * The names this Mac answers to on the LAN: its LocalHostName (which can
 * differ from the system hostname) and the system hostname. dns-sd has no
 * flag for local services; on Linux, avahi's `-l` leaves them out instead.
 */
async function localMdnsNames(deps: DiscoverDeps): Promise<string[]> {
  if (deps.platform !== "darwin") return [];
  const names = [os.hostname()];
  const result = await deps.run("scutil", ["--get", "LocalHostName"], {
    timeoutMs: 2_000,
    signal: deps.signal,
  });
  const local = result.code === 0 ? result.stdout.trim() : "";
  if (local) names.push(`${local}.local`);
  return names;
}

function isIpAddress(value: string): boolean {
  return (
    /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || (value.includes(":") && /^[0-9a-f:.]+$/i.test(value))
  );
}

/** The machine a target names; see {@link sshMachineKey}. */
export const machineKey = sshMachineKey;

/**
 * Tailnet peers first (their names work from anywhere on the tailnet), then
 * LAN hosts. One machine seen by both sources is merged only when a source
 * vouches for a shared name or address; otherwise both rows are shown.
 * Manual entry is the dialog's own field.
 */
export async function discoverHosts(deps: DiscoverDeps): Promise<DiscoveredHost[]> {
  const bonjour =
    deps.platform === "darwin"
      ? discoverBonjourMac(deps)
      : deps.platform === "linux"
        ? discoverBonjourLinux(deps)
        : Promise.resolve([]);
  const [tailnet, lan, selfNames] = await Promise.all([
    discoverTailscale(deps).catch(() => []),
    bonjour.catch(() => []),
    deps.localHostNames
      ? Promise.resolve(deps.localHostNames)
      : localMdnsNames(deps).catch(() => []),
  ]);
  const knownTargets = deps.knownConnections
    .map(sshTargetOf)
    .filter((target): target is string => target !== null);
  const knownMachines = new Set(knownTargets.map(machineKey));
  // This machine's own LAN adverts (Remote Login, Host mode) are never a host to add.
  const self = new Set(selfNames.map(machineKey));
  const seen = new Set<string>();
  const out: DiscoveredHost[] = [];
  for (const candidate of [...tailnet, ...lan]) {
    if (candidate.source === "bonjour" && self.has(machineKey(candidate.sshTarget))) continue;
    const keys = [candidate.sshTarget, ...(candidate.aliases ?? [])].map(machineKey);
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    out.push({
      // A name off the network is the network's to choose: shown as plain text,
      // so bidi or zero-width characters can't pass one machine off as another.
      name: displaySafeText(candidate.name).trim() || candidate.sshTarget,
      connection: sshConnection(candidate.sshTarget),
      source: candidate.source,
      platform: candidate.platform,
      online: candidate.online,
      // Only this exact account is added already: another account on the same
      // machine is a host of its own, so the row stays pickable with a warning.
      alreadyAdded: deps.knownConnections.some((known) =>
        sameHostAccount(known, sshConnection(candidate.sshTarget))
      ),
      knownMachine: keys.some((key) => knownMachines.has(key)),
    });
  }
  return out;
}
