import type { ProjectAttachmentObservation, WorktreeAttachment } from "@shared/types/worktree";

export type AttachmentChipTone = "neutral" | "working" | "error";

export interface AttachmentChipState {
  label: string;
  tone: AttachmentChipTone;
}

const RUNNING_LABEL: Record<NonNullable<WorktreeAttachment["running"]>, string> = {
  attach: "Attaching…",
  detach: "Detaching…",
  status: "Checking status…",
};

const ACTION_NOUN: Record<ProjectAttachmentObservation["action"], string> = {
  attach: "Attach",
  detach: "Detach",
  status: "Status check",
  removed: "Detach",
};

function isFailure(observation: ProjectAttachmentObservation | undefined): boolean {
  return !!observation && observation.state !== "success";
}

export function failureLabel(observation: ProjectAttachmentObservation): string {
  if (observation.action === "removed") return "Removed before detach";
  const noun = ACTION_NOUN[observation.action];
  if (observation.state === "timed-out") return `${noun} timed out`;
  if (observation.state === "needs-approval") return `${noun} needs approval`;
  return `${noun} failed`;
}

/**
 * What this worktree's chip says about an attachment, or `null` when it has
 * none. Only observations: the holder reads "Attached" only while nothing it
 * ran since has failed, and a failure on a worktree that does not hold it shows
 * there as the failure it was, never as attached.
 */
export function attachmentChipState(attachment: WorktreeAttachment): AttachmentChipState | null {
  if (attachment.running) return { label: RUNNING_LABEL[attachment.running], tone: "working" };
  const { lastResult, status } = attachment;
  if (attachment.heldHere) {
    if (isFailure(lastResult)) return { label: failureLabel(lastResult!), tone: "error" };
    if (isFailure(status)) return { label: failureLabel(status!), tone: "error" };
    return { label: "Attached", tone: "neutral" };
  }
  if (isFailure(lastResult)) return { label: failureLabel(lastResult!), tone: "error" };
  return null;
}

/** The attachments this worktree's card shows a chip for. */
export function visibleAttachmentChips(
  attachments: readonly WorktreeAttachment[] | undefined
): Array<{ attachment: WorktreeAttachment; state: AttachmentChipState }> {
  const chips: Array<{ attachment: WorktreeAttachment; state: AttachmentChipState }> = [];
  for (const attachment of attachments ?? []) {
    const state = attachmentChipState(attachment);
    if (state) chips.push({ attachment, state });
  }
  return chips;
}
