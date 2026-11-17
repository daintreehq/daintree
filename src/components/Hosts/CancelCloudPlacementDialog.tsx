import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineError } from "@/components/ui/field";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { systemClient } from "@/clients/systemClient";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import type { CloudHostStatus, CloudProviderInfo } from "@shared/types/cloudHosts";
import type { HostId } from "@shared/types/remoteHosts";
import { billsWhileStopped, canDeleteMachines } from "./cloud/cloudHostLabels";
import { disarmCloudSetup } from "./cloudWorktreePlacement";
import { cancelPlacement } from "./pendingPlacement";

interface CancelCloudPlacementDialogProps {
  hostId: HostId;
  hostName: string;
  /** The waiting worktree, as its placement names it. */
  label: string;
  /** Null while the cloud picture hasn't arrived: nothing can be decided yet. */
  status: CloudHostStatus | null;
  provider: Pick<CloudProviderInfo, "name" | "capabilities" | "dashboardUrl"> | null;
  /** Which way the dialog opens: from Cancel, keeping the machine; from Delete, deleting it. */
  initialChoice: "keep" | "delete";
  onClose: () => void;
}

function errorText(err: unknown, fallback: string): string {
  return isClientAppError(err) && err.userMessage
    ? err.userMessage
    : clientErrorText(err, fallback);
}

/**
 * Stop waiting to open a worktree on the machine made for it, and say what
 * becomes of that machine: kept (still listed, still marked, still billing
 * while it runs) or deleted for good, which needs the host's name typed as
 * Settings → Hosts' delete does. The machine it is about is fixed when the
 * dialog opens, so a create landing meanwhile is still the one confirmed.
 * The worktree stays on this machine either way.
 */
export function CancelCloudPlacementDialog({
  hostId,
  hostName,
  label,
  status,
  provider,
  initialChoice,
  onClose,
}: CancelCloudPlacementDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deletable = canDeleteMachines(provider);
  const [choice, setChoice] = useState<"keep" | "delete">(deletable ? initialChoice : "keep");
  const [openedFor, setOpenedFor] = useState(() =>
    status ? { resourceId: status.resourceId } : null
  );
  if (openedFor === null && status !== null) setOpenedFor({ resourceId: status.resourceId });
  const ready = status !== null && openedFor !== null;
  const deleting = deletable && choice === "delete";
  const providerName = provider?.name ?? "its provider";
  const accountName = status?.accountName ?? "its account";
  const created = openedFor?.resourceId != null;

  const keepSentence = !created
    ? `It stays in your host list, marked as made for ${label}. A machine its create makes bills ${accountName} while it runs.`
    : billsWhileStopped(provider)
      ? `It stays in your host list, marked as made for ${label}, and bills ${accountName} until it's deleted, even once it stops.`
      : `It stays in your host list, marked as made for ${label}, and bills ${accountName} while it runs.`;

  const confirm = () => {
    if (!ready || openedFor === null) return;
    setBusy(true);
    setError(null);
    // Nothing here opens its setup any more, whichever way this goes.
    disarmCloudSetup(hostId);
    const work = deleting
      ? cloudHostsClient.deleteMachine(hostId, openedFor.resourceId)
      : cancelPlacement(hostId);
    work.then(
      () => {
        setBusy(false);
        onClose();
      },
      (err: unknown) => {
        setBusy(false);
        setError(errorText(err, deleting ? "Couldn't delete the machine" : "Couldn't cancel"));
      }
    );
  };

  return (
    <ConfirmDialog
      isOpen
      onClose={onClose}
      variant="destructive"
      title={deleting ? `Delete '${hostName}'?` : `Stop opening '${label}' on ${hostName}?`}
      description={
        deleting
          ? `Its machine and everything on its disk are deleted from ${providerName}, and the host leaves your list. ${label} stays on this machine.`
          : `${label} stays on this machine.`
      }
      confirmLabel={deleting ? "Delete machine" : "Stop opening"}
      cancelLabel="Back"
      onConfirm={confirm}
      confirmDisabled={!ready}
      isConfirmLoading={busy}
      typedNameTarget={deleting ? hostName : undefined}
      typedNamePreamble={
        deleting
          ? created
            ? `The machine and everything on its disk are deleted from ${providerName} for good.`
            : `If ${providerName} made a machine for it, that machine and its disk are deleted for good.`
          : undefined
      }
    >
      <div className="space-y-3" data-testid="cancel-cloud-placement-choice">
        {!ready && <p className="text-sm text-text-secondary">Reading the machine&apos;s state…</p>}
        {ready && deletable && (
          <RadioChoiceGroup legend="Its machine">
            <RadioChoiceRow
              name="cancel-cloud-placement"
              value="keep"
              checked={!deleting}
              disabled={busy}
              onChange={() => setChoice("keep")}
              label={`Keep it on ${providerName}`}
              description={keepSentence}
            />
            <RadioChoiceRow
              name="cancel-cloud-placement"
              value="delete"
              checked={deleting}
              disabled={busy}
              onChange={() => setChoice("delete")}
              label="Delete the machine"
              description="Its disk goes for good"
            />
          </RadioChoiceGroup>
        )}
        {ready && !deletable && (
          <div className="space-y-2" data-testid="cancel-cloud-placement-console">
            <p className="text-sm text-text-secondary">{keepSentence}</p>
            {provider?.dashboardUrl && (
              <>
                <p className="text-sm text-text-secondary">
                  {`Daintree can't delete machines on ${providerName}. To delete it and stop paying for it, use ${providerName}'s console.`}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void systemClient.openExternal(provider.dashboardUrl)}
                >
                  <ExternalLink aria-hidden="true" />
                  Open {providerName} console
                </Button>
              </>
            )}
          </div>
        )}
        {error && <InlineError role="alert">{error}</InlineError>}
      </div>
    </ConfirmDialog>
  );
}
