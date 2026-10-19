import {
  SegmentedRadioGroup,
  type SegmentedRadioOption,
} from "@/components/ui/SegmentedRadioGroup";

type BranchMode = "new" | "existing";

// The section heading already says "Branch"; the names keep the noun for anyone
// who meets a segment without it.
const OPTIONS: SegmentedRadioOption<BranchMode>[] = [
  { value: "new", label: "New", ariaLabel: "New branch" },
  { value: "existing", label: "Existing", ariaLabel: "Existing branch" },
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
