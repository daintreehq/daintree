import type { HostListeningPort } from "../../../shared/types/ipc/portForwards.js";
import {
  nodeProcFs,
  parseLsofListeners,
  readProcNetTables,
  runLsof,
  socketOwners,
  type ProcFs,
  type RawListener,
} from "../../utils/localPortListeners.js";

// Offer the machine's loopback-reachable listeners to a Shell for forwarding.
const MAX_LISTENERS = 256;

/** Keep one entry per port (the first that names a process), sorted, without our own process. */
export function finalizeListeners(
  listeners: RawListener[],
  excludePids: ReadonlySet<number>
): HostListeningPort[] {
  const byPort = new Map<number, RawListener>();
  for (const listener of listeners) {
    if (listener.pid !== null && excludePids.has(listener.pid)) continue;
    const known = byPort.get(listener.port);
    if (!known || (known.processName === null && listener.processName !== null)) {
      byPort.set(listener.port, listener);
    }
  }
  return [...byPort.values()]
    .sort((a, b) => a.port - b.port)
    .slice(0, MAX_LISTENERS)
    .map(({ port, pid, processName }) => ({ port, pid, processName }));
}

/** Linux: the user's own listeners, with the owning process where its fds are readable. */
export async function scanLinuxListeners(
  uid: number,
  procFs: ProcFs = nodeProcFs
): Promise<RawListener[]> {
  const listeners = ((await readProcNetTables(procFs)) ?? []).filter((entry) => entry.uid === uid);
  const owners = await socketOwners(new Set(listeners.map((listener) => listener.inode)), procFs);
  return listeners.map((listener) => {
    const owner = owners.get(listener.inode);
    return {
      port: listener.port,
      pid: owner?.pid ?? null,
      processName: owner?.processName ?? null,
    };
  });
}

export type LsofRunner = () => Promise<string>;

const defaultLsof: LsofRunner = () => runLsof(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]);

export interface ListenerScanOptions {
  platform?: NodeJS.Platform;
  uid?: number;
  lsof?: LsofRunner;
  procFs?: ProcFs;
  excludePids?: ReadonlySet<number>;
}

export async function scanHostListeners(
  options: ListenerScanOptions = {}
): Promise<HostListeningPort[]> {
  const platform = options.platform ?? process.platform;
  const exclude = options.excludePids ?? new Set([process.pid]);
  if (platform === "darwin") {
    const output = await (options.lsof ?? defaultLsof)();
    return finalizeListeners(parseLsofListeners(output), exclude);
  }
  if (platform === "linux") {
    const uid = options.uid ?? process.getuid?.() ?? -1;
    return finalizeListeners(await scanLinuxListeners(uid, options.procFs), exclude);
  }
  return [];
}
