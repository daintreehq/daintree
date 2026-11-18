import { useId, useMemo } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  SegmentedRadioGroup,
  type SegmentedRadioOption,
} from "@/components/ui/SegmentedRadioGroup";
import { usableEnvironmentKeys } from "@/lib/resourceEnvironments";

interface EnvironmentRadioGroupProps {
  worktreeMode: string;
  onChange: (mode: string) => void;
  resourceEnvironments: Record<string, unknown> | undefined;
  hasAnyEnvironments: boolean;
  /** Id of the hint under the row while it shows — see `EnvironmentHint`. */
  describedBy?: string;
  disabled?: boolean;
}

/** Control only — "Environment" lives on the form's label rail. */
export function EnvironmentRadioGroup({
  worktreeMode,
  onChange,
  resourceEnvironments,
  hasAnyEnvironments,
  describedBy,
  disabled,
}: EnvironmentRadioGroupProps) {
  const options = useMemo<SegmentedRadioOption<string>[]>(
    () => [
      { value: "local", label: "Local" },
      ...usableEnvironmentKeys(resourceEnvironments).map((key) => ({ value: key, label: key })),
    ],
    [resourceEnvironments]
  );

  if (!hasAnyEnvironments) return null;

  return (
    <SegmentedRadioGroup
      options={options}
      value={worktreeMode}
      onChange={onChange}
      aria-label="Environment"
      aria-describedby={describedBy}
      disabled={disabled}
    />
  );
}

/**
 * What a non-local choice does, on the row's hint rail rather than in the
 * control cell — inside, it pulled the "Environment" label below the pills.
 * Keeps the id the group's `aria-describedby` points at.
 */
export function EnvironmentHint({ worktreeMode }: { worktreeMode: string }) {
  if (worktreeMode === "local") return null;
  return (
    <p id="environment-hint" className="text-xs text-text-secondary">
      Provisions the {worktreeMode} environment after setup
    </p>
  );
}

interface OpenOnMachineToggleProps {
  worktreeMode: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/**
 * The Environment row's option to carry the new worktree onto the machine its
 * environment provisions. A checkbox, not a switch: like the rest of the form
 * it takes effect at Create. Checked, it names every step the Create bundles.
 */
export function OpenOnMachineToggle({
  worktreeMode,
  checked,
  onCheckedChange,
}: OpenOnMachineToggleProps) {
  const detailId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-text-secondary hover:text-text-primary">
        <Checkbox
          checked={checked}
          onCheckedChange={(value) => onCheckedChange(value === true)}
          aria-describedby={checked ? detailId : undefined}
          data-testid="open-on-machine"
        />
        <span>Open on its machine</span>
      </label>
      {checked && (
        <p
          id={detailId}
          className="text-xs text-balance text-text-secondary"
          data-testid="open-on-machine-detail"
        >
          Once {worktreeMode}&apos;s status names its ssh machine, this branch opens there. If the
          machine isn&apos;t in your host list, it&apos;s added for this worktree and removed with
          it. If Daintree isn&apos;t running there, Host setup opens to install and start it first.
          The recipe and agent don&apos;t start on this machine.
        </p>
      )}
    </div>
  );
}
