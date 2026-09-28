import * as semver from "semver";
import type {
  PluginParityGroup,
  PluginParityRow,
} from "../../../../shared/types/ipc/pluginParity.js";
import type {
  HostPlatform,
  PluginIncompatibleReason,
} from "../../../../shared/types/remoteHosts.js";
import { checkPluginEngineRange } from "../pluginEngineCompat.js";
import type { PluginInventory, PluginInventoryEntry } from "./inventory.js";

const GROUP_ORDER: Record<PluginParityGroup, number> = {
  "only-here": 0,
  "version-differs": 1,
  incompatible: 2,
  "only-on-host": 3,
  same: 4,
};

function isHostPlatform(value: string): value is HostPlatform {
  return value === "darwin" || value === "linux";
}

/** The host can't run this package at all: it has no build for the host's OS. */
function platformReason(
  entry: PluginInventoryEntry,
  hostPlatform: string
): PluginIncompatibleReason | null {
  if (entry.platforms === null || !isHostPlatform(hostPlatform)) return null;
  if ((entry.platforms as string[]).includes(hostPlatform)) return null;
  return {
    kind: "platform",
    hostPlatform,
    supported: entry.platforms.filter(isHostPlatform),
  };
}

function engineReason(
  entry: PluginInventoryEntry,
  hostVersion: string
): PluginIncompatibleReason | null {
  if (!entry.engine) return null;
  let mismatch: ReturnType<typeof checkPluginEngineRange>;
  try {
    mismatch = checkPluginEngineRange(hostVersion, entry.engine);
  } catch {
    return null;
  }
  return mismatch === null ? null : { kind: "engine", required: entry.engine, hostVersion };
}

/**
 * What stands between the host's copy and a window on another machine, most
 * decisive first. An unmet engine range is only a warning, since the host
 * loads the plugin anyway; the rest mean it won't serve this window as it is.
 */
function hostCopyReason(
  entry: PluginInventoryEntry,
  host: PluginInventory
): PluginIncompatibleReason | null {
  if (entry.blocklisted) return { kind: "untrusted" };
  if (entry.remoteUnsupported) return { kind: "remote-unsupported" };
  const engine = engineReason(entry, host.appVersion);
  if (engine) return engine;
  if (entry.missingSecrets.length > 0) {
    return { kind: "unconfigured", missing: entry.missingSecrets };
  }
  return null;
}

function versionOrder(local: string, host: string): number {
  const a = semver.valid(local);
  const b = semver.valid(host);
  if (!a || !b) return local === host ? 0 : Number.NaN;
  return semver.compare(a, b);
}

/**
 * Compare this machine's installed plugins with a host's. Nothing here is
 * acted on: each row says what differs and, where one helps, the single
 * action that would fix it, which the person has to ask for.
 */
export function computePluginParity(
  local: PluginInventory,
  host: PluginInventory
): PluginParityRow[] {
  const here = new Map(local.plugins.map((entry) => [entry.pluginId, entry]));
  const there = new Map(host.plugins.map((entry) => [entry.pluginId, entry]));
  const rows: PluginParityRow[] = [];

  for (const entry of here.values()) {
    const hostEntry = there.get(entry.pluginId);
    const platform = platformReason(entry, host.platform);
    if (!hostEntry) {
      // Installing either would leave the host's windows no better off.
      const blocking: PluginIncompatibleReason | null =
        platform ?? (entry.remoteUnsupported ? { kind: "remote-unsupported" } : null);
      rows.push({
        pluginId: entry.pluginId,
        displayName: entry.displayName,
        group: blocking ? "incompatible" : "only-here",
        localVersion: entry.version,
        hostVersion: null,
        incompatibility: blocking ?? engineReason(entry, host.appVersion),
        action: blocking ? null : "install-on-host",
      });
      continue;
    }
    const order = versionOrder(entry.version, hostEntry.version);
    const newerHere = order > 0;
    const reason = hostCopyReason(hostEntry, host) ?? (newerHere ? platform : null);
    const differs = order !== 0;
    const group: PluginParityGroup = reason ? "incompatible" : differs ? "version-differs" : "same";
    rows.push({
      pluginId: entry.pluginId,
      displayName: hostEntry.displayName || entry.displayName,
      group,
      localVersion: entry.version,
      hostVersion: hostEntry.version,
      incompatibility: reason,
      // Only a newer copy is offered: replacing the host's with an older one
      // would quietly downgrade what its agents use.
      action: newerHere && platform === null ? "update-on-host" : null,
    });
  }

  for (const hostEntry of there.values()) {
    if (here.has(hostEntry.pluginId)) continue;
    const reason = hostCopyReason(hostEntry, host);
    rows.push({
      pluginId: hostEntry.pluginId,
      displayName: hostEntry.displayName,
      group: reason ? "incompatible" : "only-on-host",
      localVersion: null,
      hostVersion: hostEntry.version,
      incompatibility: reason,
      action: null,
    });
  }

  return rows.sort(
    (a, b) =>
      GROUP_ORDER[a.group] - GROUP_ORDER[b.group] ||
      a.displayName.localeCompare(b.displayName) ||
      a.pluginId.localeCompare(b.pluginId)
  );
}
