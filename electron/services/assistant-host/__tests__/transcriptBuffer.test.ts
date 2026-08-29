import { describe, it, expect, beforeEach } from "vitest";
import { TranscriptBuffer, approximateFrameBytes } from "../transcriptBuffer.js";
import type { AssistantHostEvent } from "../../../../shared/types/ipc/assistantHost.js";

/**
 * The replay buffer's two rules: what counts toward the budget, and where it may be cut.
 *
 * Both were wrong in the first version of this code. The budget charged only a `text`
 * property, which no high-volume frame has — so an "8MB cap" retained arbitrarily much.
 * And an over-budget turn was dropped without suppressing its own tail, so the very
 * fragment the boundary rule exists to prevent streamed straight back in.
 */

let seq = 0;
const turnStart = (): AssistantHostEvent =>
  ({ type: "turn:start", sessionId: "s", seq: ++seq, turnId: `t${seq}` }) as AssistantHostEvent;
const token = (chunk: string): AssistantHostEvent =>
  ({ type: "turn:token", sessionId: "s", seq: ++seq, turnId: "t", chunk }) as AssistantHostEvent;

describe("approximateFrameBytes", () => {
  it("counts the fields that actually carry the volume", () => {
    const streamed = token("x".repeat(10_000));
    // The regression this guards: `turn:token` streams `chunk`, not `text`. Charging a
    // flat base for it made the cap meaningless.
    expect(approximateFrameBytes(streamed)).toBeGreaterThan(10_000);
  });

  it("reaches nested payloads rather than stopping at the top level", () => {
    const nested = { type: "tool:batch", calls: [{ arguments: { body: "y".repeat(5_000) } }] };
    expect(approximateFrameBytes(nested)).toBeGreaterThan(5_000);
  });
});

describe("TranscriptBuffer", () => {
  beforeEach(() => {
    seq = 0;
  });

  it("keeps everything while under budget", () => {
    const buffer = new TranscriptBuffer(1_000_000);
    buffer.record(turnStart());
    buffer.record(token("hello"));
    const snap = buffer.snapshot();
    expect(snap.events).toHaveLength(2);
    expect(snap.truncated).toBe(false);
  });

  it("trims to a turn boundary rather than an arbitrary prefix", () => {
    // Sized so the budget is only breached AFTER a second turn has begun — which is
    // what leaves a boundary to cut back to.
    const buffer = new TranscriptBuffer(900);
    buffer.record(turnStart());
    buffer.record(token("a".repeat(400)));
    buffer.record(turnStart());
    buffer.record(token("b".repeat(400)));

    const snap = buffer.snapshot();
    expect(snap.truncated).toBe(true);
    // A joiner must never be handed a `turn:end` for a turn it never saw begin.
    expect(snap.events[0]?.type).toBe("turn:start");
  });

  it("suppresses the tail of a turn too big to keep at all", () => {
    const buffer = new TranscriptBuffer(1_000);
    buffer.record(turnStart());
    buffer.record(token("a".repeat(5_000))); // blows the budget on its own
    // The rest of that same turn must NOT stream back in as a headless fragment.
    buffer.record(token("still the same turn"));
    expect(buffer.snapshot().events).toHaveLength(0);

    // …until the next turn begins, which is a boundary again.
    buffer.record(turnStart());
    buffer.record(token("fresh"));
    const snap = buffer.snapshot();
    expect(snap.events).toHaveLength(2);
    expect(snap.events[0]?.type).toBe("turn:start");
    expect(snap.truncated).toBe(true);
  });

  it("keeps prompts, which the engine never echoes", () => {
    const buffer = new TranscriptBuffer(1_000_000);
    buffer.record(turnStart());
    buffer.recordPrompt("what is this repo?", 1);
    expect(buffer.snapshot().prompts).toEqual([{ text: "what is this repo?", afterSeq: 1 }]);
  });

  it("keeps the prompt that opened the first turn it still holds", () => {
    const buffer = new TranscriptBuffer(900);
    buffer.record(turnStart());
    buffer.record(token("a".repeat(400)));
    // A prompt is recorded BEFORE the turn:start it causes, so it sits one sequence
    // behind the boundary. Filtering at the boundary itself dropped exactly the
    // question that opened the turn being kept.
    buffer.recordPrompt("the question that opened turn 2", 2);
    buffer.record(turnStart());
    buffer.record(token("b".repeat(400)));

    expect(buffer.snapshot().prompts.map((p) => p.text)).toEqual([
      "the question that opened turn 2",
    ]);
  });

  it("records a prompt that arrives while an oversized turn is being discarded", () => {
    const buffer = new TranscriptBuffer(1_000);
    buffer.record(turnStart());
    buffer.record(token("a".repeat(5_000))); // blows the budget alone
    // The next question necessarily arrives before the turn:start that clears the
    // discard flag. Dropping it here kept the answer and lost the question.
    buffer.recordPrompt("what happened?", 2);
    expect(buffer.snapshot().prompts.map((p) => p.text)).toEqual(["what happened?"]);
  });

  it("enforces the cap when prompts alone overflow it", () => {
    const buffer = new TranscriptBuffer(500);
    buffer.record(turnStart());
    for (let i = 0; i < 20; i++) buffer.recordPrompt("x".repeat(200), 1);
    // Prompts used to add to the byte count without ever triggering a trim, so the cap
    // was approached and never enforced.
    const snap = buffer.snapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.prompts.length).toBeLessThan(20);
  });

  it("drops prompts belonging to turns it no longer holds", () => {
    const buffer = new TranscriptBuffer(900);
    buffer.record(turnStart());
    buffer.recordPrompt("old question", 1);
    buffer.record(token("a".repeat(400)));
    buffer.record(turnStart());
    buffer.record(token("b".repeat(400)));

    // Replaying a question whose turn has been trimmed away would show it detached from
    // everything that answered it.
    expect(buffer.snapshot().prompts).toHaveLength(0);
  });
});
