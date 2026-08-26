import { SegmentedRadioGroup, type SegmentedRadioOption } from "./SegmentedRadioGroup";

type BranchMode = "new" | "existing";

const OPTIONS: SegmentedRadioOption<BranchMode>[] = [
  { value: "new", label: "New branch" },
  { value: "existing", label: "Existing branch" },
];

interface BranchModeControlProps {
  branchMode: BranchMode;
  onChange: (mode: BranchMode) => void;
  disabled?: boolean;
}

/** Sits on the Branch section header rather than claiming a row of its own. */
export function BranchModeControl({ branchMode, onChange, disabled }: BranchModeControlProps) {
  return (
    <SegmentedRadioGroup
      options={OPTIONS}
      value={branchMode}
      onChange={onChange}
      aria-label="Branch mode"
      disabled={disabled}
    />
  );
}
