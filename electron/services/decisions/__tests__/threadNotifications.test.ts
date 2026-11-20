import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
  DecisionQuestionStall,
  DecisionQuestionStanding,
} from "../../../../shared/types/decisionsQuestion.js";
import { NOTIFIED_QUESTIONS_META_KEY } from "../questionNotifications.js";
import { projectDecisionQuestions } from "../questionList.js";
import { NO_ADVISORY_HOST } from "../questionRound.js";
import { answers, row } from "./questionRows.js";
import {
  NOTIFIED_THREAD_EVENTS_META_KEY,
  ThreadNotifier,
  type ThreadNotifierOptions,
} from "../threadNotifications.js";

const REPLY: DecisionQuestionStanding = { kind: "waiting", reason: "reply" };
const ATTENTION: DecisionQuestionStanding = {
  kind: "needs-attention",
  deliveryStatus: "needs-attention",
};

function question(
  questionId: string,
  events: { replyRequest?: string | null; stall?: DecisionQuestionStall | null } = {},
  overrides: { terminalId?: string; standing?: DecisionQuestionStanding } = {}
): DecisionQuestionListItem {
  const stall = events.stall ?? null;
  return {
    reference: {
      hostId: "host-1",
      projectId: "project-1",
      terminalId: overrides.terminalId ?? "term-1",
      questionId,
    },
    alias: 1,
    agentKind: "claude",
    projectLabel: "Daintree",
    worktreeId: "wt-1",
    worktreeRoot: "/repo",
    requirement: "proxy-ok",
    askedAt: "2026-11-17T10:00:00.000Z",
    expiresAt: null,
    settledAt: null,
    standing:
      overrides.standing ??
      (stall !== null ? ATTENTION : { kind: "settled", outcome: "answered", handled: false }),
    replyRequest: events.replyRequest ?? null,
    stall,
  };
}

const replying = (questionId: string, messageId: string) =>
  question(questionId, { replyRequest: messageId }, { standing: REPLY });

const stalled = (
  questionId: string,
  stall: Partial<DecisionQuestionStall> = {}
): DecisionQuestionListItem =>
  question(questionId, {
    stall: { answerRevision: 1, followUpIds: [], reason: "pane_gone", ...stall },
  });

/** The store's meta table: one record per key, as the Decisions store keeps it. */
function metaStore(initial: Record<string, string> = {}) {
  const meta = new Map(Object.entries(initial));
  return {
    meta,
    getMeta: vi.fn(async (key: string) => meta.get(key) ?? null),
    setMeta: vi.fn(async (key: string, value: string) => {
      meta.set(key, value);
    }),
  };
}

/** A store whose record already exists, as after any earlier run with this notifier. */
const recorded = () => metaStore({ [NOTIFIED_THREAD_EVENTS_META_KEY]: "[]" });

/** The shared list, as Decisions publishes it. */
function questionList(initial: DecisionQuestionListItem[] = []) {
  let list: DecisionQuestionList = { revision: 0, questions: initial };
  const listeners = new Set<(list: DecisionQuestionList) => void>();
  return {
    source: {
      get: () => list,
      onChange: (listener: (list: DecisionQuestionList) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    publish(questions: DecisionQuestionListItem[]) {
      list = { revision: list.revision + 1, questions };
      for (const listener of [...listeners]) listener(list);
    },
    listening: () => listeners.size,
  };
}

const notifiers: ThreadNotifier[] = [];

function notifier(
  store: ReturnType<typeof metaStore>,
  list: ReturnType<typeof questionList>,
  overrides: Partial<ThreadNotifierOptions> = {}
) {
  const showReply = vi.fn<ThreadNotifierOptions["showReply"]>();
  const showStall = vi.fn<ThreadNotifierOptions["showStall"]>();
  const close = vi.fn<ThreadNotifierOptions["close"]>();
  const made = new ThreadNotifier({
    store,
    questions: list.source,
    readOpeningLine: async (reference) => `Opening line of ${reference.questionId}`,
    notificationsOn: () => true,
    showReply,
    showStall,
    close,
    ...overrides,
  });
  notifiers.push(made);
  return { notifier: made, showReply, showStall, close };
}

/** Lets claims write and opening lines be read. */
async function settle(made: ThreadNotifier): Promise<void> {
  await made.settled();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const made of notifiers.splice(0)) made.stop();
});

