import { useId } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
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
 */
export function WorktreeCloudMachineChoice({
  machines,
  choices,
  onChange,
  disabled,
}: {
  machines: readonly WorktreeCloudMachine[];
  choices: Readonly<Record<HostId, CloudWorktreeCleanupChoice>>;
  onChange: (hostId: HostId, choice: CloudWorktreeCleanupChoice) => void;
  disabled: boolean;
}) {
  const headingId = useId();
  const now = useNow(machines.length > 0);
  if (machines.length === 0) return null;
  return (
    <section aria-labelledby={headingId} data-testid="delete-worktree-cloud-machines">
      <span id={headingId} role="heading" aria-level={3} className={SECTION_LABEL_CLASS}>
        {machines.length === 1 ? "Its cloud machine" : "Its cloud machines"}
      </span>
      <div className="mt-2 space-y-3">
        {machines.map((machine) => {
          const hostId = machine.status.hostId;
          const chosen = choices[hostId] ?? "keep";
          const consoleUrl =
            machine.keptBecause === null && !canDeleteMachines(machine.provider)
              ? (machine.provider?.dashboardUrl ?? null)
              : null;
          return (
            <div key={hostId} className="space-y-2" data-testid="delete-worktree-cloud-machine">
              {machine.keptBecause !== null ? (
                <p className="text-sm text-text-secondary">
                  {machine.keptBecause} {cleanupChoiceCopy(machine, "keep", now).description}
                </p>
              ) : (
                <RadioChoiceGroup
                  legend={`'${machine.name}' on ${machine.providerName} (${machine.status.accountName})`}
                >
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
