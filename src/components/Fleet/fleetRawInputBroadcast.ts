import { terminalClient } from "@/clients";
import { registerFleetInputBroadcastHandler } from "@/services/terminal/fleetInputRouter";
import { isFleetArmEligible, useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";

function resolveLiveFleetTargetIds(): string[] {
  const { armOrder, armedIds } = useFleetArmingStore.getState();
  if (armedIds.size < 2) return [];

  const { panelsById } = usePanelStore.getState();
  const targets: string[] = [];
  for (const id of armOrder) {
    if (!armedIds.has(id)) continue;
    const panel = panelsById[id];
    if (isFleetArmEligible(panel)) targets.push(id);
  }
  return targets;
}

export function broadcastFleetRawInput(originId: string, data: string): boolean {
  if (data.length === 0) return false;

  const armedIds = useFleetArmingStore.getState().armedIds;
  if (armedIds.size < 2 || !armedIds.has(originId)) return false;

  const targets = resolveLiveFleetTargetIds();
  if (targets.length < 2 || !targets.includes(originId)) return false;

  terminalClient.broadcast(targets, data);
  // Bump the broadcast signal so the ribbon can fire a one-shot commit
  // flash. Counter increments only; subscribers diff against their last
  // observed value to detect a new commit. Lives here (not in
  // fleetInputRouter) so the router stays free of fleetArmingStore imports
  // — the router is loaded eagerly by terminalInstanceService and pulling
  // the store in at that point breaks tests that mock usePanelStore.
  useFleetArmingStore.getState().noteBroadcastCommit();
  return true;
}

registerFleetInputBroadcastHandler(broadcastFleetRawInput);
