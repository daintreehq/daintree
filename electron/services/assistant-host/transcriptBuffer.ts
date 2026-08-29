import type { AssistantHostEvent } from "../../../shared/types/ipc/assistantHost.js";

/**
 * The conversation so far, kept so a surface joining a running engine can be shown it.
 *
 * A second window on the same project attaches to the engine that is already running
 * rather than starting its own — the engine holds an exclusive lease on the project's
 * state, so a sibling would only queue behind it. But the conversation that window needs
 * was streamed before it existed, and the protocol has no "send me the history"
 * command, so the host keeps a copy.
 *
 * Extracted from `AssistantHostProcess` because its two rules are the easy things to get
 * wrong and the hard things to test through a spawned child: what counts toward the
 * budget, and where the buffer may be cut.
 */

/** How much conversation to keep per session. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

/**
 * Approximate wire size of an event.
 *
 * Sums every string it can reach rather than naming fields. A previous version charged
 * only a `text` property — which no high-volume frame has: `turn:token` streams `chunk`,
 * `turn:end` carries `content`, tool frames carry arrays — so every real frame was
 * billed at the base and an "8MB cap" retained arbitrarily much. Being approximate is
 * fine; being systematically wrong about the frames that dominate is not.
 */
export function approximateFrameBytes(value: unknown, depth = 4): number {
  if (typeof value === "string") return value.length;
  if (depth <= 0 || typeof value !== "object" || value === null) return 8;
  let total = 32;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    total += approximateFrameBytes(nested, depth - 1);
  }
  return total;
}

export interface TranscriptSnapshot {
  events: AssistantHostEvent[];
  prompts: Array<{ text: string; afterSeq: number }>;
  truncated: boolean;
}

export class TranscriptBuffer {
  private events: AssistantHostEvent[] = [];
  private prompts: Array<{ text: string; afterSeq: number }> = [];
  private bytes = 0;
  private truncated = false;
  /**
   * True while the tail of an over-budget turn is being thrown away.
   *
   * When a SINGLE turn exceeds the whole budget there is no boundary to trim back to,
   * so the buffer is emptied — and without this the rest of that same turn would stream
   * straight back in, leaving a joiner with exactly the headless fragment the boundary
   * rule exists to prevent. Cleared by the next `turn:start`.
   */
  private discardingTurn = false;

  constructor(private readonly maxBytes: number = MAX_TRANSCRIPT_BYTES) {}

  /** Records one engine event, trimming whole turns off the front to stay capped. */
  record(event: AssistantHostEvent): void {
    if (event.type === "turn:start") this.discardingTurn = false;
    if (this.discardingTurn) return;

    this.events.push(event);
    this.bytes += approximateFrameBytes(event);
    this.trim();
  }

  /**
   * Brings the buffer back under budget, dropping whole turns off the front.
   *
   * Loops: one turn's worth is not necessarily enough, and returning still over budget
   * meant the cap was only ever approached, never enforced.
   */
  private trim(): void {
    while (this.bytes > this.maxBytes) {
      if (!this.dropOldestTurn()) return;
    }
  }

  /** Drops the leading turn. Returns false when there is nothing left to drop. */
  private dropOldestTurn(): boolean {
    if (this.events.length === 0) {
      // Only prompts are left and they still exceed the budget: there is no turn to
      // drop, so give up rather than spin.
      if (this.prompts.length === 0) return false;
      this.prompts = [];
      this.bytes = 0;
      this.truncated = true;
      return false;
    }

    // Trim to the next turn boundary. Scanning from index 1 stops this spinning when
    // the first entry is itself a `turn:start`: cutting nothing while still over budget
    // would re-run on every append.
    let cut = -1;
    for (let i = 1; i < this.events.length; i++) {
      if (this.events[i]?.type === "turn:start") {
        cut = i;
        break;
      }
    }
    if (cut === -1) {
      // One turn is larger than the entire budget, so there is no boundary to keep.
      // Drop it, and keep dropping until the next turn begins.
      this.events = [];
      this.prompts = [];
      this.bytes = 0;
      this.truncated = true;
      this.discardingTurn = true;
      return false;
    }
    for (const dropped of this.events.slice(0, cut)) {
      this.bytes -= approximateFrameBytes(dropped);
    }
    this.events = this.events.slice(cut);
    this.truncated = true;
    // `- 1` because a prompt is recorded BEFORE the `turn:start` it causes, so the
    // prompt that opened the first turn still held sits one sequence behind it.
    // Filtering at the boundary itself dropped exactly the question being kept.
    const firstKeptSeq = this.events[0]?.seq ?? 0;
    const before = this.prompts.length;
    this.prompts = this.prompts.filter((p) => p.afterSeq >= firstKeptSeq - 1);
    if (this.prompts.length !== before) this.truncated = true;
    return true;
  }

  /**
   * Records a user prompt, which the ENGINE never echoes.
   *
   * Pinned to the highest sequence seen so far: that is what the prompt FOLLOWED, and
   * it is how a joiner puts it back among the engine's events. Without these, a replay
   * shows answers to questions it never displays.
   */
  recordPrompt(text: string, afterSeq: number): void {
    // NOT gated on `discardingTurn`. That flag suppresses the tail of an over-budget
    // turn, and the next prompt necessarily arrives before the `turn:start` that clears
    // it — so gating here dropped the question and kept the answer, which is the exact
    // shape this buffer exists to prevent.
    this.prompts.push({ text, afterSeq });
    this.bytes += text.length + 128;
    this.trim();
  }

  /** Copies, because the caller hands these to a renderer while the engine streams on. */
  snapshot(): TranscriptSnapshot {
    return {
      events: [...this.events],
      prompts: [...this.prompts],
      truncated: this.truncated,
    };
  }
}
