import type {
  CanopyInputLineReading,
  CanopyRunTarget,
  CanopyWorktreeReading,
} from "@shared/types/ipc/canopy";
import type { TerminalInputLineState } from "@shared/types/terminalStatus";
import type { WorktreeLocalWork } from "@shared/types/worktreeLocalWork";
import type { HostId } from "@shared/types/remoteHosts";
import { isolatedComposerScope, makeDraftKey } from "@/lib/draftKey";
import { allHostsKey } from "./canopyAllHosts";
import { itemAnswerAttention, itemQuestionAttention, type CanopyItem } from "./canopyModel";
import { placeOf } from "./canopyInboxPlace";

/**
 * Why a run of a bulk trash starts unticked: something seen that says the
 * person may still want it, never a guess. A suggestion the agent drew in its
 * own input box is not one: nobody typed it.
 */
export type BulkTrashHold =
  "working" | "answer" | "question" | "typed" | "reply" | "unpushed" | "uncommitted" | "unreadable";

/** The holds that come from the run's worktree, whose row says what git counted instead. */
export type BulkTrashWorktreeHold = Extract<
  BulkTrashHold,
  "unpushed" | "uncommitted" | "unreadable"
>;

export const BULK_TRASH_HOLD_LABEL: Record<
  Exclude<BulkTrashHold, BulkTrashWorktreeHold>,
  string
> = {
  working: "Working",
  answer: "Answer needs attention",
  question: "Question open in Decisions",
  typed: "Text typed in its terminal",
  reply: "Reply drafted here",
};

export function isWorktreeHold(hold: BulkTrashHold): hold is BulkTrashWorktreeHold {
  return hold === "unpushed" || hold === "uncommitted" || hold === "unreadable";
}

/**
 * What the review goes on for a run's worktree (#18151): its host's answer,
 * or for a run in a worktree that no answer came back for, unreadable. A run
 * with no worktree has nothing to read.
 */
export function bulkTrashWorktree(
  item: CanopyItem,
  work: WorktreeLocalWork | undefined
): WorktreeLocalWork {
  if (work !== undefined) return work;
  return item.row.run.worktreeId === undefined
    ? { kind: "not-applicable" }
    : { kind: "unreadable" };
}

/** Why the run's worktree holds it back, if it does: work only on this machine, or no answer. */
export function worktreeHold(work: WorktreeLocalWork): BulkTrashWorktreeHold | null {
  if (work.kind === "not-applicable") return null;
  if (work.kind === "unreadable") return "unreadable";
  if (work.unpushedCommits === null || work.unpushedCommits > 0) return "unpushed";
  if (work.changedEntries > 0 || work.hiddenFromStatus > 0) return "uncommitted";
  return null;
}

/**
 * The first thing seen that holds a run back, by the order the person would
 * weigh them. What Decisions holds for the run counts whatever the panel did
 * with it: an unanswered question is never a terminal to trash by default.
 */
export function bulkTrashHold(
  item: CanopyItem,
  inputLine: TerminalInputLineState | undefined,
  replyDraft: boolean,
  worktree: WorktreeLocalWork = { kind: "not-applicable" }
): BulkTrashHold | null {
  const state = item.row.run.agentState;
  if (state === "working" || state === "directing") return "working";
  if (itemAnswerAttention(item) > 0) return "answer";
  if (itemQuestionAttention(item) > 0) return "question";
  if (inputLine === "typed") return "typed";
  if (replyDraft) return "reply";
  return worktreeHold(worktree);
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

/** The readings as a lookup; a run left out was not answered for. */
export function worktreesByRun(
  readings: readonly CanopyWorktreeReading[]
): Map<string, WorktreeLocalWork> {
  return new Map(readings.map((reading) => [reading.runId, reading.work]));
}
