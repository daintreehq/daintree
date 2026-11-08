import { networkInterfaces } from "node:os";
import { net } from "electron";

/**
 * This machine's network as a comparable string: whether Chromium thinks it
 * is online, and every external interface address. Addresses stay in memory.
 */
export function networkFingerprint(
  online: boolean,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()
): string {
  const addresses: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry.internal) addresses.push(`${name}/${entry.family}/${entry.address}`);
    }
  }
  return `${online ? "online" : "offline"}|${addresses.sort().join(",")}`;
}

export interface NetworkWatchOptions {
  /** How often to compare; the default is five seconds. */
  intervalMs?: number;
  /** Reads the fingerprint and whether the machine is online. */
  read?: () => { online: boolean; fingerprint: string };
}

const NETWORK_POLL_MS = 5_000;

function readNetwork(): { online: boolean; fingerprint: string } {
  const online = net.isOnline();
  return { online, fingerprint: networkFingerprint(online) };
}

/**
 * Electron's main process has no network-change event, so this compares the
 * network every few seconds while a relay connection is wanted, and calls
 * `onChange` with whether it is online once it differs from the last look.
 * It sees link and address changes; a change only of route, DNS or proxy
 * shows nothing here.
 */
export function watchNetwork(
  onChange: (online: boolean) => void,
  options: NetworkWatchOptions = {}
): () => void {
  const read = options.read ?? readNetwork;
  let last: string | null = null;
  const look = () => {
    let reading: { online: boolean; fingerprint: string };
    try {
      reading = read();
    } catch {
      return;
    }
    const changed = last !== null && reading.fingerprint !== last;
    last = reading.fingerprint;
    if (changed) onChange(reading.online);
  };
  look();
  const timer = setInterval(look, options.intervalMs ?? NETWORK_POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
