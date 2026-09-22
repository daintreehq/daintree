import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WriteQueue, type SubmitExecutionContext, type WriteQueueOptions } from "../WriteQueue.js";
import type { TerminalSubmitStatusState } from "../../../../shared/types/pty-host.js";
import { MAX_RETAINED_SUBMISSIONS } from "../../../../shared/types/terminalSubmission.js";

/**
 * Submission correlation (#12337) — the ledger `terminal.getStatus` reads.
 *
 * Deliberately separate from `WriteQueue.test.ts`: that file covers the
 * slow/stalled reporting lane, and the point of these tests is that the two are
 * different axes. A submit can be delivered without ever emitting a status
 * event, and can emit `settled` without having been delivered.
 */

interface Harness {
  performSubmit: ReturnType<
    typeof vi.fn<(text: string, ctx: SubmitExecutionContext) => Promise<void>>
  >;
  statuses: TerminalSubmitStatusState[];
  /** What the terminal's viewport tracker last stamped, as `lastOutputChangeAt`. */
  outputChangeAt: { value: number | undefined };
  options: WriteQueueOptions;
}

function makeHarness(): Harness {
  const performSubmit = vi.fn<(text: string, ctx: SubmitExecutionContext) => Promise<void>>(
    async (_text, ctx) => {
      ctx.markPtyWritten();
    }
  );
  const statuses: TerminalSubmitStatusState[] = [];
  const outputChangeAt: { value: number | undefined } = { value: undefined };
  return {
    performSubmit,
    statuses,
    outputChangeAt,
    options: {
      isExited: () => false,
      lastOutputTime: () => Date.now(),
      lastOutputChangeAt: () => outputChangeAt.value,
      performSubmit: (text, ctx) => performSubmit(text, ctx),
      onSubmitStatus: (state) => statuses.push(state),
    },
  };
}

