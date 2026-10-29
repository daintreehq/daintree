import type { Ref } from "react";
import { Lock } from "lucide-react";
import { PaneState } from "@/components/ui/PaneState";
import { getAgentConfig } from "@/config/agents";
import { useLinkDownHost } from "@/hooks/useHostConnection";
import {
  useControlFacts,
  useDriveLeaseHolderAway,
  useDriveLeaseView,
} from "@/components/Recovery/driveLeaseState";
import { getDriveLeaseGateCopy } from "@/components/Recovery/recoveryCopy";
import { TakeControlOffer } from "@/components/Recovery/TakeControlOffer";

/**
 * What a pane shows while its launch waits for this window to have control of
 * the project (#13913): the host refuses to start it for a window that only
 * watches. Not a failure, so no error tone. It names who has control and that
 * the launch starts on its own once control arrives — never when, since an
 * away holder's control may pass to another window — and offers it here,
 * where the launch was asked for. While the host's link is down, that is
 * what it waits for first, and there is nothing to take.
 */
export function DriveLeaseGate({
  agentId,
  panelId,
  containerRef,
}: {
  agentId?: string;
  /** The pane, so the keyboard comes back to it once control lands. */
  panelId?: string;
  /** Where the pane's focus handler lands keyboard navigation into the gate. */
  containerRef?: Ref<HTMLDivElement>;
}) {
  const subject = agentId ? (getAgentConfig(agentId)?.name ?? agentId) : "The terminal";
  const linkDownHost = useLinkDownHost();
  const facts = useControlFacts();
  const away = useDriveLeaseHolderAway();
  const projectId = useDriveLeaseView()?.projectId ?? null;
  const copy = getDriveLeaseGateCopy(subject, facts, away, linkDownHost);
  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="relative flex-1 min-h-0 focus-visible:-outline-offset-2"
    >
      <PaneState
        icon={<Lock className="text-text-secondary" />}
        title={copy.title}
        description={copy.description}
        // Who has control, and the link, are the window's to announce, once.
        live="off"
      >
        {linkDownHost === null && facts !== null && projectId !== null && (
          <TakeControlOffer projectId={projectId} facts={facts} panelId={panelId} />
        )}
      </PaneState>
    </div>
  );
}
