import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineError } from "@/components/ui/field";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { systemClient } from "@/clients/systemClient";
import {
  billsWhileStopped,
  canDeleteMachines,
  isObservationStale,
  keepMachineDescription,
} from "@/components/Hosts/cloud/cloudHostLabels";
import { useNow } from "@/hooks/useNow";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import type { CloudHostStatus, CloudProviderInfo } from "@shared/types/cloudHosts";
import type { HostId } from "@shared/types/remoteHosts";
import { removeHostOutcome } from "./hostLabels";

interface RemoveCloudHostDialogProps {
  hostId: HostId;
  name: string;
  /** Null while the cloud picture hasn't arrived: nothing can be decided yet. */
  status: CloudHostStatus | null;
  providerName: string;
  /** What its provider declares; null while that provider isn't registered. */
  provider: Pick<CloudProviderInfo, "name" | "capabilities" | "dashboardUrl"> | null;
  /**
   * Daintree on the machine was last seen started on connect: removing the
   * host stops it there, unless the machine goes with it.
   */
  startsOnConnect?: boolean;
  onClose: () => void;
  /** The host is gone from this device. */
  onRemoved?: () => void;
}

function errorText(err: unknown, fallback: string): string {
  return isClientAppError(err) && err.userMessage
    ? err.userMessage
    : clientErrorText(err, fallback);
}

/**
 * Removing a cloud host asks what becomes of its machine: kept in the account
 * (and, if it runs, still billing until it stops), or deleted for good, which
 * needs the host's name typed. A host whose create never confirmed goes the
 * delete way, since that create may have made a machine; it needs the name
 * typed too. What the dialog decides on is fixed when it opens, so a create
 * landing meanwhile never turns a delete into a plain removal.
 *
 * A provider that declares Daintree can't delete its machines is offered no
 * Delete: removing the host only forgets it here, and the dialog says the
 * machine is deleted in that provider's console, with a link to it.
 */