describe("WriteQueue submission ledger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a fast submit as pty_written even though it emits no status event", async () => {
    const h = makeHarness();
    const wq = new WriteQueue(h.options);

    wq.submit("hello", "tok-1");
    await vi.runAllTimersAsync();

    // The existing slow/stalled vocabulary only fires for submits that cross a
    // threshold, so a normal submit reports nothing there. That is exactly why
    // it could not double as a delivery signal.
    expect(h.statuses).toEqual([]);
    expect(wq.getSubmission("tok-1")).toMatchObject({ token: "tok-1", phase: "pty_written" });
  });

  it("keeps every token in a burst separately queryable", async () => {
    const h = makeHarness();
    const wq = new WriteQueue(h.options);

    // The reason last-submission-only was rejected: submissions serialise on
    // one lane, so a burst of three would leave the first two unanswerable.
    wq.submit("one", "tok-1");
    wq.submit("two", "tok-2");
    wq.submit("three", "tok-3");
    await vi.runAllTimersAsync();

    expect(wq.getSubmission("tok-1")?.phase).toBe("pty_written");
    expect(wq.getSubmission("tok-2")?.phase).toBe("pty_written");
    expect(wq.getSubmission("tok-3")?.phase).toBe("pty_written");
  });

  it("records cancelled when performSubmit resolves without writing the Enter", async () => {
    const h = makeHarness();
    // Every guard in performSubmit returns normally, so a resolved promise is
    // compatible with nothing having been written — the silent loss #12337 is
    // about.
    h.performSubmit.mockImplementation(async () => {});
    const wq = new WriteQueue(h.options);

    wq.submit("hello", "tok-1");
    await vi.runAllTimersAsync();

    expect(wq.getSubmission("tok-1")?.phase).toBe("cancelled");
  });

  it("records failed when the submit rejects", async () => {
    const h = makeHarness();
    h.performSubmit.mockRejectedValue(new Error("EPIPE: broken pipe"));
    const wq = new WriteQueue(h.options);

    wq.submit("hello", "tok-1");
    await vi.runAllTimersAsync();

    expect(wq.getSubmission("tok-1")?.phase).toBe("failed");
  });

  it("reports queued before the lane reaches it and writing while it holds it", async () => {
    const h = makeHarness();
    let release: (() => void) | undefined;
    h.performSubmit.mockImplementation(
      (_text, ctx) =>
        new Promise<void>((resolve) => {
          release = () => {
            ctx.markPtyWritten();
            resolve();
          };
        })
    );
    const wq = new WriteQueue(h.options);

    wq.submit("first", "tok-1");
    wq.submit("second", "tok-2");
    await vi.advanceTimersByTimeAsync(0);

    expect(wq.getSubmission("tok-1")?.phase).toBe("writing");
    expect(wq.getSubmission("tok-2")?.phase).toBe("queued");

    release?.();
    await vi.runAllTimersAsync();
    expect(wq.getSubmission("tok-1")?.phase).toBe("pty_written");
  });

  it("cancels queued submissions on cancelPendingInput without disturbing the one in flight", async () => {
    const h = makeHarness();
    let markWritten: (() => void) | undefined;
    let release: (() => void) | undefined;
    h.performSubmit.mockImplementation(
      (_text, ctx) =>
        new Promise<void>((resolve) => {
          markWritten = () => ctx.markPtyWritten();
          release = resolve;
        })
    );
    const wq = new WriteQueue(h.options);

    wq.submit("first", "tok-1");
    wq.submit("second", "tok-2");
    await vi.advanceTimersByTimeAsync(0);

    // The in-flight submit has already handed its bytes over; only what has not
    // been written yet is genuinely cancelled.
    markWritten?.();
    wq.cancelPendingInput();
    release?.();
    await vi.runAllTimersAsync();

    expect(wq.getSubmission("tok-1")?.phase).toBe("pty_written");
    expect(wq.getSubmission("tok-2")?.phase).toBe("cancelled");
  });

  it("keeps the first final phase when a later one would overwrite it", async () => {
    const h = makeHarness();
    // markPtyWritten fires, then the submit rejects on its way out. The bytes
    // still went to the pty, so the hand-off is the honest answer.
    h.performSubmit.mockImplementation(async (_text, ctx) => {
      ctx.markPtyWritten();
      throw new Error("late failure");
    });
    const wq = new WriteQueue(h.options);

    wq.submit("hello", "tok-1");
    await vi.runAllTimersAsync();

    expect(wq.getSubmission("tok-1")?.phase).toBe("pty_written");
  });

  it("retains no record for an untracked submit", async () => {
    const h = makeHarness();
    const wq = new WriteQueue(h.options);

    // In-app typing and fleet broadcast pass no token, so they must not grow
    // the ledger at all — and above all must not evict tracked history.
    wq.submit("tracked", "tok-keep");
    for (let i = 0; i < MAX_RETAINED_SUBMISSIONS * 2; i++) wq.submit("typed by a person");
    await vi.runAllTimersAsync();

    expect(wq.getSubmission("tok-keep")?.phase).toBe("pty_written");
  });

  it("evicts the oldest finalised record past the retention bound", async () => {
    const h = makeHarness();
    const wq = new WriteQueue(h.options);

    for (let i = 0; i < MAX_RETAINED_SUBMISSIONS + 1; i++) {
      wq.submit(`text-${i}`, `tok-${i}`);
    }
    await vi.runAllTimersAsync();

    expect(wq.getSubmission("tok-0")).toBeUndefined();
    expect(wq.getSubmission("tok-1")?.phase).toBe("pty_written");
    expect(wq.getSubmission(`tok-${MAX_RETAINED_SUBMISSIONS}`)?.phase).toBe("pty_written");
  });

  it("answers a submit into a disposed queue rather than leaving it unrecorded", async () => {
    const h = makeHarness();
    const wq = new WriteQueue(h.options);
    wq.dispose();

    wq.submit("hello", "tok-1");
    await vi.runAllTimersAsync();

    // `cancelled` says Daintree dropped it. Silence would read back as
    // `unknown`, which cannot be told apart from a token never seen here.
    expect(wq.getSubmission("tok-1")?.phase).toBe("cancelled");
    expect(h.performSubmit).not.toHaveBeenCalled();
  });

  it("returns a copy so a reader cannot mutate the ledger", async () => {
    const h = makeHarness();
    const wq = new WriteQueue(h.options);

    wq.submit("hello", "tok-1");
    await vi.runAllTimersAsync();

    const record = wq.getSubmission("tok-1");
    expect(record).toBeDefined();
    record!.phase = "failed";
    expect(wq.getSubmission("tok-1")?.phase).toBe("pty_written");
  });

  it("returns a copy of a still-pending record too", async () => {
    const h = makeHarness();
    let release: (() => void) | undefined;
    h.performSubmit.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const wq = new WriteQueue(h.options);

    wq.submit("first", "tok-1");
    await vi.advanceTimersByTimeAsync(0);

    // The pending map holds live objects that the queue mutates in place, so
    // handing one out unwrapped would let a reader rewrite the ledger.
    const pending = wq.getSubmission("tok-1");
    pending!.phase = "pty_written";
    expect(wq.getSubmission("tok-1")?.phase).toBe("writing");

    release?.();
    await vi.runAllTimersAsync();
  });

  it("does not resurrect an evicted record when its own continuation unwinds", async () => {
    const h = makeHarness();
    let markWritten: (() => void) | undefined;
    let release: (() => void) | undefined;
    let first = true;
    h.performSubmit.mockImplementation((_text, ctx) => {
      if (!first) {
        ctx.markPtyWritten();
        return Promise.resolve();
      }
      first = false;
      return new Promise<void>((resolve) => {
        markWritten = () => ctx.markPtyWritten();
        release = resolve;
      });
    });
    const wq = new WriteQueue(h.options);

    wq.submit("first", "tok-1");
    await vi.advanceTimersByTimeAsync(0);
    // The first submission genuinely reached the pty...
    markWritten?.();
    expect(wq.getSubmission("tok-1")?.phase).toBe("pty_written");

    // ...then enough later submissions are queued and dropped to evict its
    // record before its own drain continuation resumes.
    for (let i = 0; i < MAX_RETAINED_SUBMISSIONS; i++) wq.submit(`later-${i}`, `evict-${i}`);
    wq.cancelPendingInput();
    expect(wq.getSubmission("tok-1")).toBeUndefined();

    release?.();
    await vi.runAllTimersAsync();

    // Aged out is `unknown`, which is honest. Writing a fresh `cancelled` here
    // would report a delivered submission as dropped — worse than saying
    // nothing, because a client would act on it.
    expect(wq.getSubmission("tok-1")).toBeUndefined();
  });

  it("keeps one record per token when a token is reused", async () => {
    const h = makeHarness();
    const wq = new WriteQueue(h.options);

    wq.submit("first", "tok-1");
    await vi.runAllTimersAsync();
    expect(wq.getSubmission("tok-1")?.phase).toBe("pty_written");

    h.performSubmit.mockImplementation(async () => {});
    wq.submit("second", "tok-1");
    await vi.runAllTimersAsync();

    // Two records for one token would let `getSubmission` answer with the
    // stale success while the live submission had actually been dropped.
    expect(wq.getSubmission("tok-1")?.phase).toBe("cancelled");
  });

  it("answers a token reused while still in flight with the in-flight submission", async () => {
    const h = makeHarness();
    let markWritten: (() => void) | undefined;
    let release: (() => void) | undefined;
    let first = true;
    h.performSubmit.mockImplementation((_text, ctx) => {
      if (!first) return Promise.reject(new Error("write EPIPE"));
      first = false;
      return new Promise<void>((resolve) => {
        markWritten = () => ctx.markPtyWritten();
        release = resolve;
      });
    });
    const wq = new WriteQueue(h.options);

    wq.submit("first", "tok-1");
    await vi.advanceTimersByTimeAsync(0);
    // Reuse while the first is still writing. Reuse is the caller's error —
    // `sendCommand` mints a UUID per call — and the documented consequence is
    // that the record keeps describing the submission already in flight.
    wq.submit("second", "tok-1");
    markWritten?.();
    release?.();
    await vi.runAllTimersAsync();

    expect(wq.getSubmission("tok-1")?.phase).toBe("pty_written");
    // Both texts still reached the lane; only the record is ambiguous, and it
    // must not be a fabricated failure for a submission that was delivered.
    expect(h.performSubmit).toHaveBeenCalledTimes(2);
  });

  it("does not push an in-flight submission back to queued when its token is reused", async () => {
    const h = makeHarness();
    let release: (() => void) | undefined;
    h.performSubmit.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const wq = new WriteQueue(h.options);

    wq.submit("first", "tok-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(wq.getSubmission("tok-1")?.phase).toBe("writing");

    wq.submit("second", "tok-1");

    expect(wq.getSubmission("tok-1")?.phase).toBe("writing");
    release?.();
    await vi.runAllTimersAsync();
  });

  it("holds a queued submission at queued while an earlier one blocks the lane", async () => {
    const h = makeHarness();
    // #11875: a submit that never settles keeps the lane on purpose. Anything
    // behind it is genuinely still queued and must say so rather than time out
    // into a terminal phase.
    h.performSubmit.mockImplementation(() => new Promise<void>(() => {}));
    const wq = new WriteQueue(h.options);

    wq.submit("blocker", "tok-blocker");
    wq.submit("behind", "tok-behind");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(wq.getSubmission("tok-blocker")?.phase).toBe("writing");
    expect(wq.getSubmission("tok-behind")?.phase).toBe("queued");
  });

  it("cancels queued followers on dispose but keeps an already-written outcome", async () => {
    const h = makeHarness();
    let markWritten: (() => void) | undefined;
    let release: (() => void) | undefined;
    h.performSubmit.mockImplementation(
      (_text, ctx) =>
        new Promise<void>((resolve) => {
          markWritten = () => ctx.markPtyWritten();
          release = resolve;
        })
    );
    const wq = new WriteQueue(h.options);

    wq.submit("first", "tok-1");
    wq.submit("second", "tok-2");
    await vi.advanceTimersByTimeAsync(0);

    markWritten?.();
    wq.dispose();
    release?.();
    await vi.runAllTimersAsync();

    expect(wq.getSubmission("tok-1")?.phase).toBe("pty_written");
    expect(wq.getSubmission("tok-2")?.phase).toBe("cancelled");
    expect(h.performSubmit).toHaveBeenCalledTimes(1);
  });

  it("reports an untracked submit's failure through the existing status lane", async () => {
    const h = makeHarness();
    // Behaviour change from the strict-write fix: a synchronous pty error
    // during a submit now rejects rather than being swallowed into the log, so
    // it reaches `failed` — and therefore the pane banner — even with no token.
    // That is what `failed` is documented to be for: the composer may hold a
    // partial body with no Enter behind it.
    h.performSubmit.mockRejectedValue(new Error("write EPIPE"));
    const wq = new WriteQueue(h.options);

    wq.submit("typed by a person");
    await vi.runAllTimersAsync();

    expect(h.statuses).toEqual(["failed"]);
  });

  it("records cancelled for a submission refused before the lane sees it", () => {
    const h = makeHarness();
    const wq = new WriteQueue(h.options);

    wq.noteRejectedSubmission("tok-1");

    expect(wq.getSubmission("tok-1")?.phase).toBe("cancelled");
  });
});

