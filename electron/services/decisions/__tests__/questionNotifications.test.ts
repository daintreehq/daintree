import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
  DecisionQuestionStanding,
} from "../../../../shared/types/decisionsQuestion.js";
import {
  MAX_SETTLED_CLAIMS,
  NOTIFIED_QUESTIONS_META_KEY,
  QuestionNotifier,
  questionKey,
  type QuestionNotifierOptions,
} from "../questionNotifications.js";

const STARTED = Date.parse("2026-11-17T10:00:00.000Z");
const AFTER = new Date(STARTED + 60_000).toISOString();
const BEFORE = new Date(STARTED - 60_000).toISOString();

const OPEN: DecisionQuestionStanding = { kind: "waiting", reason: "open" };

function question(
  questionId: string,
  standing: DecisionQuestionStanding = OPEN,
  overrides: { askedAt?: string; hostId?: string; projectId?: string; terminalId?: string } = {}
): DecisionQuestionListItem {
  return {
    reference: {
      hostId: overrides.hostId ?? "host-1",
      projectId: overrides.projectId ?? "project-1",
      terminalId: overrides.terminalId ?? "term-1",
      questionId,
    },
    alias: 1,
    agentKind: "claude",
    projectLabel: "Daintree",
    worktreeId: "wt-1",
    worktreeRoot: "/repo",
    requirement: "proxy-ok",
    askedAt: overrides.askedAt ?? AFTER,
    expiresAt: null,
    settledAt: null,
    standing,
    replyRequest: null,
    stall: null,
  };
}

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