export function RemoveCloudHostDialog({
  hostId,
  name,
  startsOnConnect = false,
  status,
  providerName,
  provider,
  onClose,
  onRemoved,
}: RemoveCloudHostDialogProps) {
  const [choice, setChoice] = useState<"keep" | "delete">("keep");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(status !== null);
  // The machine this dialog is about, as it was when it first knew, with
  // whether it could be deleted then. A provider registered since as unable to
  // delete takes that away; nothing gives it back. Main refuses such a delete too.
  const [openedFor, setOpenedFor] = useState(() =>
    status ? { resourceId: status.resourceId, deletable: canDeleteMachines(provider) } : null
  );
  if (openedFor === null && status !== null) {
    setOpenedFor({ resourceId: status.resourceId, deletable: canDeleteMachines(provider) });
  }
  const deletable = (openedFor?.deletable ?? true) && canDeleteMachines(provider);
  const created = openedFor !== null && openedFor.resourceId !== null;
  const mayHaveMachine =
    openedFor !== null &&
    !created &&
    status !== null &&
    (status.operation?.kind === "creating" || status.lastError?.code === "outcome-unknown");
  // A create that landed while this was open: a machine the opening never named.
  const appeared = openedFor !== null && !created && status !== null && status.resourceId !== null;
  const deleting = deletable && ((created && choice === "delete") || mayHaveMachine);
  const billedStopped = billsWhileStopped(provider);
  const storageBilled = provider?.capabilities.persistence.stoppedStorageBilled === true;
  const ready = status !== null && openedFor !== null;
  // Only a provider without deletion: its machine is deleted, if at all, in its
  // own console, and is claimed to exist only from a fresh reading.
  const machineGone = status?.machine === "deleted";
  const machineSeen =
    status !== null &&
    status.machine !== "unknown" &&
    !isObservationStale({ ...status, operation: null }, now);
  const consoleUrl =
    ready && !deletable && provider && !machineGone && (created || mayHaveMachine || appeared)
      ? provider.dashboardUrl
      : null;
  // A machine made for a worktree is expected to go with it; removing the host
  // by hand leaves it in the account, so the dialog names what stays. Its
  // existence is claimed only from a fresh reading: an unknown or old one may
  // predate a delete made on the provider. Its age counts even mid-operation,
  // when reads may be failing while the operation waits.
  const keptMachine =
    ready && created && !deleting && status.createdFor !== null && status.machine !== "deleted"
      ? {
          name: status.machineName ?? openedFor.resourceId,
          seen:
            status.machine !== "unknown" &&
            !isObservationStale({ ...status, operation: null }, now),
        }
      : null;

  const confirm = () => {
    if (!ready || openedFor === null) return;
    setBusy(true);
    setError(null);
    // Anything but a plain keep goes through deleteMachine, which names the
    // machine confirmed here and finds one an unanswered create may have made.
    // A provider without deletion is only ever forgotten here.
    const work =
      deletable && (deleting || !created)
        ? cloudHostsClient.deleteMachine(hostId, openedFor.resourceId)
        : remoteHostsClient.forget(hostId);
    work.then(
      () => {
        setBusy(false);
        onRemoved?.();
        onClose();
      },
      (err: unknown) => {
        setBusy(false);
        setError(
          errorText(err, deleting ? "Couldn't delete the machine" : "Couldn't remove the host")
        );
      }
    );
  };

  return (
    <ConfirmDialog
      isOpen
      onClose={onClose}
      variant="destructive"
      title={deleting && created ? `Delete '${name}'?` : `Remove '${name}'?`}
      description={`${
        deleting && created
          ? `Its machine and everything on its disk are deleted from ${providerName}, and the host leaves your list.`
          : keptMachine !== null && status
            ? keptMachine.seen
              ? `The host leaves your list, but its machine '${keptMachine.name}' still exists in your ${providerName} account (${status.accountName}).`
              : `The host leaves your list, but removing it doesn't delete its machine '${keptMachine.name}' from your ${providerName} account (${status.accountName}).`
            : !deletable && (created || appeared) && !machineGone
              ? machineSeen && created
                ? `The host leaves your list, but its machine stays in your ${providerName} account.`
                : `The host leaves your list, but removing it doesn't delete its machine from your ${providerName} account.`
              : "The host leaves your list."
      } Windows on it return to this machine, and its plugin permissions, history and browser data on this device are cleared.${
        startsOnConnect && !deleting ? ` ${removeHostOutcome(undefined, name, true).sentence}` : ""
      }`}
      confirmLabel={deleting ? "Delete machine" : "Remove host"}
      onConfirm={confirm}
      confirmDisabled={!ready}
      isConfirmLoading={busy}
      typedNameTarget={deleting ? name : undefined}
      typedNamePreamble={
        deleting
          ? mayHaveMachine
            ? `If ${providerName} made a machine for it, that machine and its disk are deleted for good.`
            : `The machine and everything on its disk are deleted from ${providerName} for good.`
          : undefined
      }
    >
      <div className="space-y-3" data-testid="remove-cloud-host-choice">
        {!ready && <p className="text-sm text-text-secondary">Reading the machine&apos;s state…</p>}
        {ready && created && status && !deletable && !machineGone && (
          <p className="text-sm text-text-secondary">
            {keepMachineDescription(status, providerName, billedStopped, storageBilled, now, true)}
          </p>
        )}
        {ready && created && status && deletable && (
          <RadioChoiceGroup legend="Its machine">
            <RadioChoiceRow
              name="remove-cloud-host"
              value="keep"
              checked={!deleting}
              disabled={busy}
              onChange={() => setChoice("keep")}
              label={`Keep it on ${providerName}`}
              description={keepMachineDescription(
                status,
                providerName,
                billedStopped,
                storageBilled,
                now,
                true
              )}
            />
            <RadioChoiceRow
              name="remove-cloud-host"
              value="delete"
              checked={deleting}
              disabled={busy}
              onChange={() => setChoice("delete")}
              label="Delete the machine too"
              description="Its disk goes for good"
            />
          </RadioChoiceGroup>
        )}
        {ready && !created && !mayHaveMachine && !appeared && (
          <p className="text-sm text-text-secondary">No machine was created for it.</p>
        )}
        {ready && !created && (mayHaveMachine || appeared) && !deletable && (
          <p className="text-sm text-text-secondary">
            {appeared
              ? `${providerName} made a machine for it while this was open, and removing the host doesn't delete it.`
              : `${providerName} hasn't confirmed whether it made a machine for it, and removing the host doesn't delete one.`}
          </p>
        )}
        {consoleUrl !== null && (
          <div className="space-y-2" data-testid="remove-cloud-host-console">
            <p className="text-sm text-text-secondary">
              {`Daintree can't delete machines on ${providerName}. To delete it and stop paying for it, use ${providerName}'s console.`}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void systemClient.openExternal(consoleUrl)}
            >
              <ExternalLink aria-hidden="true" />
              Open {providerName} console
            </Button>
          </div>
        )}
        {error && <InlineError role="alert">{error}</InlineError>}
      </div>
    </ConfirmDialog>
  );
}
