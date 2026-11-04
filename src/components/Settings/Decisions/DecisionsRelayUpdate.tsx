import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/Settings/SettingsGroup";
import type { SettingsTabClose } from "@/components/Settings/settingsTabClose";
import { SeverityMark } from "@/lib/statusSeverity";
import { useHomeDir } from "@/hooks/app/useHomeDir";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { selectViewProject, selectViewScratch } from "@/store/viewWorkspace";
import type { DecisionsRelayCompatibility } from "@shared/types/decisions";
import { relayNeedsUpdate, type RelayObservation } from "./relayCheckCopy";
import { openRelayUpdateTerminal } from "./relayUpdate";

/** Where the update's pane would go, or why it can't go anywhere this window shows. */
function useUpdatePlacement():
  { ready: true; cwd: string; worktreeId: string | undefined } | { ready: false; reason?: string } {
  const { homeDir } = useHomeDir();
  const hasProject = useProjectStore(
    (state) => selectViewProject(getViewWorkspaceId(), state) !== undefined
  );
  const hasScratch = useScratchStore(
    (state) => selectViewScratch(getViewWorkspaceId(), state) !== undefined
  );
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);

  if (!hasProject && !hasScratch) {
    return { ready: false, reason: "Open a project to watch the update in a terminal" };
  }
  // A project's grid shows one worktree's panes, so the pane waits until that's known.
  if (homeDir === undefined || (hasProject && activeWorktreeId === null)) return { ready: false };
  return { ready: true, cwd: homeDir, worktreeId: activeWorktreeId ?? undefined };
}

const KEEPS =
  "It keeps the relay's claim, paired devices, questions and answers, and settings. It needs Node.js 22 or later and signs you in to Cloudflare in your browser.";

/**
 * Update relay (#16201): the published CLI's guided update, against the
 * connected relay, in a pane the user watches. Prominent when the last check
 * found the relay behind this Daintree, and there to look for a newer
 * release otherwise. Settings closes first so the pane is in view; the CLI
 * shows the versions and asks before changing anything, and once the pane's
 * command ends, Connection checks the relay again and shows `outcome` here.
 * Only a local window renders this: a remote window's relay is the Host's.
 */
export function DecisionsRelayUpdate({
  origin,
  compatibility,
  running,
  outcome,
  disabled,
  onClose,
}: {
  origin: string;
  /** From the last check of this relay; without it, the update wouldn't know this Daintree's range. */
  compatibility: DecisionsRelayCompatibility | null;
  /** An update started from this window is still running, of this relay or another. */
  running: boolean;
  /** What the check after the latest update saw, once it has. */
  outcome: RelayObservation | null;
  disabled: boolean;
  /** Closes Settings, then runs what's handed to it; absent outside the dialog. */
  onClose?: SettingsTabClose;
}) {
  const placement = useUpdatePlacement();
  const [starting, setStarting] = useState(false);
  const behind = compatibility !== null && relayNeedsUpdate(compatibility);

  const disabledReason = running
    ? "An update is running in its terminal"
    : compatibility === null
      ? "Needs a check that reads the relay's version first"
      : placement.ready
        ? undefined
        : placement.reason;

  const startUpdate = () => {
    if (!placement.ready || starting || running || compatibility === null) return;
    const request = {
      cwd: placement.cwd,
      worktreeId: placement.worktreeId,
      origin,
      fromVersion: compatibility.relay.workerVersion,
      daintree: compatibility.daintree,
    };
    const open = () => void openRelayUpdateTerminal(request);
    if (!onClose) {
      open();
      return;
    }
    setStarting(true);
    // Settings goes first, so the pane is in view and keeps the focus it takes.
    // Reopened before it had gone, it starts nothing and can be asked again.
    onClose((closed) => (closed ? open() : setStarting(false))).then(
      (closing) => {
        if (!closing) setStarting(false);
      },
      () => setStarting(false)
    );
  };

  return (
    <>
      <SettingsRow
        id="decisions-relay-update"
        label="Update the relay"
        description={
          running
            ? "The update is running in its terminal. Settings checks the relay again when it ends."
            : behind
              ? `Runs the published decisions update in a terminal you watch. It shows the relay's version, the release that works with this Daintree and what changes, then asks before deploying it. ${KEEPS}`
              : `Looks for a newer release that works with this Daintree, in a terminal you watch. It shows what would change and asks before deploying it. ${KEEPS}`
        }
        disabled={disabled || starting || disabledReason !== undefined || !placement.ready}
        disabledReason={disabledReason}
        control={({ descriptionId, disabled: rowDisabled }) => (
          <Button
            variant={behind ? "contrast" : "outline"}
            size="sm"
            loading={starting}
            disabled={rowDisabled}
            aria-describedby={descriptionId}
            onClick={startUpdate}
          >
            Update relay
          </Button>
        )}
      />
      {outcome && (
        <SettingsRow
          id="decisions-relay-update-outcome"
          label={outcome.label}
          accessory={
            <SeverityMark
              severity={outcome.severity}
              label={outcome.label}
              className="h-3.5 w-3.5"
              decorative
            />
          }
          description={outcome.detail}
        />
      )}
    </>
  );
}
