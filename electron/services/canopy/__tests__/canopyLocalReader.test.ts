import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));

import { readerState, toCanopyReading } from "../canopyLocalReader.js";
import type { Reading } from "../canopyReader.js";
import type { CanopyScreenInput } from "../canopyProviders.js";

function input(over: Partial<CanopyScreenInput> = {}): CanopyScreenInput {
  return {
    agent: "claude",
    title: "✳ Fix the login bug",
    screen: "",
    lines: [],
    observed: { agentState: null, waitingReason: null, secondsInState: null },
    ...over,
  };
}

function reading(over: Partial<Reading> = {}): Reading {
  return {
    category: "approval",
    category_probs: [0.9, 0.05, 0.01, 0.01, 0.01, 0.01, 0.01],
    needs_attention: 0.97,
    needs_attention_raw: 0.9,
    blocked_on_user: 0.96,
    notable: 0.8,
    question_line: 1,
    status_line: 1,
    action_line: 0,
    task_line: -1,
    summary_lines: [],
    option_lines: [2, 3],
    tests: "unknown",
    changes: "unknown",
    risk: "none",
    instruction: "none",
    progress: "none",
    failure_repeats: "0",
    score: "92",
    ...over,
  };
}

describe("readerState", () => {
  it("writes the state in the order the model was trained on, whole seconds, unknowns left out", () => {
    const state = readerState(
      input({
        observed: {
          agentState: "waiting",
          waitingReason: "prompt",
          secondsInState: 12.4,
          screenUnchangedSeconds: 9,
        },
        userAction: { kind: "replied", secondsAgo: 40.6, screenChangedSince: true },
      })
    );
    expect(JSON.stringify(state)).toBe(
      '{"agent_program":"claude","terminal_title":"✳ Fix the login bug","daintree_observed":{"agent_state":"waiting","waiting_reason":"prompt","seconds_in_state":12,"screen_unchanged_seconds":9},"user_action":"replied","seconds_since_user_action":41,"screen_changed_since_user_action":true}'
    );
  });

  it("leaves out what Daintree didn't observe, and the user action when there was none", () => {
    expect(JSON.stringify(readerState(input({ title: "" })))).toBe(
      '{"agent_program":"claude","terminal_title":""}'
    );
    const some = readerState(
      input({ observed: { agentState: "working", waitingReason: null, secondsInState: null } })
    );
    expect(some.daintree_observed).toEqual({ agent_state: "working" });
  });
});

describe("toCanopyReading", () => {
  const lines = [
    "npm test",
    "│ Do you want to proceed?        │",
    "│ ❯ 1. Yes                       │",
    "│   2. No                        │",
  ];

  it("gives the verdict at once, quoting only lines the screen shows", () => {
    const { classifier } = toCanopyReading(reading(), input({ lines }));
    expect(classifier).toMatchObject({
      category: "approval",
      confidence: 0.9,
      attention: 0.97,
      blocked: 0.96,
      notable: 0.8,
      question: "Do you want to proceed?",
      status: "Do you want to proceed?",
    });
  });

  it("asks nothing for a reading that isn't an ask", () => {
    const { classifier } = toCanopyReading(
      reading({ category: "working", question_line: 1 }),
      input({ lines })
    );
    expect(classifier.question).toBeNull();
  });

  it("writes the words on demand, held to the score bands their facts set", async () => {
    const { words } = toCanopyReading(reading(), input({ lines }));
    const card = await words();
    expect(card).toMatchObject({
      category: "approval",
      headline: "Do you want to proceed?",
      question: "Do you want to proceed?",
      options: ["1. Yes", "2. No"],
      action: "npm test",
      attentionScore: 92,
      note: null,
      riskReason: null,
    });
    // A finished turn with work left uncommitted is never scored as cleanly done.
    const loose = await toCanopyReading(
      reading({ category: "finished", changes: "uncommitted", score: "20" }),
      input({ lines })
    ).words();
    expect(loose.attentionScore).toBeGreaterThanOrEqual(55);
  });

  it("counts three or more repeats as three, capped where the screen hasn't moved", async () => {
    const many = await toCanopyReading(
      reading({ category: "working", failure_repeats: "3+" }),
      input({ lines })
    ).words();
    expect(many.failureRepeats).toBe(3);
    const capped = await toCanopyReading(
      reading({ category: "working", failure_repeats: "3+" }),
      input({ lines, failureRepeatsCap: 1 })
    ).words();
    expect(capped.failureRepeats).toBe(1);
  });

  it("refuses a category this build doesn't know", () => {
    expect(() => toCanopyReading(reading({ category: "dreaming" }), input({ lines }))).toThrow(
      "unexpected category"
    );
  });
});

