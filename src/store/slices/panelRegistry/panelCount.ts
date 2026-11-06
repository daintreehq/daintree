import { countPanelsTowardLimit, countsTowardPanelLimit } from "@shared/utils/panelCount";
import { getPendingBatchIds } from "./hydrationBatch";
import { getPanelSlotReservations } from "./panelSlotReservations";

export {
  countPanelsTowardLimit,
  countsTowardPanelLimit,
  isClientMetadataEligible,
  isEphemeralPanel,
} from "@shared/utils/panelCount";

/**
 * The count every panel-limit admission is judged on (#15607): the panels in
 * `panelIds`, the panels a batch has committed but still holds back from
 * `panelIds`, and the slots granted to adds that haven't committed yet.
 * `countPanelsTowardLimit` alone sees only the first, so two overlapping gates
 * would both be granted the same capacity.
 *
 * A claimed slot counts only until its id has a panel, which the panel itself
 * then accounts for, so nothing is counted twice.
 */
export function countPanelLimitUsage(state: {
  panelsById: Parameters<typeof countPanelsTowardLimit>[0];
  panelIds: string[];
}): number {
  const pendingIds = getPendingBatchIds();
  const { unclaimed, claimedIds } = getPanelSlotReservations();
  if (pendingIds.length === 0 && claimedIds.size === 0) {
    return unclaimed + countPanelsTowardLimit(state.panelsById, state.panelIds);
  }

  const seen = new Set<string>();
  let count = unclaimed;
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const panel = state.panelsById[id];
    if (panel !== undefined) {
      if (countsTowardPanelLimit(panel)) count++;
    } else if (claimedIds.has(id)) {
      count++;
    }
  };
  for (const id of state.panelIds) visit(id);
  for (const id of pendingIds) visit(id);
  for (const id of claimedIds) visit(id);
  return count;
}
