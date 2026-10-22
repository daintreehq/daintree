import { useEffect, useRef, useSyncExternalStore, type ComponentProps } from "react";
import { Download, Users } from "lucide-react";
import type { DriveLeaseView } from "@shared/types/ipc/driveLease";
import { Button } from "@/components/ui/button";
import { isRemoteWindow, isWslWindow, useHostPlatform } from "@/hooks/useHostPlatform";
import { saveHostFile, saveHostFileLabel, thisComputerName } from "@/services/hostFileSave";
import { getDriveLeaseSnapshot, subscribeDriveLeaseSnapshot } from "@/services/terminal/inputGate";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import type { RemoteFileContext } from "./FileUnavailableState";

/**
 * The ways out of a file a remote window can't show: take control of the
 * project, so the host serves this window its previews, or save a copy to
 * this computer. Shared by the file panel, the file browser and the diff
 * panel, so they offer the same thing in the same words.
 */

/** This view's drive lease, as the input gate holds it; null when it names another project. */
function useViewLease(): DriveLeaseView | null {
  const lease = useSyncExternalStore(
    subscribeDriveLeaseSnapshot,
    getDriveLeaseSnapshot,
    getDriveLeaseSnapshot
  );
  return lease !== null && lease.projectId === getViewWorkspaceId() ? lease : null;
}

/** Where this window's files are, when they're on a remote host; null for this machine's own. */
export function useRemoteFileContext(): RemoteFileContext | null {
  // Subscribed for the connection kind a WSL distro is told apart by.
  useHostPlatform();
  const hostName = useHostConnectionStore((state) => state.hostName ?? state.hostId);
  const lease = useViewLease();
  if (!isRemoteWindow()) return null;
  return {
    hostName: hostName ?? "the host",
    driverName: lease?.holder && !lease.drivingHere ? lease.holder.clientName : null,
    saveTarget: isWslWindow() ? null : thisComputerName(),
  };
}

/**
 * Load a preview again once this view has control, after the host refused it
 * to a watching window: the lease landing here is the signal, not a click.
 * A refusal that answers after control already landed retries too. Each lease
 * this view drives under earns one retry at most, so a host that still
 * refuses can't set off a loop.
 */
export function useRetryOnControl(refusedForControl: boolean, retry: () => void): void {
  const lease = useViewLease();
  const retriedUnder = useRef<DriveLeaseView | null>(null);
  useEffect(() => {
    if (!refusedForControl || !lease?.drivingHere || retriedUnder.current === lease) return;
    retriedUnder.current = lease;
    retry();
  }, [refusedForControl, lease, retry]);
}

function takeControlOfThisProject(): void {
  const projectId = getDriveLeaseSnapshot()?.projectId ?? getViewWorkspaceId();
  if (!projectId) return;
  // Loaded on use: the shared action reaches the panel store.
  void import("@/components/Recovery/takeControl").then(({ takeControl }) =>
    takeControl(projectId)
  );
}

type ActionButtonProps = Pick<ComponentProps<typeof Button>, "variant">;

export function TakeControlButton({ variant = "subtle" }: ActionButtonProps) {
  return (
    <Button variant={variant} size="sm" onClick={takeControlOfThisProject}>
      <Users />
      Take control
    </Button>
  );
}

export function SaveHostFileButton({
  hostPath,
  variant = "subtle",
}: ActionButtonProps & { hostPath: string }) {
  return (
    <Button variant={variant} size="sm" onClick={() => void saveHostFile(hostPath)}>
      <Download />
      {saveHostFileLabel()}
    </Button>
  );
}
