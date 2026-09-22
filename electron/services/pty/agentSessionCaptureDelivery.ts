import type { AgentSessionCaptureFinishResult } from "../../../shared/types/pty-host.js";
import { getGitBranch } from "../../utils/gitUtils.js";

/**
 * Pty-host side of the quit-time capture barrier (#12433).
 *
 * A capture's record reaches Main only after an async tail — the best-effort
 * branch stamp, and for trash expiry the graceful kill before it — so a quit
 * that merely waits for the host to answer something can still dispose Main's
 * journal and project store while an observed session id sits in that tail.
 * Every tail registers here before its first await; `finishAgentSessionCaptures`
 * then waits for all of them, with the branch stamp skipped, before the host
 * acknowledges. The acknowledgement rides the same port as the records, so
 * Main has received every record the host observed by the time it reads it.
 */

const pending = new Set<Promise<unknown>>();
let finishing = false;
let signalFinishing: () => void = () => {};
let finishingSignal = new Promise<void>((resolve) => {
  signalFinishing = resolve;
});

/**
 * Register a capture tail. Call it synchronously with the tail's creation — a
 * tail registered after an await can be missed by a finish that started in
 * between. Rejections are the tail's own to handle; this only observes settling.
 */
export function trackAgentSessionCapture(work: Promise<unknown>): void {
  pending.add(work);
  const settle = () => {
    pending.delete(work);
  };
  work.then(settle, settle);
}

/**
 * The branch to stamp on a capture, or null. Never delays delivery once the
 * host is finishing: an id without a branch is a complete resume record, and a
 * branch is not worth losing the id over.
 */
export async function resolveCaptureBranch(cwd: string | undefined): Promise<string | null> {
  if (!cwd || finishing) return null;
  return Promise.race([getGitBranch(cwd), finishingSignal.then(() => null)]);
}

/**
 * Deliver every registered capture, waiting at most `budgetMs`. Permanent:
 * the host is being torn down, so later captures skip enrichment too.
 */
export async function finishAgentSessionCaptures(
  budgetMs: number
): Promise<AgentSessionCaptureFinishResult> {
  finishing = true;
  signalFinishing();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(
      () => {
        expired = true;
        resolve();
      },
      Math.max(0, budgetMs)
    );
  });
  try {
    // A tail can register another (trash expiry's kill fires the exit capture),
    // so keep going until a pass finds nothing new.
    while (pending.size > 0 && !expired) {
      await Promise.race([Promise.allSettled([...pending]), deadline]);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { complete: pending.size === 0, pending: pending.size };
}

export function resetAgentSessionCaptureDeliveryForTests(): void {
  pending.clear();
  finishing = false;
  finishingSignal = new Promise<void>((resolve) => {
    signalFinishing = resolve;
  });
}
