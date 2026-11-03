import {
  MAX_RETAINED_SUBMISSIONS,
  SUBMISSION_OUTPUT_MAX_BYTES,
  SUBMISSION_OUTPUT_RETENTION_MS,
  type TerminalSubmissionOutput,
} from "../../../shared/types/terminalSubmission.js";
import { redactSecrets } from "../redactSecrets.js";
import { cutToBytes } from "./SubmissionOutputCapture.js";

interface Entry {
  captureId: number;
  writtenAt: number;
  output: TerminalSubmissionOutput;
}

/**
 * One terminal's captured submission output, by the token its sender minted
 * (#16210). Read back only through `terminal.getStatus` with that token, so a
 * caller gets the answer to its own send and nothing wider.
 *
 * Text is redacted as it arrives, never on the way out, so what is held is
 * already what may leave: a status relayed through the global assistant's
 * `host.call` is not scrubbed on its way. Held only in memory, as deep as the
 * submission ledger it sits beside, and for at most
 * {@link SUBMISSION_OUTPUT_RETENTION_MS} from the Enter.
 */
export class SubmissionOutputLedger {
  private readonly entries = new Map<string, Entry>();
  private readonly tokensByCapture = new Map<number, string>();
  private nextCaptureId = 1;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;

  /** Open an entry for a submission whose Enter was just written; returns its capture id. */
  begin(token: string, now = Date.now()): number {
    this.forget(token);
    const captureId = this.nextCaptureId++;
    this.entries.set(token, {
      captureId,
      writtenAt: now,
      output: { text: "", truncated: false, state: "capturing" },
    });
    this.tokensByCapture.set(captureId, token);
    while (this.entries.size > MAX_RETAINED_SUBMISSIONS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.forget(oldest);
    }
    this.prune(now);
    return captureId;
  }

  /** Take a capture's latest output. Ignored once its entry has gone. */
  publish(captureId: number, output: TerminalSubmissionOutput): void {
    const token = this.tokensByCapture.get(captureId);
    if (token === undefined) return;
    const entry = this.entries.get(token);
    if (entry === undefined || entry.output.state !== "capturing") return;
    const redacted = redactSecrets(output.text);
    const text = cutToBytes(redacted, SUBMISSION_OUTPUT_MAX_BYTES);
    entry.output = {
      text,
      truncated: output.truncated || text.length < redacted.length,
      state: output.state,
    };
  }

  /**
   * Settle every capture still open as `state`: the mirror behind it is gone,
   * so nothing more will arrive. What it published last is kept.
   */
  settleOpen(state: "closed" | "lost"): void {
    for (const entry of this.entries.values()) {
      if (entry.output.state === "capturing") entry.output = { ...entry.output, state };
    }
  }

  read(token: string, now = Date.now()): TerminalSubmissionOutput | undefined {
    const entry = this.entries.get(token);
    if (entry === undefined) return undefined;
    if (now - entry.writtenAt >= SUBMISSION_OUTPUT_RETENTION_MS) {
      this.forget(token);
      return undefined;
    }
    return { ...entry.output };
  }

  forget(token: string): void {
    const entry = this.entries.get(token);
    if (entry === undefined) return;
    this.entries.delete(token);
    this.tokensByCapture.delete(entry.captureId);
  }

  dispose(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.entries.clear();
    this.tokensByCapture.clear();
  }

  /**
   * Drop expired entries and arm one timer for the next to expire, so a
   * terminal nobody sends to or reads again still lets go of its text.
   */
  private prune(now: number): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    let next = Number.POSITIVE_INFINITY;
    for (const [token, entry] of [...this.entries]) {
      const expiresAt = entry.writtenAt + SUBMISSION_OUTPUT_RETENTION_MS;
      if (expiresAt <= now) this.forget(token);
      else next = Math.min(next, expiresAt);
    }
    if (next === Number.POSITIVE_INFINITY) return;
    this.expiryTimer = setTimeout(() => this.prune(Date.now()), next - now);
    this.expiryTimer.unref?.();
  }
}
