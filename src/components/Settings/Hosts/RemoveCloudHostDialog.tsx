import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineError } from "@/components/ui/field";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { clockTime, isObservationStale } from "@/components/Hosts/cloud/cloudHostLabels";
import { useNow } from "@/hooks/useNow";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import type { CloudHostStatus } from "@shared/types/cloudHosts";
import type { HostId } from "@shared/types/remoteHosts";

interface RemoveCloudHostDialogProps {
  hostId: HostId;
  name: string;
  /** Null while the cloud picture hasn't arrived: nothing can be decided yet. */
  status: CloudHostStatus | null;
  providerName: string;
  onClose: () => void;
  /** The host is gone from this device. */
  onRemoved?: () => void;
}

function errorText(err: unknown, fallback: string): string {
  return isClientAppError(err) && err.userMessage
    ? err.userMessage
    : clientErrorText(err, fallback);
}

/** What keeping the machine means, from what was last seen of it, and when that was if it's old. */
function keepDescription(status: CloudHostStatus, providerName: string, now: number): string {
  const said = keepState(status, providerName);
  if (status.machine === "unknown" || !isObservationStale(status, now)) return said;
  const at =
    status.observedAt !== null ? clockTime(new Date(status.observedAt).toISOString()) : null;
  return `${said} That's as of ${at ?? "the last check"}; it may have changed since.`;
}

function keepState(status: CloudHostStatus, providerName: string): string {
  const back = status.dataExpired ? "" : " You can add it back from Add host.";
  switch (status.machine) {
    case "running":
    case "starting":
      return `It's running and keeps billing ${status.accountName} until it stops${status.autoStopAt ? " by itself" : ` on ${providerName}`}.${back}`;
    case "stopping":
      return `It's stopping. Once stopped it stays in your account.${back}`;
    case "stopped":
      return status.dataExpired
        ? `It stays in your account, but ${providerName} has deleted its saved disk.`
        : `It stays stopped in your account.${back}`;
    default:
      return `Daintree can't tell whether it's running; check on ${providerName}, where it keeps billing while it runs.`;
  }
}

/**
 * Removing a cloud host asks what becomes of its machine: kept in the account
 * (and, if it runs, still billing until it stops), or deleted for good, which
 * needs the host's name typed. A host whose create never confirmed goes the
 * delete way, since that create may have made a machine; it needs the name
 * typed too. What the dialog decides on is fixed when it opens, so a create
 * landing meanwhile never turns a delete into a plain removal.
 */
export function RemoveCloudHostDialog({
  hostId,
  name,
  status,
  providerName,
  onClose,
  onRemoved,
}: RemoveCloudHostDialogProps) {
  const [choice, setChoice] = useState<"keep" | "delete">("keep");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(status !== null);
  // The machine this dialog is about, as it was when it first knew.
  const [openedFor, setOpenedFor] = useState(() =>
    status ? { resourceId: status.resourceId } : null
  );
  if (openedFor === null && status !== null) setOpenedFor({ resourceId: status.resourceId });
  const created = openedFor !== null && openedFor.resourceId !== null;
  const mayHaveMachine =
    openedFor !== null &&
    !created &&
    status !== null &&
    (status.operation?.kind === "creating" || status.lastError?.code === "outcome-unknown");
  const deleting = (created && choice === "delete") || mayHaveMachine;
  const ready = status !== null && openedFor !== null;

  const confirm = () => {
    if (!ready || openedFor === null) return;
    setBusy(true);
    setError(null);
    // Anything but a plain keep goes through deleteMachine, which names the
    // machine confirmed here and finds one an unanswered create may have made.
    const work =
      deleting || !created
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
          : "The host leaves your list."
      } Windows on it return to this machine, and its plugin permissions, history and browser data on this device are cleared.`}
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
        {ready && created && status && (
          <RadioChoiceGroup legend="Its machine">
            <RadioChoiceRow
              name="remove-cloud-host"
              value="keep"
              checked={!deleting}
              disabled={busy}
              onChange={() => setChoice("keep")}
              label={`Keep it on ${providerName}`}
              description={keepDescription(status, providerName, now)}
            />
            <RadioChoiceRow
              name="remove-cloud-host"
              value="delete"
              checked={deleting}
              disabled={busy}
              onChange={() => setChoice("delete")}
              label="Delete the machine too"
              description="Its disk goes for good; snapshots you saved yourself stay"
            />
          </RadioChoiceGroup>
        )}
        {ready && !created && !mayHaveMachine && (
          <p className="text-sm text-text-secondary">No machine was created for it.</p>
        )}
        {error && <InlineError role="alert">{error}</InlineError>}
      </div>
    </ConfirmDialog>
  );
}