describe("ThreadNotifier", () => {
  it("raises one notification for a follow-up asking for a reply, with the question's opening line", async () => {
    const store = recorded();
    const list = questionList();
    const { notifier: made, showReply, showStall } = notifier(store, list);
    await made.start();

    list.publish([replying("q-1", "ask-1")]);
    await settle(made);
    expect(showReply).toHaveBeenCalledTimes(1);
    const [shown, line, key] = showReply.mock.calls[0]!;
    expect(shown.replyRequest).toBe("ask-1");
    expect(line).toBe("Opening line of q-1");

    // The same request listed again is the same event.
    list.publish([replying("q-1", "ask-1"), question("q-2")]);
    await settle(made);
    expect(showReply).toHaveBeenCalledTimes(1);

    // The agent asking again, after the person replied, is a new one.
    list.publish([question("q-1"), question("q-2")]);
    list.publish([replying("q-1", "ask-2"), question("q-2")]);
    await settle(made);
    expect(showReply).toHaveBeenCalledTimes(2);
    expect(showReply.mock.calls[1]![0].replyRequest).toBe("ask-2");
    expect(showReply.mock.calls[1]![2]).not.toBe(key);
    expect(showStall).not.toHaveBeenCalled();
  });

  /** An opening-line read that waits until released, and says when it began. */
  function heldRead() {
    let release!: () => void;
    let began!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const reading = new Promise<void>((resolve) => (began = resolve));
    const readOpeningLine = vi.fn(async () => {
      began();
      await released;
      return "line";
    });
    return { readOpeningLine, reading, release };
  }

  it("never shows a follow-up replied to from the phone while its line was read", async () => {
    const store = recorded();
    const list = questionList();
    const read = heldRead();
    const { notifier: made, showReply } = notifier(store, list, {
      readOpeningLine: read.readOpeningLine,
    });
    await made.start();

    list.publish([replying("q-1", "ask-1")]);
    await read.reading;
    list.publish([question("q-1")]);
    read.release();
    await settle(made);
    expect(showReply).not.toHaveBeenCalled();
  });

  it("shows only the newer request when one superseded another while its line was read", async () => {
    const store = recorded();
    const list = questionList();
    const read = heldRead();
    const { notifier: made, showReply } = notifier(store, list, {
      readOpeningLine: read.readOpeningLine,
    });
    await made.start();

    list.publish([replying("q-1", "ask-1")]);
    await read.reading;
    list.publish([replying("q-1", "ask-2")]);
    await vi.waitFor(() => expect(read.readOpeningLine).toHaveBeenCalledTimes(2));
    read.release();
    await settle(made);
    expect(showReply.mock.calls.map(([shown]) => shown.replyRequest)).toEqual(["ask-2"]);
  });

  it("shows nothing again on restart or reconnect", async () => {
    const store = recorded();
    const list = questionList();
    const first = notifier(store, list);
    await first.notifier.start();
    list.publish([replying("q-1", "ask-1"), stalled("q-2")]);
    await settle(first.notifier);
    expect(first.showReply).toHaveBeenCalledTimes(1);
    expect(first.showStall).toHaveBeenCalledTimes(1);

    // Reconnecting: Decisions stops (the list empties) and lists the same again.
    list.publish([]);
    list.publish([replying("q-1", "ask-1"), stalled("q-2")]);
    await settle(first.notifier);
    expect(first.showReply).toHaveBeenCalledTimes(1);
    expect(first.showStall).toHaveBeenCalledTimes(1);
    first.notifier.stop();

    // Restarting: a new lifetime reads the saved record.
    const second = notifier(store, list);
    await second.notifier.start();
    await settle(second.notifier);
    expect(second.showReply).not.toHaveBeenCalled();
    expect(second.showStall).not.toHaveBeenCalled();
  });

  it("takes what was already pending as seen when it has no record yet, as on upgrading", async () => {
    // The questions' own record from #17232 exists; this one doesn't yet.
    const store = metaStore({ [NOTIFIED_QUESTIONS_META_KEY]: "[]" });
    const list = questionList([replying("q-1", "ask-1"), stalled("q-2")]);
    const { notifier: made, showReply, showStall } = notifier(store, list);
    await made.start();
    await settle(made);
    expect(showReply).not.toHaveBeenCalled();
    expect(showStall).not.toHaveBeenCalled();
    expect(JSON.parse(store.meta.get(NOTIFIED_THREAD_EVENTS_META_KEY)!)).toHaveLength(2);

    list.publish([replying("q-1", "ask-1"), stalled("q-2"), replying("q-3", "ask-3")]);
    await settle(made);
    expect(showReply).toHaveBeenCalledTimes(1);
    expect(showReply.mock.calls[0]![0].reference.questionId).toBe("q-3");
  });

  it("notifies an event that arrives while the record is read, even with no record yet", async () => {
    const store = metaStore();
    const list = questionList([stalled("q-1")]);
    let release!: (value: string | null) => void;
    store.getMeta.mockImplementationOnce(
      () => new Promise<string | null>((resolve) => (release = resolve))
    );
    const { notifier: made, showReply, showStall } = notifier(store, list);
    const started = made.start();
    list.publish([stalled("q-1"), replying("q-2", "ask-2")]);
    release(null);
    await started;
    await settle(made);
    expect(showStall).not.toHaveBeenCalled();
    expect(showReply).toHaveBeenCalledTimes(1);
  });

  it("raises one notification for an answer delivery stopped on, and again for each newly held follow-up", async () => {
    const store = recorded();
    const list = questionList();
    const { notifier: made, showStall } = notifier(store, list);
    await made.start();

    list.publish([stalled("q-1")]);
    await settle(made);
    expect(showStall).toHaveBeenCalledTimes(1);
    const [shown, key] = showStall.mock.calls[0]!;
    expect(shown.stall).toEqual({ answerRevision: 1, followUpIds: [], reason: "pane_gone" });

    // Its reason changing while it stays stopped is the same stall.
    list.publish([stalled("q-1", { reason: "resume_failed" })]);
    await settle(made);
    expect(showStall).toHaveBeenCalledTimes(1);

    // A follow-up the person sent after it stopping too is new, under the same banner.
    list.publish([stalled("q-1", { followUpIds: ["held-1"] })]);
    await settle(made);
    expect(showStall).toHaveBeenCalledTimes(2);
    expect(showStall.mock.calls[1]![1]).toBe(key);

    // Handling the answer leaves the follow-up, already told of.
    list.publish([stalled("q-1", { answerRevision: null, followUpIds: ["held-1"] })]);
    await settle(made);
    expect(showStall).toHaveBeenCalledTimes(2);
  });

  it("treats a stall that ended and came back as a new one: the next attempt stopped too", async () => {
    const store = recorded();
    const list = questionList();
    const { notifier: made, showStall } = notifier(store, list);
    await made.start();
    list.publish([stalled("q-1")]);
    await settle(made);
    list.publish([question("q-1", {}, { standing: { kind: "to-type" } })]);
    list.publish([stalled("q-1")]);
    await settle(made);
    expect(showStall).toHaveBeenCalledTimes(2);
  });

  it("keys events by the machine and question, so a question sent to another pane isn't new", async () => {
    const store = recorded();
    const list = questionList();
    const { notifier: made, showReply } = notifier(store, list);
    await made.start();
    list.publish([replying("q-1", "ask-1")]);
    await settle(made);
    list.publish([
      question("q-1", { replyRequest: "ask-1" }, { terminalId: "term-2", standing: REPLY }),
    ]);
    await settle(made);
    expect(showReply).toHaveBeenCalledTimes(1);

    // The same message id on another question is another request.
    list.publish([
      question("q-1", { replyRequest: "ask-1" }, { terminalId: "term-2", standing: REPLY }),
      replying("q-2", "ask-1"),
    ]);
    await settle(made);
    expect(showReply.mock.calls.map(([shown]) => shown.reference.questionId)).toEqual([
      "q-1",
      "q-2",
    ]);
  });

  it("shows only the latest attempt when a stall ends and comes back while the first is read", async () => {
    const store = recorded();
    const list = questionList();
    const releases: (() => void)[] = [];
    const prepare = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const { notifier: made, showStall } = notifier(store, list, { prepare });
    await made.start();

    list.publish([stalled("q-1")]);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    list.publish([question("q-1", {}, { standing: { kind: "to-type" } })]);
    list.publish([stalled("q-1", { reason: "resume_failed" })]);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));

    // The first attempt's delivery finishing shows nothing: the stall is the second's now.
    releases[0]!();
    await settle(made);
    expect(showStall).not.toHaveBeenCalled();
    releases[1]!();
    await settle(made);
    expect(showStall).toHaveBeenCalledTimes(1);
  });

  it("shows a grouped stall once what is still held of it is saved, though the first write failed", async () => {
    const store = recorded();
    store.setMeta.mockRejectedValueOnce(new Error("disk full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = questionList();
    const { notifier: made, showStall } = notifier(store, list);
    await made.start();

    list.publish([stalled("q-1", { followUpIds: ["held-1"] })]);
    // Handled before the failed write settles; the follow-up's claim saves on the next one.
    list.publish([stalled("q-1", { answerRevision: null, followUpIds: ["held-1"] })]);
    await settle(made);
    expect(showStall).toHaveBeenCalledTimes(1);
    expect(showStall.mock.calls[0]![0].stall?.answerRevision).toBeNull();
    expect(JSON.parse(store.meta.get(NOTIFIED_THREAD_EVENTS_META_KEY)!)).toHaveLength(1);
    warn.mockRestore();
  });

  it("closes a reply's banner once it is replied to, and a stall's once nothing on it is held", async () => {
    const store = recorded();
    const list = questionList();
    const { notifier: made, showReply, showStall, close } = notifier(store, list);
    await made.start();
    list.publish([replying("q-1", "ask-1"), stalled("q-2")]);
    await settle(made);
    const replyKey = showReply.mock.calls[0]![2];
    const stallKey = showStall.mock.calls[0]![1];

    // Decisions stopping takes nothing down.
    list.publish([]);
    expect(close).not.toHaveBeenCalled();

    list.publish([question("q-1"), stalled("q-2")]);
    expect(close.mock.calls).toEqual([[replyKey]]);
    list.publish([question("q-1"), question("q-2")]);
    expect(close.mock.calls).toEqual([[replyKey], [stallKey]]);
  });

  it("raises no stall for a question over without an answer, and closes one withdrawn after its answer stalled (#18021)", async () => {
    const store = recorded();
    const list = questionList();
    const { notifier: made, showStall, close } = notifier(store, list);
    await made.start();
    const listed = (rows: Parameters<typeof projectDecisionQuestions>[0]) =>
      projectDecisionQuestions(rows, new Map(), "host_1", NO_ADVISORY_HOST);
    const notice = { action: "expire", source: "system", sealed: null } as const;
    const closed = (["needs-attention", "delivery-uncertain"] as const).flatMap((status, i) => [
      row(10 + i * 2, {
        delivery_status: status,
        error_code: "pane_gone",
        local_status: "expired",
        answers_json: answers({ ...notice, kind: "expired" }),
      }),
      row(11 + i * 2, {
        delivery_status: status,
        error_code: "pane_gone",
        local_status: "publish-failed",
        answers_json: answers({ ...notice, kind: "unpublished" }),
      }),
    ]);
    const answer = {
      delivery_status: "needs-attention" as const,
      error_code: "pane_gone",
      local_status: "human-answered" as const,
      answers_json: answers({}),
    };

    list.publish(listed([...closed, row(1, answer)]));
    await settle(made);
    expect(showStall).toHaveBeenCalledTimes(1);
    expect(showStall.mock.calls[0]![0].reference.questionId).toBe(row(1).question_id);
    const key = showStall.mock.calls[0]![1];

    // Withdrawn: the library drops the answer and leaves the stopped status.
    list.publish(
      listed([
        ...closed,
        row(1, { ...answer, local_status: "cancelled", answers_json: answers({ deliver: false }) }),
      ])
    );
    await settle(made);
    expect(close.mock.calls).toEqual([[key]]);
    expect(showStall).toHaveBeenCalledTimes(1);
  });

  it("claims an event while notifications are off and never shows it", async () => {
    const store = recorded();
    const list = questionList();
    let on = false;
    const {
      notifier: made,
      showReply,
      showStall,
    } = notifier(store, list, {
      notificationsOn: () => on,
    });
    await made.start();
    list.publish([replying("q-1", "ask-1"), stalled("q-2")]);
    await settle(made);
    on = true;
    list.publish([replying("q-1", "ask-1"), stalled("q-2"), question("q-3")]);
    await settle(made);
    expect(showReply).not.toHaveBeenCalled();
    expect(showStall).not.toHaveBeenCalled();
    expect(JSON.parse(store.meta.get(NOTIFIED_THREAD_EVENTS_META_KEY)!)).toHaveLength(2);

    made.stop();
    const restarted = notifier(store, list);
    await restarted.notifier.start();
    await settle(restarted.notifier);
    expect(restarted.showReply).not.toHaveBeenCalled();
    expect(restarted.showStall).not.toHaveBeenCalled();
  });

  it("stays silent for its lifetime when the record can't be read", async () => {
    const store = recorded();
    store.getMeta.mockRejectedValueOnce(new Error("busy"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = questionList();
    const { notifier: made, showReply } = notifier(store, list);
    await made.start();
    list.publish([replying("q-1", "ask-1")]);
    await settle(made);
    expect(showReply).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("shows nothing it couldn't save the claim for, and claims it afresh on the next change", async () => {
    const store = recorded();
    store.setMeta.mockRejectedValueOnce(new Error("disk full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = questionList();
    const { notifier: made, showStall } = notifier(store, list);
    await made.start();
    list.publish([stalled("q-1")]);
    await settle(made);
    expect(showStall).not.toHaveBeenCalled();

    list.publish([stalled("q-1"), question("q-2")]);
    await settle(made);
    expect(showStall).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("takes back every claim of a stall it couldn't save, so what is still held shows later", async () => {
    const store = recorded();
    store.setMeta.mockRejectedValueOnce(new Error("disk full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = questionList();
    const { notifier: made, showStall } = notifier(store, list);
    await made.start();
    list.publish([stalled("q-1", { followUpIds: ["held-1"] })]);
    await settle(made);
    expect(showStall).not.toHaveBeenCalled();
    expect(JSON.parse(store.meta.get(NOTIFIED_THREAD_EVENTS_META_KEY)!)).toEqual([]);

    // The answer is dealt with before the next change; its follow-up still isn't.
    list.publish([stalled("q-1", { answerRevision: null, followUpIds: ["held-1"] })]);
    await settle(made);
    expect(showStall).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("shows nothing once stopped, even what it was readying, and stops following the list", async () => {
    const store = recorded();
    const list = questionList();
    const read = heldRead();
    const { notifier: made, showReply } = notifier(store, list, {
      readOpeningLine: read.readOpeningLine,
    });
    await made.start();
    expect(list.listening()).toBe(1);
    list.publish([replying("q-1", "ask-1")]);
    await read.reading;
    made.stop();
    read.release();
    await settle(made);
    expect(showReply).not.toHaveBeenCalled();
    expect(list.listening()).toBe(0);
  });
});
