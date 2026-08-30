import { useMemo } from "react";
import {
  SegmentedRadioGroup,
  type SegmentedRadioOption,
} from "@/components/ui/SegmentedRadioGroup";

interface EnvironmentRadioGroupProps {
  worktreeMode: string;
  onChange: (mode: string) => void;
  resourceEnvironments: Record<string, unknown> | undefined;
  hasAnyEnvironments: boolean;
  disabled?: boolean;
}

/** Control only — "Environment" lives on the form's label rail. */
export function EnvironmentRadioGroup({
  worktreeMode,
  onChange,
  resourceEnvironments,
  hasAnyEnvironments,
  disabled,
}: EnvironmentRadioGroupProps) {
  const options = useMemo<SegmentedRadioOption<string>[]>(
    () => [
      { value: "local", label: "Local" },
      ...Object.keys(resourceEnvironments ?? {}).map((key) => ({ value: key, label: key })),
    ],
    [resourceEnvironments]
  );

  if (!hasAnyEnvironments) return null;

  return (
    <div className="space-y-1.5">
      <SegmentedRadioGroup
        options={options}
        value={worktreeMode}
        onChange={onChange}
        aria-label="Environment"
        disabled={disabled}
      />
      {worktreeMode !== "local" && (
        <p className="text-xs text-text-secondary">
          Provisions the {worktreeMode} environment after setup
        </p>
      )}
    </div>
  );
}
