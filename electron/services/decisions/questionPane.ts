import { buildSnapshotContent, type QuestionRow } from "@daintreehq/decisions-client";
import type { DecisionQuestionPaneResult } from "../../../shared/types/decisionsQuestion.js";
import type { DecisionIdentitySources } from "./decisionWake.js";
import { readAskers, type PaneSnapshotPtyClient } from "./paneSnapshots.js";

/** What a person sending an answer to another terminal records on its row. */
export const REASSIGNED_STRATEGY = "reassigned";

/**
 * The pane that asked `row` (#18037), read on this machine for a person at
 * this computer or at the owner's that enrolled it: only while it holds the
 * run that asked, before and after the read, and redacted and bounded
 * exactly as a phone's terminal snapshot is. The snapshot switch doesn't
 * apply: nothing read here goes to the relay. Never throws.
 */
export async function readQuestionPane(
  sources: DecisionIdentitySources,
  client: PaneSnapshotPtyClient | null,
  row: QuestionRow,
  now: () => number = Date.now
): Promise<DecisionQuestionPaneResult> {
  // The origin now names the run the answer was sent to, which never asked it.
  if (row.agent_resume_strategy === REASSIGNED_STRATEGY) return { result: "reassigned" };
  if (client === null) return { result: "unreadable" };
  const { origin } = row;
  try {
    const [reading] = await readAskers(sources, client, origin.pane_id, [origin], now);
    if (reading === undefined || reading.kind === "unreadable") return { result: "unreadable" };
    if (reading.kind === "exited") return { result: "closed" };
    const content = buildSnapshotContent(
      reading.input,
      new Date(reading.input.observedAt ?? now()).toISOString()
    );
    return {
      result: "read",
      reference: {
        hostId: origin.host_id,
        projectId: origin.project_id,
        terminalId: origin.pane_id,
        questionId: row.question_id,
      },
      pane: {
        agentState: content.agent_state,
        waitingReason: content.waiting_reason,
        paneTitle: content.pane_title,
        lines: content.terminal_lines,
        observedAt: content.observed_at,
      },
    };
  } catch {
    // A read the pty host didn't answer in time, or a state the snapshot can't carry.
    return { result: "unreadable" };
  }
}
