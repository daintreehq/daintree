import type { HandshakeMismatch, HostHandshakeInfo, HostId } from "@shared/types/remoteHosts";
import { notify } from "@/lib/notify";
import { describeBuildMismatch } from "@/components/Settings/Hosts/hostLabels";
import { updateActionLabel, updateTargetFor } from "./hostModel";
import { runHostUpdate } from "./hostUpdate";

const noticed = new Set<string>();

/**
 * Once per host build: this view connected to a host running a different
 * version or commit. The link stays up best effort, so this warns and offers
 * the update rather than blocking.
 */
export function noticeBuildMismatch(
  hostId: HostId,
  hostName: string,
  mismatch: HandshakeMismatch,
  remote: HostHandshakeInfo
): void {
  // The host's whole build: a new commit behind an unchanged version is news too.
  const key = `${hostId}\u0000${remote.version}\u0000${remote.commit}`;
  if (noticed.has(key)) return;
  noticed.add(key);
  notify({
    type: "warning",
    context: { eventKind: "connectivity" },
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
}
