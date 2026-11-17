import { useState } from "react";
import { Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { useHostList } from "@/components/Hosts/hostList";
import {
  cancelPlacement,
  placementForWorktree,
  retryPlacementSetup,
} from "@/components/Hosts/pendingPlacement";
import { getViewHostId } from "@/hooks/useHostConnection";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/store/projectStore";
import { clientErrorText } from "@/utils/clientAppError";
import { useCardFocusHandoff } from "./hooks/useCardFocusHandoff";

interface PendingPlacementNoticeProps {
  worktreeId: string;
  /** The sidebar card keeps its notices inside its own gutter. */
  inGutter: boolean;
}

/**
 * A worktree waiting for a host's setup to finish before it opens there: the
 * host it waits on, why the last setup attempt stopped, and the way on (set up
 * or retry) or out (cancel). Nothing when it waits on none.
 */
export function PendingPlacementNotice({ worktreeId, inGutter }: PendingPlacementNoticeProps) {
  const { hosts } = useHostList();
  const projectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // Cancel removes this notice from under the button that was pressed.
  const focusHandoffRef = useCardFocusHandoff<HTMLDivElement>();
  // A window on another host shows that host's worktrees, never one waiting here.
  const found = getViewHostId() === null ? placementForWorktree(hosts, projectId, worktreeId) : null;
  if (!found) return null;

  const hostId = found.host.descriptor.id;
  const hostName = found.host.descriptor.name;
  const failure = found.placement.failure ?? null;

  const handleSetUp = (event: React.MouseEvent) => {
    event.stopPropagation();
    retryPlacementSetup(hostId);
  };
  const handleCancel = (event: React.MouseEvent) => {
    event.stopPropagation();
    setCancelError(null);
    cancelPlacement(hostId).catch((err: unknown) =>
      setCancelError(clientErrorText(err, "Couldn't cancel"))
    );
  };

  return (
    <div data-card-control="" className={cn(inGutter && "px-3 pb-2.5")}>
      <Callout
        severity={failure ? "error" : "neutral"}
        icon={failure ? undefined : Server}
        size="compact"
        ref={focusHandoffRef}
        role={failure ? "alert" : "status"}
        data-testid="worktree-pending-placement"
        title={failure ? `Couldn't set up ${hostName}` : `Opens on ${hostName} after setup`}
        // Above the sidebar's full-card select overlay, like the card's other notices (#12087).
        className="relative z-10 mt-2"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="break-words text-text-secondary select-text">
            {failure
              ? failure.message
              : "It waits for Daintree to be installed and Host mode turned on there."}
          </span>
          {cancelError && <span className="text-text-primary">{cancelError}</span>}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="xs"
              onClick={handleSetUp}
              className="shadow-none inset-shadow-none"
            >
              {failure ? "Retry" : "Set up…"}
            </Button>
            <Button variant="ghost" size="xs" onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        </div>
      </Callout>
    </div>
  );
}
