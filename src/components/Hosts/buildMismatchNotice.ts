import type { HandshakeMismatch, HostHandshakeInfo, HostId } from "@shared/types/remoteHosts";
import { notify } from "@/lib/notify";
import { describeBuildMismatch } from "@/components/Settings/Hosts/hostLabels";
import { updateActionLabel, updateTargetFor } from "./hostModel";
import { runHostUpdate } from "./hostUpdate";

const noticed = new Set<string>();

const NOTICED_KEY_PREFIX = "daintree:host-build-noticed:";

/**
 * Every project view is its own renderer and a relaunch starts each afresh,
 * so the mark that a build was already noticed lives in localStorage, which
 * this machine's views share and which outlasts the launch. Memory covers a
 * view without storage.
 */
function alreadyNoticed(key: string): boolean {
  if (noticed.has(key)) return true;
  noticed.add(key);
  try {
    if (window.localStorage.getItem(NOTICED_KEY_PREFIX + key) !== null) return true;
    window.localStorage.setItem(NOTICED_KEY_PREFIX + key, "1");
  } catch {
    // No storage: once per view.
  }
  return false;
}

/**
 * Once per host build on this machine: a view connected to a host running a
 * different version or commit. The link stays up best effort, so this warns
 * and offers the update rather than blocking.
 */
export function noticeBuildMismatch(
  hostId: HostId,
  hostName: string,
  mismatch: HandshakeMismatch,
  remote: HostHandshakeInfo
): void {
  // The host's whole build: a new commit behind an unchanged version is news too.
  const key = `${hostId}\u0000${remote.version}\u0000${remote.commit}`;
  if (alreadyNoticed(key)) return;
  notify({
    type: "warning",
    context: { eventKind: "connectivity" },
    // Another notice for the same host replaces this one rather than stacking.
    supersedeKey: `host-build-mismatch:${hostId}`,
    title: `Different build on ${hostName}`,
    message: `Connected anyway: ${hostName} runs a ${describeBuildMismatch(mismatch)}. Most things work; anything that changed between the two builds may not.`,
    action: {
      label: updateActionLabel(mismatch, hostName),
      onClick: () => runHostUpdate(updateTargetFor(mismatch), hostId),
    },
  });
}

export function _resetBuildMismatchNoticesForTesting(): void {
  noticed.clear();
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(NOTICED_KEY_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {
    // No storage.
  }
}
