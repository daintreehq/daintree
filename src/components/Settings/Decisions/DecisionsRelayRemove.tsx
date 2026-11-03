import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/Settings/SettingsGroup";
import type { SettingsTabClose } from "@/components/Settings/settingsTabClose";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { isRemovableRelayOrigin } from "@shared/config/relayRemoval";
import { DecisionsRemoveRelayDialog } from "./DecisionsRemoveRelayDialog";
import { openRelayRemoveTerminal } from "./relayRemove";
import { useGuidedTerminalPlacement } from "./useGuidedTerminalPlacement";

interface DecisionsRelayRemoveProps {
  /** The relay to remove: the one recorded here, or one a check just answered for. */
  relayOrigin: string;
  /** It's the relay recorded on this computer. */
  recorded: boolean;
  disabled: boolean;
  /** Closes Settings, then runs what's handed to it; absent outside the dialog. */
  onClose?: SettingsTabClose;
}

/**
 * "Remove relay" (#16202): takes the relay out of the user's Cloudflare
 * account through the CLI's guided removal, in a pane the user watches, for a
 * relay connected here, one claimed by someone else, or one never claimed.
 * Not offered in a Remote Hosts window, whose terminals run on the Host.
 */
export function DecisionsRelayRemove({
  relayOrigin,
  recorded,
  disabled,
  onClose,
}: DecisionsRelayRemoveProps) {
  const placement = useGuidedTerminalPlacement();
  const [confirming, setConfirming] = useState(false);
  const [deleteLocalHistory, setDeleteLocalHistory] = useState(false);
  const [starting, setStarting] = useState(false);

  if (isRemoteWindow()) return null;
  // A local development relay has no Cloudflare Worker to remove.
  const removable = isRemovableRelayOrigin(relayOrigin);

  const start = () => {
    if (!placement.ready || starting) return;
    const request = { origin: relayOrigin, deleteLocalHistory: recorded && deleteLocalHistory };
    const where = { cwd: placement.cwd, worktreeId: placement.worktreeId };
    setConfirming(false);
    const open = () => void openRelayRemoveTerminal(request, where);
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

  const reason = !removable
    ? "Only a relay on an https address in Cloudflare can be removed from here"
    : placement.ready || placement.reason === undefined
      ? undefined
      : "Open a project to watch the removal in a terminal";

  return (
    <>
      <SettingsRow
        id="decisions-relay-remove"
        label="Remove relay"
        description="Deletes the relay from your Cloudflare account, with everything it stores, through a guided removal in a terminal you watch. Paired phones stop working."
        disabled={disabled || !removable || !placement.ready || starting}
        disabledReason={reason}
        control={({ descriptionId, disabled: rowDisabled }) => (
          <Button
            variant="ghost-danger"
            size="sm"
            loading={starting}
            disabled={rowDisabled}
            aria-describedby={descriptionId}
            onClick={() => {
              setDeleteLocalHistory(false);
              setConfirming(true);
            }}
          >
            Remove relay…
          </Button>
        )}
      />
      <DecisionsRemoveRelayDialog
        isOpen={confirming}
        relayOrigin={relayOrigin}
        recorded={recorded}
        deleteLocalHistory={deleteLocalHistory}
        onDeleteLocalHistoryChange={setDeleteLocalHistory}
        onCancel={() => setConfirming(false)}
        onConfirm={start}
      />
    </>
  );
}
