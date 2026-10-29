import { useMemo } from "react";
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