describe("CanopyLocalReader", () => {
  /** Whether processes made from now on die on their first read. */
  const behaviour = { dies: false };

  /** A stand-in reader process: each read answers, or the process dies under it. */
  function fakeProcess(dir: string, onExit: () => void, lost: () => Error) {
    const process = {
      modelDir: dir,
      live: true,
      ready: Promise.resolve(),
      read: vi.fn(async () => {
        if (!behaviour.dies) return { reading: reading(), ms: 9 };
        process.die();
        throw lost();
      }),
      retire: vi.fn(() => {
        process.live = false;
      }),
      die() {
        process.live = false;
        onExit();
      },
    };
    return process;
  }

  async function harness(dir: string | null = "/models/light") {
    const { CanopyLocalReader } = await import("../canopyLocalReader.js");
    const { CanopyReaderError } = await import("../canopyReaderProcess.js");
    behaviour.dies = false;
    const made: Array<ReturnType<typeof fakeProcess>> = [];
    let modelDir = dir;
    const reader = new CanopyLocalReader(
      async () => modelDir,
      (d, onExit) => {
        const p = fakeProcess(
          d,
          onExit,
          () => new CanopyReaderError("Reader process exited", true)
        );
        made.push(p);
        return p as never;
      }
    );
    return {
      reader,
      made,
      lost: (message = "Reader process exited") => new CanopyReaderError(message, true),
      setDir: (d: string | null) => (modelDir = d),
    };
  }

  const signal = () => new AbortController().signal;
  const lines = ["npm test", "Do you want to proceed?", "1. Yes", "2. No"];

  it("starts one process on the first read and reads every screen with it", async () => {
    const h = await harness();
    expect(h.made).toHaveLength(0);
    await h.reader.read(input({ lines }), signal());
    await h.reader.read(input({ lines }), signal());
    expect(h.made).toHaveLength(1);
    expect(h.made[0]!.read).toHaveBeenCalledTimes(2);
  });

  it("starts nothing while the model isn't here, and says it is on its way", async () => {
    const h = await harness(null);
    await expect(h.reader.read(input({ lines }), signal())).rejects.toMatchObject({
      message: "model not downloaded",
      transient: true,
    });
    expect(h.made).toHaveLength(0);
  });

  it("swaps the process when the model changes, and lets it go on release", async () => {
    const h = await harness();
    await h.reader.read(input({ lines }), signal());
    h.setDir("/models/best");
    await h.reader.read(input({ lines }), signal());
    expect(h.made.map((p) => p.modelDir)).toEqual(["/models/light", "/models/best"]);
    expect(h.made[0]!.retire).toHaveBeenCalled();
    h.reader.release();
    expect(h.made[1]!.retire).toHaveBeenCalled();
    expect(h.reader.loaded).toBe(false);
  });

  it("replaces a process that died, and gives up after three in a row until one reads", async () => {
    const h = await harness();
    behaviour.dies = true;
    const outcomes: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      outcomes.push(
        await h.reader.read(input({ lines }), signal()).then(
          () => "read",
          (e: { transient: boolean }) => e.transient
        )
      );
    }
    // Retried twice; the third loss in a row is reported, not retried.
    expect(outcomes).toEqual([true, true, false]);
    const made = h.made.length;
    await expect(h.reader.read(input({ lines }), signal())).rejects.toMatchObject({
      message: "the model keeps failing to run",
    });
    // No fourth process.
    expect(h.made).toHaveLength(made);
    // A release (Canopy off and on, or a model change) starts over.
    h.reader.release();
    behaviour.dies = false;
    await expect(h.reader.read(input({ lines }), signal())).resolves.toMatchObject({
      classifier: { category: "approval" },
    });
    expect(h.made).toHaveLength(made + 1);
  });

  it("counts a process lost under two reads as one crash", async () => {
    const h = await harness();
    await h.reader.read(input({ lines }), signal());
    const p = h.made[0]!;
    const rejecters: Array<(error: Error) => void> = [];
    p.read.mockImplementation(
      () => new Promise((_, reject) => rejecters.push(reject as (error: Error) => void))
    );
    const both = Promise.allSettled([
      h.reader.read(input({ lines }), signal()),
      h.reader.read(input({ lines }), signal()),
    ]);
    await vi.waitFor(() => expect(rejecters).toHaveLength(2));
    p.die();
    for (const reject of rejecters) reject(h.lost());
    await both;
    // One crash so far: the next process may die too and still be retried.
    behaviour.dies = true;
    await expect(h.reader.read(input({ lines }), signal())).rejects.toMatchObject({
      transient: true,
    });
    await expect(h.reader.read(input({ lines }), signal())).rejects.toMatchObject({
      transient: false,
    });
  });

  it("says a model this build can't read needs a newer Daintree, and doesn't retry it", async () => {
    const h = await harness();
    await h.reader.read(input({ lines }), signal());
    const p = h.made[0]!;
    p.read.mockRejectedValueOnce(h.lost("This model needs a newer version of Daintree"));
    await expect(h.reader.read(input({ lines }), signal())).rejects.toMatchObject({
      message: "the model needs a newer version",
      transient: false,
    });
  });

  it("drops an answer for a read cancelled while the model ran", async () => {
    const h = await harness();
    const controller = new AbortController();
    const pending = h.reader.read(input({ lines }), controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ message: "request cancelled" });
  });

  it("doesn't count a read that a release cut short against the model", async () => {
    const h = await harness();
    await h.reader.read(input({ lines }), signal());
    const p = h.made[0]!;
    p.read.mockImplementation(async () => {
      h.reader.release();
      throw h.lost();
    });
    await expect(h.reader.read(input({ lines }), signal())).rejects.toMatchObject({
      message: "request cancelled",
    });
  });
});
