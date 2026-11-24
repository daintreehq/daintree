import { terminalClient } from "@/clients";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import { heldComposerSendDelivered, useHeldComposerSendStore } from "@/store/heldComposerSendStore";
import { logWarn } from "@/utils/logger";
import type { DiffNote } from "@/components/Worktree/diffNotes";
import type { HeldComposerSend } from "@shared/types/ipc/composerHold";

const WRITE_POLL_MS = 250;
const WRITE_POLL_MAX_MS = 2_000;
/** A lane holds a submission as long as it takes. Past this, losing sight of it leaves its notes. */
const WRITE_WATCH_MS = 30 * 60_000;
/** Reads the terminal may answer `absent` for while the token is still on its way to the host. */
const ABSENT_READS_ALLOWED = 4;
/** A held send typed just before it expired can still be confirming its write. */
const HELD_CONFIRM_GRACE_MS = 5 * 60_000;
/** Each is taken by the watch that follows its send; the cap only bounds a send nothing followed. */
const MAX_HELD_SUBMISSIONS = 32;

type HeldSubmission = Pick<HeldComposerSend, "token" | "expiresAt">;

/** Submissions a pane held for its agent's next prompt, by the token they were sent under. */
const heldSubmissions = new Map<string, HeldSubmission>();

/**
 * Says the send made under `submissionToken` was held rather than submitted
 * (#16379): main types it later under a token of its own, so its notes follow
 * the held send instead (#17181).
 */
export function noteSubmissionHeld(submissionToken: string, send: HeldComposerSend): void {
  heldSubmissions.set(submissionToken, { token: send.token, expiresAt: send.expiresAt });
  for (const oldest of heldSubmissions.keys()) {
    if (heldSubmissions.size <= MAX_HELD_SUBMISSIONS) break;
    heldSubmissions.delete(oldest);
  }
}

/**
 * Clears the notes a submission carried once its terminal says it was written.
 * Accepting a submit only puts it on the terminal's lane: it can still fail, or
 * be dropped by an exit or a lock, and only `pty_written` says it went. Any
 * other outcome, including losing sight of it, leaves the notes pending, since
 * sending a note twice costs less than losing one. A held submission goes by
 * what main says of the held send.
 */
export function clearDiffNotesOnceWritten(
  terminalId: string,
  submissionToken: string,
  notes: readonly DiffNote[]
): void {
  const held = heldSubmissions.get(submissionToken);
  heldSubmissions.delete(submissionToken);
  void (held === undefined ? watchForWrite(terminalId, submissionToken) : watchForHeld(held))
    .then((written) => {
      if (written) useDiffNotesStore.getState().clearSent(notes);
    })
    .catch((error: unknown) => {
      logWarn("[diffNotes] delivery watch failed", { terminalId, error });
    });
}

async function watchForWrite(terminalId: string, submissionToken: string): Promise<boolean> {
  const deadline = Date.now() + WRITE_WATCH_MS;
  let absentReads = 0;
  let delay = WRITE_POLL_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, WRITE_POLL_MAX_MS);
    const lookup = (await terminalClient.getSubmissions([terminalId], submissionToken))[terminalId];
    if (lookup?.status === "absent") {
      if (++absentReads > ABSENT_READS_ALLOWED) return false;
      continue;
    }
    if (lookup?.status !== "found") return false;
    const { phase } = lookup.record;
    if (phase === "pty_written") return true;
    if (phase !== "queued" && phase !== "writing") return false;
  }
  return false;
}

/**
 * Main ends a held send `delivered` only once the terminal confirms its write,
 * whether the pane's prompt took it or Send now did. Its end may reach this
 * view before the answer that it was held, which the store keeps. Withdrawn,
 * dropped, or never heard of again by its expiry, it wasn't written.
 */
function watchForHeld({ token, expiresAt }: HeldSubmission): Promise<boolean> {
  const ended = heldComposerSendDelivered(useHeldComposerSendStore.getState(), token);
  if (ended !== undefined) return Promise.resolve(ended);
  return new Promise((resolve) => {
    const finish = (delivered: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(delivered);
    };
    const unsubscribe = useHeldComposerSendStore.subscribe((state) => {
      const delivered = heldComposerSendDelivered(state, token);
      if (delivered !== undefined) finish(delivered);
    });
    const timer = setTimeout(
      () => finish(false),
      Math.max(0, expiresAt - Date.now()) + HELD_CONFIRM_GRACE_MS
    );
  });
}
