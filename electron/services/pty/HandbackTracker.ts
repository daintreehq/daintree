/**
 * Handback requests one terminal is holding (#12488): the codes minted for
 * submissions that asked for a handback, and how far each submission got.
 *
 * A tracker exists only once something on the terminal asks, so a terminal
 * nobody asked about pays nothing — the submit path and the settle hook both
 * short-circuit on its absence. It dies with the pty-host, which is acceptable:
 * a request lost that way is simply never observed.
 */

export interface HandbackRequest {
  code: string;
  /** Token of the submission that asked, when it carried one (#12337). */
  submissionToken?: string;
  /** Submission order within this terminal, used to retire earlier requests. */
  seq: number;
  /**
   * The submission reached `pty_written` — or, for a launch prompt, the process
   * was spawned with it. Only delivered requests are looked for at a settle.
   */
  delivered: boolean;
}

/**
 * Bound on requests held at once. Only submissions queued behind one that
 * never reaches the pty can pile up, and the oldest of those is the least
 * likely ever to be answered.
 */
export const MAX_HANDBACK_REQUESTS = 8;

/** Viewport rows handed to the detector — more than any pane is tall. */
const SCREEN_READ_ROWS = 500;

export class HandbackTracker {
  private requests: HandbackRequest[] = [];
  private nextSeq = 0;

  /**
   * @param readScreen The terminal's rendered, non-empty viewport rows. The
   *   analysis backend serves these synchronously in both worker and in-thread
   *   mode, where the headless mirror itself may live on another thread.
   */
  constructor(private readonly readScreen: (rows: number) => readonly string[]) {}

  /** Requests whose prompt reached the agent, oldest first. */
  deliveredRequests(): HandbackRequest[] {
    return this.requests.filter((request) => request.delivered);
  }

  hasRequests(): boolean {
    return this.requests.length > 0;
  }

  screenText(): string {
    return this.readScreen(SCREEN_READ_ROWS).join("\n");
  }

  /** A launch prompt: delivered the moment the process is spawned with it. */
  registerDelivered(code: string): void {
    this.push({ code, seq: this.takeSeq(), delivered: true });
  }

  /**
   * Note a submission entering the submit lane. Returns the callback to run at
   * its `pty_written`, or `undefined` when there is nothing it could retire or
   * deliver — so an ordinary submit into a terminal with no request stays free.
   */
  noteSubmission(code?: string, submissionToken?: string): (() => void) | undefined {
    if (code === undefined && this.requests.length === 0) return undefined;
    const seq = this.takeSeq();
    if (code !== undefined) {
      this.push({
        code,
        seq,
        delivered: false,
        ...(submissionToken !== undefined ? { submissionToken } : {}),
      });
    }
    return () => this.markWritten(seq);
  }

  /** Drop the request whose marker was just observed, so a code fires once. */
  retire(code: string): void {
    this.requests = this.requests.filter((request) => request.code !== code);
  }

  clear(): void {
    this.requests = [];
  }

  /**
   * The submission at `seq` reached the pty. Every request from before it is
   * retired — the agent has a later prompt now, so an older code would answer
   * the wrong one — and its own request, if it made one, becomes eligible.
   */
  private markWritten(seq: number): void {
    this.requests = this.requests.filter((request) => request.seq >= seq);
    for (const request of this.requests) {
      if (request.seq === seq) request.delivered = true;
    }
  }

  private push(request: HandbackRequest): void {
    this.requests.push(request);
    if (this.requests.length > MAX_HANDBACK_REQUESTS) {
      this.requests.splice(0, this.requests.length - MAX_HANDBACK_REQUESTS);
    }
  }

  private takeSeq(): number {
    this.nextSeq += 1;
    return this.nextSeq;
  }
}
