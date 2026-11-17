import { useState, type MouseEvent } from "react";
import { Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { CancelCloudPlacementDialog } from "@/components/Hosts/CancelCloudPlacementDialog";
import { canDeleteMachines, cloudProviderFor } from "@/components/Hosts/cloud/cloudHostLabels";
import { cloudStatusFor, useCloudHosts } from "@/components/Hosts/cloud/cloudHostsState";
import { armCloudSetup, cloudPlacementStage } from "@/components/Hosts/cloudWorktreePlacement";
import {
  holdPlacement,
  isUsableConnection,
  retryPlacementSetup,
} from "@/components/Hosts/pendingPlacement";
import {
  openHostsSettingsTab,
  requestHostSettings,
} from "@/components/Settings/Hosts/hostSettingsRequests";
import { cn } from "@/lib/utils";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import type { CloudOperationKind } from "@shared/types/cloudHosts";
import type { HostConnectionState, HostId, PendingHostPlacement } from "@shared/types/remoteHosts";
import { useCardFocusHandoff } from "./hooks/useCardFocusHandoff";

export interface CloudPlacementNoticeProps {
  hostId: HostId;
  hostName: string;
  connection: HostConnectionState;
  placement: PendingHostPlacement;
  /** The sidebar card keeps its notices inside its own gutter. */
  inGutter: boolean;
}

const BUSY_TITLE: Record<CloudOperationKind, string> = {
  creating: "Creating",
  starting: "Starting",
  stopping: "Stopping",
  deleting: "Deleting",
};

function errorText(err: unknown, fallback: string): string {
  return isClientAppError(err) && err.userMessage
    ? err.userMessage
    : clientErrorText(err, fallback);
}

/**
 * A worktree waiting on the machine made for it: the machine coming up, its
 * setup, or what stopped either, with the way on (Retry, Set up…) and the
 * ways out (Cancel, which offers to delete the machine, and Delete).
 */
export function CloudPlacementNotice({
  hostId,
  hostName,
  connection,
  placement,
  inGutter,
}: CloudPlacementNoticeProps) {
  const { snapshot } = useCloudHosts();
  const status = cloudStatusFor(snapshot, hostId);
  const provider = cloudProviderFor(snapshot.providers, status);
  const stage = cloudPlacementStage(status, placement);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<"keep" | "delete" | null>(null);
  // Cancel removes this notice from under the button that was pressed.
  const focusHandoffRef = useCardFocusHandoff<HTMLDivElement>();
  const usable = isUsableConnection(connection);
  const deletable = status !== null && canDeleteMachines(provider);

  const run = (event: MouseEvent, work: () => Promise<unknown> | void, fallback: string) => {
    event.stopPropagation();
    setActionError(null);
    Promise.resolve()
      .then(work)
      .catch((err: unknown) => setActionError(errorText(err, fallback)));
  };

  const retry = (event: MouseEvent) => {
    if (stage.kind === "create-failed") {
      run(
        event,
        () => {
          // Asked from here, so its setup opens here once the machine runs.
          armCloudSetup(hostId, placement.requestedAt);
          return cloudHostsClient.retryCreate(hostId);
        },
        "Couldn't create the machine"
      );
      return;
    }
    // A host already usable needs no setup: the placement asked again carries on at once.
    run(
      event,
      () => {
        if (!usable) {
          retryPlacementSetup(hostId);
          return;
        }
        const { requestedAt: _at, failure: _failure, ...request } = placement;
        return holdPlacement(hostId, request);
      },
      "Couldn't retry"
    );
  };
  const setUp = (event: MouseEvent) =>
    run(event, () => retryPlacementSetup(hostId), "Couldn't open setup");
  const details = (event: MouseEvent) =>
    run(
      event,
      () => {
        requestHostSettings({ kind: "detail", hostId });
        openHostsSettingsTab();
      },
      "Couldn't open the host"
    );
  const openCancel = (event: MouseEvent, choice: "keep" | "delete") => {
    event.stopPropagation();
    setCancelling(choice);
  };

  const failedKind =
    stage.kind === "create-failed" || stage.kind === "machine" || stage.kind === "failed";
  let title: string;
  let body: string;
  switch (stage.kind) {
    case "busy":
      title = `${BUSY_TITLE[stage.operation]} ${hostName}`;
      body = `${stage.step}. ${placement.label} opens there once Daintree is set up on it.`;
      break;
    case "create-failed":
      title = `Couldn't create ${hostName}`;
      body = stage.message;
      break;
    case "machine":
      title = `${hostName} isn't running`;
      body = stage.message;
      break;
    case "failed":
      title = usable ? `Didn't open on ${hostName}` : `Couldn't set up ${hostName}`;
      body = stage.message;
      break;
    case "setup":
      title = `Opens on ${hostName} after setup`;
      body = "Its machine is running. It opens there once Daintree is set up and connected.";
      break;
    default:
      title = `Opens on ${hostName} after setup`;
      body = "It opens there once its machine runs and Daintree is set up.";
  }

  return (
    <div data-card-control="" className={cn(inGutter && "px-3 pb-2.5")}>
      <Callout
        severity={failedKind ? "error" : "neutral"}
        icon={failedKind ? undefined : Server}
        size="compact"
        ref={focusHandoffRef}
        role={failedKind ? "alert" : "status"}
        data-testid="worktree-pending-placement"
        data-stage={stage.kind}
        title={title}
        // Above the sidebar's full-card select overlay, like the card's other notices (#12087).
        className="relative z-10 mt-2"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="break-words text-text-secondary select-text">{body}</span>
          {actionError && <span className="text-text-primary">{actionError}</span>}
          <div className="flex flex-wrap items-center gap-2">
            {(stage.kind === "create-failed" || stage.kind === "failed") && (
              <Button
                variant="outline"
                size="xs"
                onClick={retry}
                className="shadow-none inset-shadow-none"
              >
                Retry
              </Button>
            )}
            {stage.kind === "setup" && (
              <Button
                variant="outline"
                size="xs"
                onClick={setUp}
                className="shadow-none inset-shadow-none"
              >
                Set up…
              </Button>
            )}
            {stage.kind === "machine" && (
              <Button
                variant="outline"
                size="xs"
                onClick={details}
                className="shadow-none inset-shadow-none"
              >
                Details…
              </Button>
            )}
            {failedKind && deletable && (
              <Button variant="ghost-danger" size="xs" onClick={(e) => openCancel(e, "delete")}>
                Delete machine…
              </Button>
            )}
            <Button variant="ghost" size="xs" onClick={(e) => openCancel(e, "keep")}>
              Cancel
            </Button>
          </div>
        </div>
      </Callout>
      {cancelling && (
        <CancelCloudPlacementDialog
          hostId={hostId}
          hostName={hostName}
          label={placement.label}
          status={status}
          provider={provider}
          initialChoice={cancelling}
          onClose={() => setCancelling(null)}
        />
      )}
    </div>
  );
}

export default CloudPlacementNotice;
