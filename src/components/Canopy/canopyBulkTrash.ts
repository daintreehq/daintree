import type { CanopyInputLineReading, CanopyRunTarget } from "@shared/types/ipc/canopy";
import type { TerminalInputLineState } from "@shared/types/terminalStatus";
import type { HostId } from "@shared/types/remoteHosts";
import { isolatedComposerScope, makeDraftKey } from "@/lib/draftKey";
import { allHostsKey } from "./canopyAllHosts";
import type { CanopyItem } from "./canopyModel";
import { placeOf } from "./canopyInboxPlace";

/**
 * Why a run of a bulk trash starts unticked: something seen that says the
 * person may still want it, never a guess. A suggestion the agent drew in its
 * own input box is not one: nobody typed it.
 */
export type BulkTrashHold = "working" | "typed" | "reply";

export const BULK_TRASH_HOLD_LABEL: Record<BulkTrashHold, string> = {
  working: "Working",
  typed: "Text typed in its terminal",
  reply: "Reply drafted here",
};

/** The first thing seen that holds a run back, by the order the person would weigh them. */
export function bulkTrashHold(
  item: CanopyItem,
  inputLine: TerminalInputLineState | undefined,
  replyDraft: boolean
): BulkTrashHold | null {
  const state = item.row.run.agentState;
  if (state === "working" || state === "directing") return "working";
  if (inputLine === "typed") return "typed";
  if (replyDraft) return "reply";
  return null;
}

/**
 * Whether the panel's reply holds text for this run. A reply is drafted under
 * the name the panel showed the run by when it was written: its own id on its
 * host, or its All hosts key, so both are asked.
 */
export function hasReplyDraft(
  drafts: ReadonlyMap<string, string>,
  item: Pick<CanopyItem, "runId" | "workspaceId">,
  hostId: HostId | null,
  ownHostId: HostId
): boolean {
  const place = placeOf(item, hostId, ownHostId);
  const scope = isolatedComposerScope(place.hostId ?? undefined);
  return [place.runId, allHostsKey(place.hostId ?? ownHostId, place.runId)].some(
    (runId) => (drafts.get(makeDraftKey(runId, scope)) ?? "").trim().length > 0
  );
}

export function bulkTrashTarget(item: CanopyItem): CanopyRunTarget {
  return { runId: item.runId, spawnedAt: item.row.run.spawnedAt };
}

/** The readings as a lookup; a run left out was not read. */
export function inputLinesByRun(
  readings: readonly CanopyInputLineReading[]
): Map<string, TerminalInputLineState> {
  return new Map(readings.map((reading) => [reading.runId, reading.state]));
}