/** The shared list, as Decisions publishes it. */
function questionList() {
  let list: DecisionQuestionList = { revision: 0, questions: [] };
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

const notifiers: QuestionNotifier[] = [];

function notifier(
  store: ReturnType<typeof metaStore>,
  list: ReturnType<typeof questionList>,
  overrides: Partial<QuestionNotifierOptions> = {}
) {
  const show = vi.fn<QuestionNotifierOptions["show"]>();
  const close = vi.fn<QuestionNotifierOptions["close"]>();
  const made = new QuestionNotifier({
    store,
    questions: list.source,
    readOpeningLine: async (reference) => `Opening line of ${reference.questionId}`,
    notificationsOn: () => true,
    show,
    close,
    now: () => STARTED,
    ...overrides,
  });
  notifiers.push(made);
  return { notifier: made, show, close };
}

/** Lets claims write and opening lines be read. */
async function settle(made: QuestionNotifier): Promise<void> {
  await made.settled();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The keys the store's record holds now. */
const recordOf = (store: ReturnType<typeof metaStore>): string[] =>
  JSON.parse(store.meta.get(NOTIFIED_QUESTIONS_META_KEY) ?? "[]");

function shownIds(show: ReturnType<typeof notifier>["show"]): string[] {
  return show.mock.calls.map(([asked]) => asked.reference.questionId);
}

/** A store whose record already exists, as after any earlier run. */
const recorded = (keys: string[] = []) =>
  metaStore({ [NOTIFIED_QUESTIONS_META_KEY]: JSON.stringify(keys) });

afterEach(() => {
  for (const made of notifiers.splice(0)) made.stop();
});

describe("QuestionNotifier", () => {
  it("shows a newly asked question once, with its opening line, through queued and open", async () => {
    const store = recorded();
    const list = questionList();
    const { notifier: made, show } = notifier(store, list);
    await made.start();

    list.publish([question("q-1", { kind: "queued" })]);
    await settle(made);
    expect(show).toHaveBeenCalledTimes(1);
    list.publish([question("q-1", OPEN)]);
    await settle(made);

    expect(show).toHaveBeenCalledTimes(1);
    const [asked, line, key] = show.mock.calls[0]!;
    expect(asked.reference.questionId).toBe("q-1");
    expect(line).toBe("Opening line of q-1");
    expect(key).toBe(questionKey(asked.reference));
  });

  it("shows a question only once its claim is saved in the store", async () => {
    const store = recorded();
    let saved!: () => void;
    store.setMeta.mockImplementationOnce(async (key: string, value: string) => {
      await new Promise<void>((resolve) => (saved = resolve));
      store.meta.set(key, value);
    });
    const list = questionList();
    const { notifier: made, show } = notifier(store, list);
    await made.start();

    list.publish([question("q-1")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(show).not.toHaveBeenCalled();

    saved();
    await settle(made);
    expect(shownIds(show)).toEqual(["q-1"]);
  });

  it("shows nothing for a claim the store didn't save, so a restart shows it then", async () => {
    const store = recorded();
    store.setMeta.mockRejectedValueOnce(new Error("SQLITE_FULL"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = questionList();
    const first = notifier(store, list);
    await first.notifier.start();
    list.publish([question("q-1")]);
    await settle(first.notifier);
    first.notifier.stop();
    expect(first.show).not.toHaveBeenCalled();

    const second = notifier(store, list);
    await second.notifier.start();
    await settle(second.notifier);

    expect(shownIds(second.show)).toEqual(["q-1"]);
    warn.mockRestore();
  });

  it("tries a claim the store didn't save again on the list's next change", async () => {
    const store = recorded();
    store.setMeta.mockRejectedValueOnce(new Error("SQLITE_BUSY"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = questionList();
    const { notifier: made, show } = notifier(store, list);
    await made.start();
    list.publish([question("q-1")]);
    await settle(made);
    expect(show).not.toHaveBeenCalled();

    list.publish([question("q-1"), question("q-2")]);
    await settle(made);

    expect(shownIds(show)).toEqual(["q-1", "q-2"]);
    warn.mockRestore();
  });

  it("shows a saved claim without waiting on writes queued after it", async () => {
    const store = recorded();
    store.setMeta
      .mockImplementationOnce(async (key: string, value: string) => {
        store.meta.set(key, value);
      })
      .mockImplementationOnce(() => new Promise<void>(() => {}));
    const list = questionList();
    const { notifier: made, show } = notifier(store, list);
    await made.start();

    list.publish([question("q-1")]);
    // Another question's write queues behind it, and never finishes.
    list.publish([question("q-1"), question("q-2")]);
    await vi.waitFor(() => expect(shownIds(show)).toEqual(["q-1"]));
  });

  it("shows a claim a later write saved after an earlier one failed", async () => {
    const store = recorded();
    let fail!: () => void;
    store.setMeta.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (fail = () => reject(new Error("SQLITE_BUSY"))))
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = questionList();
    const { notifier: made, show } = notifier(store, list);
    await made.start();

    list.publish([question("q-1")]);
    list.publish([question("q-1"), question("q-2")]);
    await vi.waitFor(() => expect(store.setMeta).toHaveBeenCalledTimes(1));
    fail();
    await settle(made);

    expect(shownIds(show).sort()).toEqual(["q-1", "q-2"]);
    expect(recordOf(store)).toContain(questionKey(question("q-1").reference));
    warn.mockRestore();
  });

  it("shows nothing when what presents it can't be readied, and waits for it otherwise", async () => {
    const list = questionList();
    const failed = notifier(recorded(), list, {
      prepare: async () => {
        throw new Error("no presenter");
      },
    });
    await failed.notifier.start();
    let ready!: () => void;
    const waiting = notifier(recorded(), list, {
      prepare: () => new Promise<void>((resolve) => (ready = resolve)),
    });
    await waiting.notifier.start();

    list.publish([question("q-1")]);
    await settle(waiting.notifier);
    expect(waiting.show).not.toHaveBeenCalled();
    ready();
    await settle(waiting.notifier);

    expect(failed.show).not.toHaveBeenCalled();
    expect(shownIds(waiting.show)).toEqual(["q-1"]);
  });

  it.each<[string, DecisionQuestionStanding]>([
    ["answered by the person", { kind: "settled", outcome: "answered", handled: false }],
    ["answered by the model and waiting to be typed", { kind: "to-type" }],
    ["withdrawn", { kind: "settled", outcome: "withdrawn" }],
  ])("shows nothing for a question %s while its opening line was read", async (_case, standing) => {
    const store = recorded();
    const list = questionList();
    let answer!: (line: string) => void;
    const { notifier: made, show } = notifier(store, list, {
      readOpeningLine: () => new Promise((resolve) => (answer = resolve)),
    });
    await made.start();

    list.publish([question("q-1")]);
    await settle(made);
    list.publish([question("q-1", standing)]);
    answer("Should I?");
    await settle(made);

    expect(show).not.toHaveBeenCalled();
  });

  it("shows nothing for a question already settled or answered when first listed", async () => {
    const list = questionList();
    const { notifier: made, show } = notifier(recorded(), list);
    await made.start();

    list.publish([
      question("q-1", { kind: "settled", outcome: "answered", handled: false }),
      question("q-2", { kind: "waiting", reason: "reply" }),
      question("q-3", { kind: "send-failed" }),
    ]);
    await settle(made);

    expect(show).not.toHaveBeenCalled();
  });

  it("never shows a question again after a restart, and still shows the next one asked", async () => {
    const store = recorded();
    const list = questionList();
    const first = notifier(store, list);
    await first.notifier.start();
    list.publish([question("q-1")]);
    await settle(first.notifier);
    first.notifier.stop();

    const second = notifier(store, list);
    await second.notifier.start();
    list.publish([question("q-1"), question("q-2")]);
    await settle(second.notifier);

    expect(shownIds(first.show)).toEqual(["q-1"]);
    expect(shownIds(second.show)).toEqual(["q-2"]);
  });

  it("keeps questions apart by every part of their reference, a Remote Host's included", async () => {
    const store = recorded();
    const list = questionList();
    const { notifier: made, show, close } = notifier(store, list);
    await made.start();
    const asked = [
      question("q-1"),
      question("q-1", OPEN, { hostId: "host-2" }),
      question("q-1", OPEN, { projectId: "project-2" }),
      question("q-1", OPEN, { terminalId: "term-2" }),
    ];

    list.publish(asked);
    await settle(made);
    list.publish(asked.map((item) => ({ ...item, standing: { kind: "to-type" } })));
    await settle(made);

    const keys = asked.map((item) => questionKey(item.reference));
    expect(new Set(keys).size).toBe(4);
    expect(show.mock.calls.map(([, , key]) => key)).toEqual(keys);
    expect(recordOf(store)).toEqual(keys);
    expect(close.mock.calls.map(([key]) => key)).toEqual(keys);
  });

  it.each([
    ["no record yet", metaStore()],
    ["a damaged record", metaStore({ [NOTIFIED_QUESTIONS_META_KEY]: "{not json" })],
  ])("with %s takes the questions asked before it started as seen", async (_case, store) => {
    const list = questionList();
    list.publish([question("q-old", OPEN, { askedAt: BEFORE })]);
    const { notifier: made, show } = notifier(store, list);
    await made.start();

    list.publish([
      question("q-old", OPEN, { askedAt: BEFORE }),
      question("q-new", OPEN, { askedAt: AFTER }),
    ]);
    await settle(made);

    expect(shownIds(show)).toEqual(["q-new"]);
    // Both are claimed, so the next run shows neither.
    const next = notifier(store, list);
    await next.notifier.start();
    await settle(next.notifier);
    expect(next.show).not.toHaveBeenCalled();
  });

  it("takes only the first list as seen: a question first listed later shows, whenever it was asked", async () => {
    const list = questionList();
    const { notifier: made, show } = notifier(metaStore(), list);
    await made.start();

    // A Remote Host's question asked while it was away, listed once it is back.
    list.publish([question("q-host", OPEN, { askedAt: BEFORE, hostId: "host-2" })]);
    await settle(made);

    expect(shownIds(show)).toEqual(["q-host"]);
  });

  it("shows nothing while notifications are off, and nothing later for what was asked then", async () => {
    const store = recorded();
    const list = questionList();
    let on = false;
    const { notifier: made, show } = notifier(store, list, { notificationsOn: () => on });
    await made.start();

    list.publish([question("q-1")]);
    await settle(made);
    on = true;
    list.publish([question("q-1"), question("q-2")]);
    await settle(made);

    expect(shownIds(show)).toEqual(["q-2"]);
  });

  it("shows without an opening line it couldn't read", async () => {
    const list = questionList();
    const { notifier: made, show } = notifier(recorded(), list, {
      readOpeningLine: async () => {
        throw new Error("sealed");
      },
    });
    await made.start();

    list.publish([question("q-1")]);
    await settle(made);

    expect(show).toHaveBeenCalledWith(expect.anything(), null, expect.any(String));
  });

  it("takes a shown notification down once its question stops waiting, keeping its claim", async () => {
    const store = recorded();
    const list = questionList();
    const { notifier: made, close } = notifier(store, list);
    await made.start();
    list.publish([question("q-1"), question("q-2")]);
    await settle(made);

    list.publish([
      question("q-1", { kind: "send-failed" }),
      question("q-2", { kind: "settled", outcome: "expired" }),
    ]);
    await settle(made);

    const keys = [question("q-1"), question("q-2")].map((asked) => questionKey(asked.reference));
    expect(close.mock.calls.map(([key]) => key)).toEqual(keys);
    expect(recordOf(store)).toEqual(keys);
  });

  it("never shows a withdrawn question again once it is reopened", async () => {
    const list = questionList();
    const { notifier: made, show } = notifier(recorded(), list);
    await made.start();
    list.publish([question("q-1")]);
    await settle(made);

    list.publish([question("q-1", { kind: "settled", outcome: "withdrawn" })]);
    await settle(made);
    list.publish([question("q-1", OPEN)]);
    await settle(made);

    expect(shownIds(show)).toEqual(["q-1"]);
  });

  it("keeps claims for the newest settled questions only, past its cap", async () => {
    const settled = Array.from({ length: MAX_SETTLED_CLAIMS + 2 }, (_, index) =>
      question(`q-${index}`, { kind: "settled", outcome: "answered", handled: false })
    );
    const keys = settled.map((item) => questionKey(item.reference));
    const waiting = question("q-waiting", { kind: "to-type" });
    const store = recorded([questionKey(waiting.reference), ...keys]);
    const list = questionList();
    const { notifier: made } = notifier(store, list);
    await made.start();

    list.publish([...settled, waiting]);
    await settle(made);

    expect(recordOf(store)).toEqual([questionKey(waiting.reference), ...keys.slice(2)]);
  });

  it("lets go of the claims of questions removed from this computer's history, and no others (#18033)", async () => {
    const removed = question("q-removed", { kind: "settled", outcome: "expired" });
    const kept = question("q-kept", { kind: "settled", outcome: "expired" });
    const sameIdElsewhere = question(
      "q-removed",
      { kind: "settled", outcome: "expired" },
      { hostId: "host-2" }
    );
    // The same question claimed again after it moved terminals.
    const moved = question(
      "q-removed",
      { kind: "settled", outcome: "expired" },
      { terminalId: "term-2" }
    );
    const keys = [removed, kept, sameIdElsewhere, moved].map((item) => questionKey(item.reference));
    const store = recorded(keys);
    const list = questionList();
    const { notifier: made } = notifier(store, list);
    await made.start();
    list.publish([removed, kept, sameIdElsewhere]);
    await settle(made);

    made.forget("host-1", new Set(["q-removed"]));
    await settle(made);

    expect(recordOf(store)).toEqual([keys[1], keys[2]]);
    // Nothing left to forget writes nothing.
    const writes = store.setMeta.mock.calls.length;
    made.forget("host-1", new Set(["q-removed"]));
    await settle(made);
    expect(store.setMeta.mock.calls.length).toBe(writes);
  });

  it("keeps its notifications and claims when the list empties as Decisions stops", async () => {
    const store = recorded();
    const list = questionList();
    const { notifier: made, close } = notifier(store, list);
    await made.start();
    list.publish([question("q-1")]);
    await settle(made);
    const before = store.meta.get(NOTIFIED_QUESTIONS_META_KEY);

    list.publish([]);
    await settle(made);

    expect(close).not.toHaveBeenCalled();
    expect(store.meta.get(NOTIFIED_QUESTIONS_META_KEY)).toBe(before);
  });

  it("stays silent when its record can't be read", async () => {
    const store = recorded();
    store.getMeta.mockRejectedValueOnce(new Error("SQLITE_BUSY"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = questionList();
    const { notifier: made, show } = notifier(store, list);
    await made.start();

    list.publish([question("q-1")]);
    await settle(made);

    expect(show).not.toHaveBeenCalled();
    expect(list.listening()).toBe(0);
    warn.mockRestore();
  });

  it("shows nothing once stopped, even for a read that lands after", async () => {
    const list = questionList();
    let answer!: (line: string) => void;
    const { notifier: made, show } = notifier(recorded(), list, {
      readOpeningLine: () => new Promise((resolve) => (answer = resolve)),
    });
    await made.start();
    list.publish([question("q-1")]);
    await settle(made);

    made.stop();
    answer("Should I?");
    await settle(made);
    list.publish([question("q-2")]);
    await settle(made);

    expect(show).not.toHaveBeenCalled();
    expect(list.listening()).toBe(0);
  });
});

describe("QuestionNotifier following (#17240)", () => {
  it("follows once its record is read, says so, and says so again when it stops", async () => {
    const onFollowing = vi.fn();
    const list = questionList();
    const { notifier: made } = notifier(recorded(), list, { onFollowing });
    expect(made.following).toBe(false);

    await made.start();
    expect(made.following).toBe(true);
    expect(list.listening()).toBe(1);
    expect(onFollowing).toHaveBeenCalledTimes(1);

    made.stop();
    expect(made.following).toBe(false);
    expect(onFollowing).toHaveBeenCalledTimes(2);
    made.stop();
    expect(onFollowing).toHaveBeenCalledTimes(2);
  });

  it("never follows a lifetime whose record couldn't be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onFollowing = vi.fn();
    const store = metaStore();
    store.getMeta.mockRejectedValueOnce(new Error("database is locked"));
    const { notifier: made } = notifier(store, questionList(), { onFollowing });

    await made.start();
    expect(made.following).toBe(false);
    expect(onFollowing).not.toHaveBeenCalled();
    made.stop();
    expect(onFollowing).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("doesn't follow when stopped while its record was being read", async () => {
    const onFollowing = vi.fn();
    const { notifier: made } = notifier(recorded(), questionList(), { onFollowing });
    const starting = made.start();
    made.stop();
    await starting;
    expect(made.following).toBe(false);
    expect(onFollowing).not.toHaveBeenCalled();
  });
});
