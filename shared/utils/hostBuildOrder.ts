import * as semver from "semver";
import type { HostBuildOrder } from "../types/ipc/remoteHosts.js";

/**
 * Release order of two versions: negative when `a` came first. Null when
 * either isn't a version semver can order (a nightly's prerelease tag orders
 * after its release's earlier nightlies, before the release itself).
 */
export function compareReleaseVersions(a: string, b: string): number | null {
  const left = semver.valid(a);
  const right = semver.valid(b);
  if (!left || !right) return null;
  return semver.compare(left, right);
}

/**
 * The host's build against this client's, by release order, so a host that
 * picked up a release first reads as newer. Builds of one version from
 * different commits (or an unknown one), and versions semver can't read, are
 * unordered: neither side can be called newer.
 */
export function hostBuildOrder(
  host: { version: string; commit: string | null },
  client: { version: string; commit: string }
): HostBuildOrder {
  if (host.version === client.version) {
    return host.commit !== null && host.commit === client.commit ? "same" : "unordered";
  }
  const order = compareReleaseVersions(host.version, client.version);
  if (order === null || order === 0) return "unordered";
  return order > 0 ? "newer" : "older";
}
