import type { WorktreeLifecycleStage } from "../WorktreeCard/hooks/useWorktreeStatus";

export type ChipState = "approval" | "waiting" | "cleanup" | "complete" | null;

export interface ComputeChipStateInput {
  waitingTerminalCount: number;
  approvalWaitingCount: number;
  lifecycleStage: WorktreeLifecycleStage | null;
  isComplete: boolean;
}

export function computeChipState(input: ComputeChipStateInput): ChipState {
  if (input.lifecycleStage === "merged" || input.lifecycleStage === "ready-for-cleanup")
    return "cleanup";
  if (input.isComplete) return "complete";
  if (input.approvalWaitingCount > 0) return "approval";
  if (input.waitingTerminalCount > 0) return "waiting";
  return null;
}
