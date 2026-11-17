import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DecisionQuestionList,
  DecisionQuestionListItem,
  DecisionQuestionStanding,
} from "../../../../shared/types/decisionsQuestion.js";
import {
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
  overrides: { askedAt?: string; hostId?: string; terminalId?: string } = {}
): DecisionQuestionListItem {
  return {
    reference: {
      hostId: overrides.hostId ?? "host-1",
      projectId: "project-1",
      terminalId: overrides.terminalId ?? "term-1",
      questionId,
    },
    alias: 1,
    agentKind: "claude",
    projectLabel: "Daintree",
    worktreeId: "wt-1",
    worktreeRoot: "/repo",
    requirement: "human-preferred",
    askedAt: overrides.askedAt ?? AFTER,
    expiresAt: null,
    settledAt: null,
    standing,
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
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

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
    list.publish([question("q-1", OPEN)]);
    await settle(made);

    expect(show).toHaveBeenCalledTimes(1);
    const [asked, line, key] = show.mock.calls[0]!;
    expect(asked.reference.questionId).toBe("q-1");
    expect(line).toBe("Opening line of q-1");
    expect(key).toBe(questionKey(asked.reference));
  });

  it("claims a question in the store before it shows", async () => {
    const store = recorded();
    const list = questionList();
    const claimedWhenShown: boolean[] = [];
    const { notifier: made } = notifier(store, list, {
      show: (_asked, _line, key) => {
        const record: string[] = JSON.parse(store.meta.get(NOTIFIED_QUESTIONS_META_KEY)!);
        claimedWhenShown.push(record.includes(key));
      },
    });
    await made.start();

    list.publish([question("q-1")]);
    await settle(made);

    expect(claimedWhenShown).toEqual([true]);
  });

  it.each<[string, DecisionQuestionStanding]>([
    ["answered by the person", { kind: "settled", outcome: "answered", handled: false }],
    ["answered by the model and waiting to be typed", { kind: "to-type" }],
    ["withdrawn", { kind: "settled", outcome: "withdrawn" }],
  ])(
    "shows nothing for a question %s while its opening line was read",
    async (_case, standing) => {
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
    }
  );

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

  it("keeps a Remote Host's question with the same ids apart from this computer's", async () => {
    const list = questionList();
    const { notifier: made, show } = notifier(recorded(), list);
    await made.start();

    list.publish([question("q-1"), question("q-1", OPEN, { hostId: "host-2" })]);
    await settle(made);

    expect(show.mock.calls.map(([asked]) => asked.reference.hostId)).toEqual([
      "host-1",
      "host-2",
    ]);
  });

  it.each([
    ["no record yet", metaStore()],
    ["a damaged record", metaStore({ [NOTIFIED_QUESTIONS_META_KEY]: "{not json" })],
  ])(
    "with %s takes the questions asked before it started as seen",
    async (_case, store) => {
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
    }
  );

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

  it("takes a shown notification down once its question stops waiting, and lets go of a settled one's claim", async () => {
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
    // One that failed to send can be sent again, and stays claimed; an expired one never waits again.
    expect(JSON.parse(store.meta.get(NOTIFIED_QUESTIONS_META_KEY)!)).toEqual([keys[0]]);
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
