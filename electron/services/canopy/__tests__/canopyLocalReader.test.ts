import { afterEach, describe, expect, it, vi } from "vitest";

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
    card_lines: [],
    card_mode: "headline",
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
      riskReason: null,
    });
    // A finished turn with work left uncommitted is never scored as cleanly done.
    const loose = await toCanopyReading(
      reading({ category: "finished", changes: "uncommitted", score: "20" }),
      input({ lines })
    ).words();
    expect(loose.attentionScore).toBeGreaterThanOrEqual(55);
  });

  it("puts a summary-only card's first line where the headline goes, and its second in the summary", async () => {
    const screen = ["⏺ Found it: the cache key ignored the locale.", "⏺ All 42 tests pass."];
    const card = await toCanopyReading(
      reading({
        category: "finished",
        card_mode: "summary-only",
        card_lines: [1, 0],
        status_line: 1,
        question_line: -1,
        option_lines: [],
      }),
      input({ lines: screen })
    ).words();
    // One paragraph: screen order.
    expect(card).toMatchObject({
      headline: "Found it: the cache key ignored the locale.",
      summary: "All 42 tests pass.",
    });
    const blank = await toCanopyReading(
      reading({ category: "working", card_mode: "summary-only", card_lines: [], status_line: -1 }),
      input({ lines: screen })
    ).words();
    expect(blank).toMatchObject({ headline: "", summary: "" });
  });

  it("raises an approval for an irreversible command to caution whatever the reader said", async () => {
    const screen = ["⏺ Bash(rm -rf dist)", "Do you want to proceed?", "1. Yes", "2. No"];
    const risky = await toCanopyReading(
      reading({ risk: "none", status_line: 0, question_line: 1, action_line: 0 }),
      input({ lines: screen })
    ).words();
    expect(risky.risk).toBe("caution");
    expect(risky.riskReason).toBe("Deletes files for good");
    // A caution is the second press and the top of the list: scored with the approvals.
    expect(risky.attentionScore).toBe(98);
    // The command is found on the dialog even when the reader picked no line for it.
    const unpicked = await toCanopyReading(
      reading({ risk: "none", status_line: -1, question_line: 3, action_line: -1 }),
      input({
        lines: [
          "⏺ Bash(git push --force)",
          "",
          "git push --force",
          "Do you want to proceed?",
          "1. Yes",
        ],
      })
    ).words();
    expect(unpicked.risk).toBe("caution");
    // But not a command from far above the prompt, in history the approval isn't about.
    const farAbove = await toCanopyReading(
      reading({ risk: "none", status_line: -1, question_line: 12, action_line: -1 }),
      input({
        lines: [
          "rm -rf dist",
          ...Array.from({ length: 10 }, (_, i) => `step ${i}`),
          "npm test",
          "Do you want to proceed?",
          "1. Yes",
        ],
      })
    ).words();
    expect(farAbove.risk).toBe("none");
    // The same screen for a harmless command stays as the reader read it.
    const calm = await toCanopyReading(
      reading({ risk: "none", status_line: 0, question_line: 1, action_line: 0 }),
      input({ lines: ["⏺ Bash(npm test)", ...screen.slice(1)] })
    ).words();
    expect(calm.risk).toBe("none");
    expect(calm.riskReason).toBeNull();
    // Never lowered: the reader's own caution stands for a command this doesn't know.
    const kept = await toCanopyReading(
      reading({ risk: "caution", status_line: 0, question_line: 1, action_line: 0 }),
      input({ lines: ["⏺ Bash(custom-deploy --prod)", ...screen.slice(1)] })
    ).words();
    expect(kept.risk).toBe("caution");
    // Only an approval is raised: a finished turn that mentions the command is not.
    const finished = await toCanopyReading(
      reading({ category: "finished", risk: "none", status_line: 0 }),
      input({ lines: ["⏺ Ran rm -rf dist and it passed"] })
    ).words();
    expect(finished.risk).toBe("none");
    expect(finished.riskReason).toBeNull();
  });

  it("reads a worktree agent's git -C command, and lets a merged-branch cleanup through", async () => {
    const ask = ["Do you want to proceed?", "1. Yes", "2. No"];
    // Only the action the reader picked carries the command: it is too far above
    // the prompt for the rows around it, and the headline is another line.
    const reset = await toCanopyReading(
      reading({
        risk: "none",
        status_line: 11,
        question_line: 12,
        action_line: 0,
        option_lines: [13, 14],
      }),
      input({
        lines: [
          "⏺ Bash(git -C /Users/me/wt reset --hard HEAD)",
          ...Array.from({ length: 10 }, (_, i) => `step ${i}`),
          "npm test",
          ...ask,
        ],
      })
    ).words();
    expect(reset.risk).toBe("caution");
    expect(reset.riskReason).toBe("Discards uncommitted changes");
    // `-d` refuses an unmerged branch: no second press, and no claim of lost work.
    const cleanup = await toCanopyReading(
      reading({ risk: "none", status_line: 0, question_line: 1, action_line: 0 }),
      input({ lines: ["⏺ Bash(git branch -d feature-x)", ...ask] })
    ).words();
    expect(cleanup.risk).toBe("none");
    expect(cleanup.riskReason).toBeNull();
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
  /**
   * Whether processes made from now on die on their first read, whether reads
   * fail with the process left standing, and how long processes take to load.
   */
  const behaviour: { dies: boolean; fails: boolean; loading: Promise<void> | null } = {
    dies: false,
    fails: false,
    loading: null,
  };

  /** A stand-in reader process: each read answers, or the process dies under it. */
  function fakeProcess(dir: string, onExit: () => void, lost: () => Error) {
    const process = {
      modelDir: dir,
      live: true,
      ready: behaviour.loading ?? Promise.resolve(),
      read: vi.fn(async (): Promise<{ reading: Reading; ms: number }> => {
        if (behaviour.fails) throw new Error("unreadable screen");
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

  /** Every reader a test made, let go after it so no idle timer outlives the test. */
  const readers: Array<{ release(): void }> = [];

  afterEach(() => {
    // Before the clock goes back to real: a timer left behind is cleared on the clock that made it.
    for (const made of readers.splice(0)) made.release();
    vi.useRealTimers();
  });

  async function harness(dir: string | null = "/models/light", idleMs?: number) {
    const { CanopyLocalReader } = await import("../canopyLocalReader.js");
    const { CanopyReaderError } = await import("../canopyReaderProcess.js");
    behaviour.dies = false;
    behaviour.fails = false;
    behaviour.loading = null;
    const made: Array<ReturnType<typeof fakeProcess>> = [];
    let modelDir = dir;
    let lookup: Promise<string | null> | null = null;
    const reader = new CanopyLocalReader(
      () => lookup ?? Promise.resolve(modelDir),
      (d, onExit) => {
        const p = fakeProcess(
          d,
          onExit,
          () => new CanopyReaderError("Reader process exited", true)
        );
        made.push(p);
        return p as never;
      },
      idleMs
    );
    readers.push(reader);
    return {
      reader,
      made,
      lost: (message = "Reader process exited") => new CanopyReaderError(message, true),
      setDir: (d: string | null) => (modelDir = d),
      /** Holds every model lookup until the returned function is called. */
      holdLookup: () => {
        let resolve!: (dir: string | null) => void;
        lookup = new Promise<string | null>((r) => (resolve = r));
        return () => {
          lookup = null;
          resolve(modelDir);
        };
      },
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

  it("starts nothing when the model didn't check out, and reports it rather than retrying", async () => {
    const h = await harness(null);
    await expect(h.reader.read(input({ lines }), signal())).rejects.toMatchObject({
      message: "model not available",
      transient: false,
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

  describe("idle", () => {
    const IDLE_MS = 60_000;

    it("lets the model go once nothing has been read for the idle period, and loads it again on the next read", async () => {
      vi.useFakeTimers();
      const h = await harness("/models/light", IDLE_MS);
      await h.reader.read(input({ lines }), signal());
      await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
      expect(h.made[0]!.retire).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.made[0]!.retire).toHaveBeenCalledTimes(1);
      expect(h.reader.loaded).toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      await expect(h.reader.read(input({ lines }), signal())).resolves.toMatchObject({
        classifier: { category: "approval" },
      });
      expect(h.made).toHaveLength(2);
      expect(h.reader.loaded).toBe(true);
    });

    it("starts the idle period over on every read", async () => {
      vi.useFakeTimers();
      const h = await harness("/models/light", IDLE_MS);
      await h.reader.read(input({ lines }), signal());
      await vi.advanceTimersByTimeAsync(IDLE_MS * 0.6);
      await h.reader.read(input({ lines }), signal());
      await vi.advanceTimersByTimeAsync(IDLE_MS * 0.6);
      expect(h.made[0]!.retire).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(IDLE_MS * 0.4);
      expect(h.made[0]!.retire).toHaveBeenCalledTimes(1);
      expect(h.made).toHaveLength(1);
    });

    it("never lets the model go while a read is finding the model, loading it or reading", async () => {
      vi.useFakeTimers();
      const h = await harness("/models/light", IDLE_MS);

      // Loading: the read that starts the process waits on it.
      let loaded!: () => void;
      behaviour.loading = new Promise<void>((resolve) => (loaded = resolve));
      const first = h.reader.read(input({ lines }), signal());
      await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
      expect(h.made).toHaveLength(1);
      expect(h.reader.retireIdle()).toBe(false);
      loaded();
      await expect(first).resolves.toMatchObject({ classifier: { category: "approval" } });
      behaviour.loading = null;

      // Finding the model: the folder lookup hasn't answered yet.
      const release = h.holdLookup();
      const second = h.reader.read(input({ lines }), signal());
      await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
      expect(h.reader.retireIdle()).toBe(false);
      release();
      await expect(second).resolves.toMatchObject({ classifier: { category: "approval" } });

      // Reading: the model has the screen.
      const p = h.made[0]!;
      let answer!: () => void;
      p.read.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = () => resolve({ reading: reading(), ms: 9 });
          })
      );
      const third = h.reader.read(input({ lines }), signal());
      await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
      expect(h.reader.retireIdle()).toBe(false);
      answer();
      await expect(third).resolves.toMatchObject({ classifier: { category: "approval" } });

      // One process read all three, and none of them lost it.
      expect(h.made).toHaveLength(1);
      expect(p.retire).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      expect(p.retire).toHaveBeenCalledTimes(1);
    });

    it("waits for the last of overlapping reads before the idle period starts", async () => {
      vi.useFakeTimers();
      const h = await harness("/models/light", IDLE_MS);
      await h.reader.read(input({ lines }), signal());
      const p = h.made[0]!;
      let answer!: () => void;
      p.read.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answer = () => resolve({ reading: reading(), ms: 9 });
          })
      );
      const slow = h.reader.read(input({ lines }), signal());
      await h.reader.read(input({ lines }), signal());
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
      expect(p.retire).not.toHaveBeenCalled();
      answer();
      await slow;
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      expect(p.retire).toHaveBeenCalledTimes(1);
    });

    it("drops the idle period with a process that exits on its own", async () => {
      vi.useFakeTimers();
      const h = await harness("/models/light", IDLE_MS);
      await h.reader.read(input({ lines }), signal());
      expect(vi.getTimerCount()).toBe(1);
      h.made[0]!.die();
      expect(vi.getTimerCount()).toBe(0);
      expect(h.reader.retireIdle()).toBe(false);
    });

    it("lets the model go on request only when it holds one, and only once", async () => {
      const h = await harness();
      expect(h.reader.retireIdle()).toBe(false);
      await h.reader.read(input({ lines }), signal());
      expect(h.reader.retireIdle()).toBe(true);
      expect(h.made[0]!.retire).toHaveBeenCalledTimes(1);
      expect(h.reader.retireIdle()).toBe(false);
      await h.reader.read(input({ lines }), signal());
      expect(h.made).toHaveLength(2);
    });

    it("keeps the process it started after an idle one, and its idle period, whenever the idle one exits", async () => {
      vi.useFakeTimers();
      const h = await harness("/models/light", IDLE_MS);
      await h.reader.read(input({ lines }), signal());
      h.reader.retireIdle();
      await h.reader.read(input({ lines }), signal());
      await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
      // The retired process's exit lands halfway through its successor's idle period.
      h.made[0]!.die();
      expect(h.reader.loaded).toBe(true);
      await vi.advanceTimersByTimeAsync(IDLE_MS / 2 - 1);
      expect(h.made[1]!.retire).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.made[1]!.retire).toHaveBeenCalledTimes(1);
      expect(h.made).toHaveLength(2);
    });

    it("gives a replacement model an idle period of its own", async () => {
      vi.useFakeTimers();
      const h = await harness("/models/light", IDLE_MS);
      await h.reader.read(input({ lines }), signal());
      await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
      h.setDir("/models/best");
      await h.reader.read(input({ lines }), signal());
      expect(h.made[0]!.retire).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
      expect(h.made[1]!.retire).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
      expect(h.made[1]!.retire).toHaveBeenCalledTimes(1);
    });

    it("replaces a process that gave up on its own rather than letting it go again", async () => {
      vi.useFakeTimers();
      const h = await harness("/models/light", IDLE_MS);
      await h.reader.read(input({ lines }), signal());
      // A wedged read or a slow load retires the process itself; its exit is still to come.
      h.made[0]!.live = false;
      expect(h.reader.retireIdle()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await h.reader.read(input({ lines }), signal());
      expect(h.made).toHaveLength(2);
      expect(h.reader.loaded).toBe(true);
    });

    it("leaves no idle period behind a read that a release cut short", async () => {
      vi.useFakeTimers();
      const h = await harness("/models/light", IDLE_MS);
      await h.reader.read(input({ lines }), signal());
      let fail!: () => void;
      h.made[0]!.read.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            fail = () => reject(h.lost());
          })
      );
      const cut = h.reader.read(input({ lines }), signal());
      await vi.advanceTimersByTimeAsync(0);
      h.reader.release();
      fail();
      await expect(cut).rejects.toMatchObject({ message: "request cancelled" });
      expect(vi.getTimerCount()).toBe(0);
      await h.reader.read(input({ lines }), signal());
      expect(h.made).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(1);
    });

    it("keeps counting crashes across idle spells, so a model that keeps dying stops being started", async () => {
      vi.useFakeTimers();
      const h = await harness("/models/light", IDLE_MS);
      const outcome = () =>
        h.reader.read(input({ lines }), signal()).then(
          () => "read",
          (e: { message: string; transient: boolean }) => (e.transient ? "retried" : e.message)
        );
      for (let spell = 0; spell < 2; spell++) {
        behaviour.dies = true;
        expect(await outcome()).toBe("retried");
        // The next process loads but reads nothing, and is let go when idle.
        behaviour.dies = false;
        behaviour.fails = true;
        expect(await outcome()).toBe("the model couldn't read this screen");
        behaviour.fails = false;
        expect(h.reader.loaded).toBe(true);
        await vi.advanceTimersByTimeAsync(IDLE_MS);
        expect(h.reader.loaded).toBe(false);
      }
      // The third loss in a row, two idle spells later, is reported, not retried.
      behaviour.dies = true;
      expect(await outcome()).toBe("the model stopped");
      const made = h.made.length;
      expect(await outcome()).toBe("the model keeps failing to run");
      expect(h.made).toHaveLength(made);
    });

    it("leaves no timer behind once the model is let go", async () => {
      vi.useFakeTimers();
      const h = await harness("/models/light", IDLE_MS);
      await h.reader.read(input({ lines }), signal());
      expect(vi.getTimerCount()).toBe(1);
      h.reader.release();
      expect(vi.getTimerCount()).toBe(0);
      await h.reader.read(input({ lines }), signal());
      h.reader.retireIdle();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("tryReaderModel", () => {
  function trialProcess(outcome: { load?: Error | "never"; read?: Error; exit?: "held" } = {}) {
    let exited!: () => void;
    const process = {
      ready:
        outcome.load === "never"
          ? new Promise<void>(() => {})
          : outcome.load
            ? Promise.reject(outcome.load)
            : Promise.resolve(),
      read: vi.fn(async () => {
        if (outcome.read) throw outcome.read;
        return { reading: reading(), ms: 9 };
      }),
      whenExited: new Promise<void>((resolve) => (exited = resolve)),
      retire: vi.fn(() => {
        if (outcome.exit !== "held") exited();
      }),
      exit: () => exited(),
    };
    process.ready.catch(() => {});
    return process;
  }

  it("loads the model in its own reader, reads one screen, and waits for that reader to exit", async () => {
    const { tryReaderModel } = await import("../canopyLocalReader.js");
    const p = trialProcess({ exit: "held" });
    const dirs: string[] = [];
    let done = false;
    const trying = tryReaderModel("/updates/abc.download", undefined, (dir) => {
      dirs.push(dir);
      return p as never;
    }).then(() => (done = true));
    await vi.waitFor(() => expect(p.retire).toHaveBeenCalledTimes(1));
    expect(dirs).toEqual(["/updates/abc.download"]);
    expect(p.read).toHaveBeenCalledTimes(1);
    // Its folder is not to be moved while it holds the files.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    p.exit();
    await trying;
    expect(done).toBe(true);
  });

  it.each([
    ["can't load", { load: new Error("This model needs a newer version of Daintree") }],
    ["can't read a screen", { read: new Error("Tokenizer has no [SEP]") }],
  ] as const)("throws for a model that %s, letting its reader go", async (_label, outcome) => {
    const { tryReaderModel } = await import("../canopyLocalReader.js");
    const p = trialProcess(outcome);
    await expect(tryReaderModel("/updates/abc.download", undefined, () => p as never)).rejects.toBe(
      "load" in outcome ? outcome.load : outcome.read
    );
    expect(p.retire).toHaveBeenCalledTimes(1);
  });

  it("stops a load once told to, letting its reader go", async () => {
    const { tryReaderModel } = await import("../canopyLocalReader.js");
    const p = trialProcess({ load: "never" });
    const stop = new AbortController();
    const trying = tryReaderModel("/updates/abc.download", stop.signal, () => p as never);
    stop.abort();
    const thrown = await trying.then(
      () => null,
      (e: unknown) => e
    );
    expect((thrown as Error).message).toBe("cancelled");
    expect(p.retire).toHaveBeenCalledTimes(1);
    expect(p.read).not.toHaveBeenCalled();
  });

  it("stops a read once told to, letting its reader go and its signal be", async () => {
    const { tryReaderModel } = await import("../canopyLocalReader.js");
    const p = trialProcess();
    p.read.mockImplementation(() => new Promise(() => {}));
    const stop = new AbortController();
    const removed = vi.spyOn(stop.signal, "removeEventListener");
    const trying = tryReaderModel("/updates/abc.download", stop.signal, () => p as never).then(
      () => null,
      (e: unknown) => e
    );
    await vi.waitFor(() => expect(p.read).toHaveBeenCalled());
    stop.abort();
    expect(((await trying) as Error).message).toBe("cancelled");
    expect(p.retire).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("says the reader hasn't exited ahead of why it failed, its folder not to be moved", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { tryReaderModel } = await import("../canopyLocalReader.js");
      const why = new Error("Tokenizer has no [SEP]");
      const p = trialProcess({ read: why, exit: "held" });
      const trying = tryReaderModel("/updates/abc.download", undefined, () => p as never).then(
        () => null,
        (e: unknown) => e
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const thrown = (await trying) as Error;
      expect(thrown.message).toMatch(/hasn't exited/);
      expect(thrown.cause).toBe(why);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a model whose reader won't exit to a later try, its folder not to be moved", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { tryReaderModel } = await import("../canopyLocalReader.js");
      const p = trialProcess({ exit: "held" });
      const trying = tryReaderModel("/updates/abc.download", undefined, () => p as never).then(
        () => null,
        (e: unknown) => e
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(((await trying) as Error).message).toMatch(/hasn't exited/);
    } finally {
      vi.useRealTimers();
    }
  });
});
