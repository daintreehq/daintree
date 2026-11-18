import { useId } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { systemClient } from "@/clients/systemClient";
import { canDeleteMachines } from "@/components/Hosts/cloud/cloudHostLabels";
import { useNow } from "@/hooks/useNow";
import type { CloudWorktreeCleanupChoice } from "@shared/types/cloudHosts";
import type { HostId } from "@shared/types/remoteHosts";
import { cleanupChoiceCopy, type WorktreeCloudMachine } from "./worktreeCloudMachines";

/**
 * The machines made for a worktree, each with what happens to it when the
 * worktree is deleted: kept, stopped or deleted, each said in its provider's
 * terms. A machine with nothing to choose says why it is kept. Nothing is done
 * to any of them here: the choice rides the delete.
 *
 * A null choice is one that no longer holds (its machine or its provider's
 * offer changed), shown with nothing selected until the person picks again.
 */
export function WorktreeCloudMachineChoice({
  machines,
  choices,
  onChange,
  disabled,
  loadError,
  onRetryLoad,
}: {
  machines: readonly WorktreeCloudMachine[];
  choices: Readonly<Record<HostId, CloudWorktreeCleanupChoice | null>>;
  onChange: (hostId: HostId, choice: CloudWorktreeCleanupChoice) => void;
  disabled: boolean;
  /** The cloud picture couldn't be read, so any machine made for the worktree is kept. */
  loadError: string | null;
  onRetryLoad: () => void;
}) {
  const headingId = useId();
  const now = useNow(machines.length > 0);
  if (machines.length === 0) {
    return loadError === null ? null : (
      <Callout
        severity="warning"
        size="compact"
        data-testid="delete-worktree-cloud-machines-unread"
        action={
          <Button variant="outline" size="sm" onClick={onRetryLoad}>
            Retry
          </Button>
        }
      >
        Couldn&apos;t check for a cloud machine made for this worktree. Any there is kept.
      </Callout>
    );
  }
  return (
    <section aria-labelledby={headingId} data-testid="delete-worktree-cloud-machines">
      <span id={headingId} role="heading" aria-level={3} className={SECTION_LABEL_CLASS}>
        {machines.length === 1 ? "Its cloud machine" : "Its cloud machines"}
      </span>
      <div className="mt-2 space-y-3">
        {machines.map((machine) => {
          const hostId = machine.status.hostId;
          const chosen = hostId in choices ? choices[hostId] : "keep";
          const consoleUrl =
            machine.keptBecause === null && !canDeleteMachines(machine.provider)
              ? (machine.provider?.dashboardUrl ?? null)
              : null;
          return (
            <div key={hostId} className="space-y-2" data-testid="delete-worktree-cloud-machine">
              {machine.keptBecause !== null && chosen !== null ? (
                <p className="text-sm text-text-secondary">
                  {machine.keptBecause} {cleanupChoiceCopy(machine, "keep", now).description}
                </p>
              ) : (
                // A choice that stopped holding is chosen again here, Keep included,
                // even when Keep is all that's left.
                <RadioChoiceGroup
                  legend={`'${machine.name}' on ${machine.providerName} (${machine.status.accountName})`}
                >
                  {chosen === null && (
                    <p className="text-sm font-medium text-text-primary" role="status">
                      What can be done with it changed. Choose again.
                    </p>
                  )}
                  {machine.keptBecause !== null && (
                    <p className="text-sm text-text-secondary">{machine.keptBecause}</p>
                  )}
                  {machine.choices.map((choice) => {
                    const copy = cleanupChoiceCopy(machine, choice, now);
                    return (
                      <RadioChoiceRow
                        key={choice}
                        name={`delete-worktree-machine-${hostId}`}
                        value={choice}
                        checked={chosen === choice}
                        disabled={disabled}
                        onChange={() => onChange(hostId, choice)}
                        label={copy.label}
                        description={copy.description}
                        testId={`delete-worktree-machine-${choice}`}
                      />
                    );
                  })}
                </RadioChoiceGroup>
              )}
              {consoleUrl !== null && (
                <div className="space-y-2">
                  <p className="text-sm text-text-secondary">
                    {`Daintree can't delete machines on ${machine.providerName}. To delete it and stop paying for it, use ${machine.providerName}'s console.`}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void systemClient.openExternal(consoleUrl)}
                  >
                    <ExternalLink aria-hidden="true" />
                    Open {machine.providerName} console
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
