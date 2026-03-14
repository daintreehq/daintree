import type { WorktreeLifecycleStage } from "../WorktreeCard/hooks/useWorktreeStatus";

export type ChipState = "error" | "waiting" | "cleanup" | "complete" | null;

export interface ComputeChipStateInput {
  worktreeErrorCount: number;
  failedTerminalCount: number;
  waitingTerminalCount: number;
  lifecycleStage: WorktreeLifecycleStage | null;
  isComplete: boolean;
}

export function computeChipState(input: ComputeChipStateInput): ChipState {
  if (input.worktreeErrorCount > 0 || input.failedTerminalCount > 0) return "error";
  if (input.lifecycleStage === "merged" || input.lifecycleStage === "ready-for-cleanup")
    return "cleanup";
  if (input.isComplete) return "complete";
  if (input.waitingTerminalCount > 0) return "waiting";
  return null;
}
