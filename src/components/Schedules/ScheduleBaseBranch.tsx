import { useEffect, useMemo, useState } from "react";
import { SETTINGS_CONTROL_WIDTH, SettingsRow } from "@/components/Settings/SettingsGroup";
import { BaseBranchCombobox } from "@/components/Worktree/views/BaseBranchCombobox";
import { useBranchPicker } from "@/components/Worktree/hooks/useBranchPicker";
import type { BranchWorktreeRef } from "@/components/Worktree/branchPickerUtils";
import { worktreeClient } from "@/clients/worktreeClient";
import { useProjectStore } from "@/store/projectStore";
import type { BranchInfo } from "@/types/electron";
import type { ScheduleNewWorktree } from "@shared/types/scheduledRuns";
import { logError } from "@/utils/logger";

const NO_RECENT_BRANCHES: readonly string[] = [];
const NO_BRANCH_WORKTREES: ReadonlyMap<string, BranchWorktreeRef> = new Map();

/**
 * The base a new-worktree schedule branches each run from (#16369). Mounted only
 * while that mode is chosen, so a schedule without it reads no branches. A stored
 * base the project no longer has says so, rather than reading as another one.
 */
export function ScheduleBaseBranch({
  id,
  baseBranch,
  error,
  onChange,
}: {
  id: string;
  baseBranch: string;
  error?: string;
  onChange: (base: ScheduleNewWorktree) => void;
}) {
  const rootPath = useProjectStore((state) => state.currentProject?.path);
  const [branches, setBranches] = useState<readonly BranchInfo[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!rootPath) return;
    let current = true;
    worktreeClient
      .listBranches(rootPath)
      .then((listed) => {
        if (!current) return;
        setBranches(listed);
        setLoadFailed(false);
      })
      .catch((reason: unknown) => {
        if (!current) return;
        logError("Failed to list branches for a schedule", reason);
        setLoadFailed(true);
      });
    return () => {
      current = false;
    };
  }, [rootPath]);

  const list = useMemo(() => branches ?? [], [branches]);
  const controller = useBranchPicker({
    branches: list,
    selectedBranch: baseBranch || null,
    recentBranchNames: NO_RECENT_BRANCHES,
    worktreeByBranch: NO_BRANCH_WORKTREES,
    onSelect: (option) => onChange({ baseBranch: option.name, fromRemote: option.isRemote }),
  });
  const missing = branches !== null && baseBranch !== "" && controller.selectedOption === undefined;

  return (
    <SettingsRow
      id={id}
      label="Base branch"
      description="Each run gets a new branch from here, as it stands on this machine. Nothing fetches it first, so choose a remote branch to start from the last fetch."
      error={error ?? (loadFailed ? "The project's branches couldn't be read" : undefined)}
      control={({ labelId, descriptionId, disabled }) => (
        <div className={SETTINGS_CONTROL_WIDTH.wide}>
          <BaseBranchCombobox
            baseBranch={baseBranch}
            controller={controller}
            disabled={disabled}
            labelledBy={labelId}
            describedBy={descriptionId}
            {...(missing ? { unavailableLabel: `${baseBranch} (missing)` } : {})}
          />
        </div>
      )}
    />
  );
}
