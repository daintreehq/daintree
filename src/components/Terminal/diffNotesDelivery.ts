import { terminalClient } from "@/clients";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import type { DiffNote } from "@/components/Worktree/diffNotes";

const WRITE_POLL_MS = 250;
/** A lane can hold a large paste a while; past this, a note stays pending rather than be guessed at. */
const WRITE_WATCH_MS = 2 * 60_000;
/** Reads the terminal may answer `absent` for while the token is still on its way to the host. */
const ABSENT_READS_ALLOWED = 4;

/**
 * Clears the notes a submission carried once its terminal says it was written.
 * Accepting a submit only puts it on the terminal's lane: it can still fail, or
 * be dropped by an exit or a lock, and only `pty_written` says it went. Any
 * other outcome, including losing sight of it, leaves the notes pending, since
 * sending a note twice costs less than losing one.
 */
export function clearDiffNotesOnceWritten(
  terminalId: string,
  submissionToken: string,
  notes: readonly DiffNote[]
): void {
  void watchForWrite(terminalId, submissionToken).then((written) => {
    if (written) useDiffNotesStore.getState().clearSent(notes);
  });
}

async function watchForWrite(terminalId: string, submissionToken: string): Promise<boolean> {
  const deadline = Date.now() + WRITE_WATCH_MS;
  let absentReads = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, WRITE_POLL_MS));
    let lookup;
    try {
      lookup = (await terminalClient.getSubmissions([terminalId], submissionToken))[terminalId];
    } catch {
      return false;
    }
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
