/**
 * Correlated tracking for one submission handed to a terminal (#12337).
 *
 * `terminal.sendCommand` returns once the text is queued, never once it has
 * been delivered — blocking on delivery would mean waiting on an agent, which
 * can take arbitrarily long. That left a client unable to tell "delivered and
 * ignored" from "never delivered", because both read as an unchanged
 * `agentState`. Agent state is not the fallback proxy either: the activity
 * monitor is notified at `TerminalInputController.submit()`, before anything is
 * queued, so it moves for a submission whose Enter is never written.
 *
 * A caller therefore mints a token, hands it to `sendCommand`, and asks for it
 * back later through `terminal.getStatus`. The submit path stays
 * fire-and-forget; only the read is new.
 *
 * What a phase can honestly claim stops at Daintree's own boundary.
 * `node-pty`'s `write()` returns void and queues asynchronously, so the
 * strongest positive observation available is that the body and the trailing
 * Enter were handed to it without a synchronous throw. That the agent read
 * them, took the turn, or acted on them is not observable from here and is not
 * claimed by any phase.
 */
export type TerminalSubmissionPhase =
  /** Accepted onto this terminal's submit lane. Nothing has been written yet. */
  | "queued"
  /**
   * Holding the composer: the body may be written and the trailing Enter is
   * still to come. A submit stays here for as long as it takes — the lane is
   * never released early, because starting the next submit is what merges two
   * prompts into one (#11875).
   */
  | "writing"
  /**
   * Every body write and the complete trailing Enter returned from
   * `node-pty.write()` without throwing. The strongest claim available, and it
   * is about the pty, not the agent: bytes accepted by node-pty's write queue
   * have not necessarily been read by the process on the other end, and an
   * agent that read them may still discard them.
   */
  | "pty_written"
  /**
   * A write threw, or the submit rejected. Part of the body may already be
   * sitting in the composer with no Enter behind it, so this is not a signal
   * that re-sending is safe.
   */
  | "failed"
  /**
   * Daintree abandoned the rest of the submission — a graceful-shutdown input
   * lock, a superseding generation, the terminal exiting, or the queue being
   * dropped. Body bytes written before the abandon are still in the composer,
   * so this is not a signal that re-sending is safe either.
   */
  | "cancelled"
  /**
   * The terminal was read successfully and holds no record for this token.
   * Synthesised on read, never stored: it means the token was never accepted
   * here, or its outcome has aged out of the retained window
   * ({@link MAX_RETAINED_SUBMISSIONS}), or the pty-host restarted under it.
   * Distinct from an entry `error`, which means the terminal itself could not
   * be read.
   */
  | "unknown";

/** One submission's correlation record, as `terminal.getStatus` publishes it. */
export interface TerminalSubmissionRecord {
  token: string;
  phase: TerminalSubmissionPhase;
  /** Epoch milliseconds the phase was entered. Absent for `unknown`. */
  at?: number;
}

/**
 * One terminal's answer to a submission-token lookup.
 *
 * Three outcomes, not two, because "this terminal holds no record for your
 * token" and "this terminal could not be read at all" are different claims and
 * only the first is evidence. Collapsing them would let a timed-out RPC report
 * as an authoritative `unknown`, which is the same class of false certainty
 * #12337 exists to remove.
 */
export type TerminalSubmissionLookup =
  /** The terminal was read and holds this record. */
  | { status: "found"; record: TerminalSubmissionRecord }
  /** The terminal was read and holds nothing for this token. */
  | { status: "absent" }
  /**
   * The terminal could not be read — gone, not owned by the caller, or its
   * backend query failed. Nothing was observed, so nothing is claimed.
   */
  | { status: "unreadable" };

/**
 * Finalised outcomes retained per terminal incarnation, oldest evicted first.
 *
 * Only tokened submissions are retained at all — in-app typing and fleet
 * broadcast pass no token and cost nothing — so this bounds a client's own
 * traffic rather than the terminal's. Deep enough that a burst of sends stays
 * queryable after the fact, which is the whole reason last-submission-only was
 * rejected: submissions serialise on one lane, so a burst of three would leave
 * the first two unanswerable.
 */
export const MAX_RETAINED_SUBMISSIONS = 32;
