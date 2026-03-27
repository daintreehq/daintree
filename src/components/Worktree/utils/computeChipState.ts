import type { WorktreeLifecycleStage } from "../WorktreeCard/hooks/useWorktreeStatus";

export type ChipState = "waiting" | "cleanup" | "complete" | null;

export interface ComputeChipStateInput {
  waitingTerminalCount: number;
  lifecycleStage: WorktreeLifecycleStage | null;
  isComplete: boolean;
  hasActiveAgent: boolean;
}

export function computeChipState(input: ComputeChipStateInput): ChipState {
  if (input.lifecycleStage === "merged" || input.lifecycleStage === "ready-for-cleanup")
    return "cleanup";
  if (input.isComplete && !input.hasActiveAgent) return "complete";
  if (input.waitingTerminalCount > 0) return "waiting";
  return null;
}
