import type { WorktreeState } from "@/types";

export interface SetupAlarm {
  tone: "error" | "warning";
  label: string;
}

/**
 * Whether the worktree's setup or lifecycle run needs the user, by the same
 * conditions the Details recovery block acts on: a failed lifecycle slot, a
 * failed plugin step behind a finished setup script, and setup or lifecycle
 * commands waiting on approval. Reading these rather than the lifecycle label
 * matters because a later, successful resource action replaces the label while
 * setup is still waiting.
 */
export function deriveSetupAlarm(
  worktree: WorktreeState,
  lifecycleLabel: string | undefined | null,
  isLifecycleRunning: boolean
): SetupAlarm | null {
  if (isLifecycleRunning || worktree.setupStatus?.state === "running") return null;

  const lifecycleState = worktree.lifecycleStatus?.state;
  const lifecycleSlotFailed = lifecycleState === "failed" || lifecycleState === "timed-out";
  const pluginStepsFailed =
    !lifecycleSlotFailed &&
    lifecycleState !== "running" &&
    worktree.setupStatus?.stage === "plugin-steps" &&
    (worktree.setupStatus.state === "failed" || worktree.setupStatus.state === "timed-out");
  if (lifecycleSlotFailed || pluginStepsFailed) {
    return { tone: "error", label: (lifecycleSlotFailed && lifecycleLabel) || "Setup failed" };
  }

  const needsApproval =
    worktree.setupStatus?.state === "needs-approval" ||
    lifecycleState === "needs-approval" ||
    worktree.lifecycleCommandsNeedApproval === true;
  if (needsApproval) {
    return {
      tone: "warning",
      label: (lifecycleState === "needs-approval" && lifecycleLabel) || "Setup needs approval",
    };
  }
  return null;
}