/**
 * #12478: whether the screen moved after a delivered Enter. Timing only — the
 * queue orders a change after the write and never attributes it.
 */
describe("WriteQueue outputChangeAfterWriteAt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function deliver(wq: WriteQueue, token = "tok-1"): Promise<number> {
    wq.submit("hello", token);
    await vi.runAllTimersAsync();
    const record = wq.getSubmission(token);
    expect(record?.phase).toBe("pty_written");
    return record!.at!;
  }

  it("is absent while no viewport change has been observed at all", async () => {
    const h = makeHarness();
    const wq = new WriteQueue(h.options);

    await deliver(wq);

    // The reported failure: `pty_written`, and a screen that never moved.
    expect(wq.getSubmission("tok-1")).not.toHaveProperty("outputChangeAfterWriteAt");
  });

  it("ignores a change stamped before the Enter", async () => {
    const h = makeHarness();
    const wq = new WriteQueue(h.options);
    const at = await deliver(wq);

    h.outputChangeAt.value = at - 50;

    expect(wq.getSubmission("tok-1")).not.toHaveProperty("outputChangeAfterWriteAt");
  });

  it("ignores a change stamped within one sampling interval of the Enter, boundary included", async () => {
    const h = makeHarness();
    const wq = new WriteQueue(h.options);
    const at = await deliver(wq);

    // A body echo arriving just before the Enter is sampled up to 200ms later,
    // so it can be stamped just after it. Nothing in this window is placeable.
    h.outputChangeAt.value = at + 10;
    expect(wq.getSubmission("tok-1")).not.toHaveProperty("outputChangeAfterWriteAt");
    h.outputChangeAt.value = at + 200;
    expect(wq.getSubmission("tok-1")).not.toHaveProperty("outputChangeAfterWriteAt");

    h.outputChangeAt.value = at + 201;
    expect(wq.getSubmission("tok-1")?.outputChangeAfterWriteAt).toBe(at + 201);
  });

  it("does not let an in-window change qualify just because the read comes later", async () => {
    const h = makeHarness();
    const wq = new WriteQueue(h.options);
    const at = await deliver(wq);

    h.outputChangeAt.value = at + 150;
    await vi.advanceTimersByTimeAsync(60_000);

    // Qualification is about when the change was stamped, not how long ago the
    // Enter was.
    expect(wq.getSubmission("tok-1")).not.toHaveProperty("outputChangeAfterWriteAt");
  });

  it("reports the latest change, re-read on every lookup", async () => {
    const h = makeHarness();
    const wq = new WriteQueue(h.options);
    const at = await deliver(wq);

    h.outputChangeAt.value = at + 500;
    expect(wq.getSubmission("tok-1")?.outputChangeAfterWriteAt).toBe(at + 500);

    h.outputChangeAt.value = at + 4_000;
    expect(wq.getSubmission("tok-1")?.outputChangeAfterWriteAt).toBe(at + 4_000);
  });

  it("is still derivable once later submissions have joined the retained ring", async () => {
    const h = makeHarness();
    const wq = new WriteQueue(h.options);
    const at = await deliver(wq, "tok-1");
    await vi.advanceTimersByTimeAsync(1_000);
    for (let i = 2; i <= 5; i++) await deliver(wq, `tok-${i}`);

    // Only `{token, phase, at}` is retained, so the value comes from the
    // terminal at read time — and a later submission's output satisfies the
    // earlier record too. That is the ordering-not-attribution caveat.
    h.outputChangeAt.value = Date.now() + 1_000;

    const first = wq.getSubmission("tok-1");
    expect(first?.at).toBe(at);
    expect(first?.outputChangeAfterWriteAt).toBe(h.outputChangeAt.value);
    expect(wq.getSubmission("tok-5")?.outputChangeAfterWriteAt).toBe(h.outputChangeAt.value);
  });

  it("derives the value rather than storing it on the record", async () => {
    const h = makeHarness();
    const wq = new WriteQueue(h.options);
    const at = await deliver(wq);

    h.outputChangeAt.value = at + 1_000;
    const read = wq.getSubmission("tok-1")!;
    read.outputChangeAfterWriteAt = 1;

    expect(wq.getSubmission("tok-1")?.outputChangeAfterWriteAt).toBe(at + 1_000);
  });

  it("is never reported for a submission still queued or writing", async () => {
    const h = makeHarness();
    h.performSubmit.mockImplementation(() => new Promise<void>(() => {}));
    const wq = new WriteQueue(h.options);

    wq.submit("first", "tok-1");
    wq.submit("second", "tok-2");
    await vi.advanceTimersByTimeAsync(1);
    h.outputChangeAt.value = Date.now() + 10_000;

    // A body still being written echoes on its own; with no Enter out there is
    // nothing to order the change after.
    expect(wq.getSubmission("tok-1")).toMatchObject({ phase: "writing" });
    expect(wq.getSubmission("tok-1")).not.toHaveProperty("outputChangeAfterWriteAt");
    expect(wq.getSubmission("tok-2")).toMatchObject({ phase: "queued" });
    expect(wq.getSubmission("tok-2")).not.toHaveProperty("outputChangeAfterWriteAt");
  });

  it("is never reported for a failed or cancelled submission", async () => {
    const h = makeHarness();
    h.performSubmit
      .mockImplementationOnce(async () => {
        throw new Error("write EPIPE");
      })
      .mockImplementationOnce(async () => {});
    const wq = new WriteQueue(h.options);

    wq.submit("first", "tok-failed");
    wq.submit("second", "tok-cancelled");
    await vi.runAllTimersAsync();
    h.outputChangeAt.value = Date.now() + 10_000;

    expect(wq.getSubmission("tok-failed")).toMatchObject({ phase: "failed" });
    expect(wq.getSubmission("tok-failed")).not.toHaveProperty("outputChangeAfterWriteAt");
    expect(wq.getSubmission("tok-cancelled")).toMatchObject({ phase: "cancelled" });
    expect(wq.getSubmission("tok-cancelled")).not.toHaveProperty("outputChangeAfterWriteAt");
  });
});
