import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTerminalInputStore } from "../terminalInputStore";
import {
  subscribeDictationRangeTracking,
  useDictationRangeStore,
  type DictationRecord,
} from "../dictationRangeStore";

const PANEL = "panel-1";
const PROJECT = "project-1";
const SESSION = "session-1";
const target = { sessionId: SESSION, panelId: PANEL, projectId: PROJECT };

const draft = () => useTerminalInputStore.getState().getDraftInput(PANEL, PROJECT);
const setDraft = (value: string) =>
  useTerminalInputStore.getState().setDraftInput(PANEL, value, PROJECT);
const records = () => useDictationRangeStore.getState().listDictations(PANEL, PROJECT);
const only = (): DictationRecord => {
  const list = records();
  expect(list).toHaveLength(1);
  return list[0]!;
};
const textOf = (range: { from: number; to: number }) => draft().slice(range.from, range.to);

/** Appends an utterance the way the voice service does: write, then record. */
function dictate(words: string, sessionTarget = target): void {
  const base = draft();
  const separator = base && !base.endsWith(" ") && !base.endsWith("\n") ? " " : "";
  setDraft(base + separator + words);
  const from = base.length + separator.length;
  useDictationRangeStore.getState().recordUtterance(sessionTarget, {
    insertion: { from: base.length, to: from + words.length },
    words: { from, to: from + words.length },
  });
}

function edit(from: number, to: number, insert: string): void {
  const current = draft();
  setDraft(current.slice(0, from) + insert + current.slice(to));
}

let unsubscribe: () => void;

beforeEach(() => {
  useTerminalInputStore.setState({ draftInputs: new Map() });
  useDictationRangeStore.setState({ drafts: {} });
  unsubscribe = subscribeDictationRangeTracking();
});

afterEach(() => {
  unsubscribe();
});

describe("dictationRangeStore", () => {
  it("records the words and the separator the utterance inserted", () => {
    setDraft("Fix the bug.");
    dictate("hello world");

    const record = only();
    expect(record.sessionId).toBe(SESSION);
    expect(textOf(record.range)).toBe(" hello world");
    expect(textOf(record.utterances[0]!.range)).toBe("hello world");
    expect(textOf(record.utterances[0]!.insertion)).toBe(" hello world");
    expect(record.range.edited).toBe(false);
  });

  it("grows one record over a session's utterances and paragraph breaks", () => {
    dictate("first");
    const before = draft();
    setDraft(before + "\n");
    useDictationRangeStore
      .getState()
      .recordParagraphBreak(target, { from: before.length, to: before.length + 1 });
    dictate("second");

    const record = only();
    expect(textOf(record.range)).toBe("first\nsecond");
    expect(record.range.edited).toBe(false);
    expect(record.utterances.map((u) => textOf(u.range))).toEqual(["first", "second"]);
    expect(new Set(record.utterances.map((u) => u.id)).size).toBe(2);
  });

  it("flags the dictation, not its utterances, when typed text ends up between them", () => {
    dictate("first");
    setDraft(draft() + " typed");
    dictate("second");

    const record = only();
    expect(textOf(record.range)).toBe("first typed second");
    expect(record.range.edited).toBe(true);
    expect(record.utterances.map((u) => u.range.edited)).toEqual([false, false]);
  });

  it("keeps separate records for separate sessions in one draft", () => {
    dictate("one");
    dictate("two", { ...target, sessionId: "session-2" });

    const [first, second] = records();
    expect(textOf(first!.range)).toBe("one");
    expect(textOf(second!.range)).toBe(" two");
    expect(first!.id).not.toBe(second!.id);
  });

  describe("through draft edits", () => {
    beforeEach(() => {
      setDraft("Intro.");
      dictate("alpha beta");
      dictate("gamma");
    });

    it("shifts when text is typed before the dictation", () => {
      edit(0, 0, "Please read. ");
      const record = only();
      expect(textOf(record.range)).toBe(" alpha beta gamma");
      expect(record.utterances.map((u) => textOf(u.range))).toEqual(["alpha beta", "gamma"]);
      expect(record.range.edited).toBe(false);
    });

    it("stays put when text is typed after the dictation", () => {
      const before = only();
      setDraft(draft() + " Thanks.");
      expect(only()).toEqual(before);
    });

    it("flags only the utterance whose words were edited", () => {
      // Inside "alpha beta".
      edit(12, 12, ",");
      const record = only();
      expect(textOf(record.utterances[0]!.range)).toBe("alpha, beta");
      expect(record.utterances[0]!.range.edited).toBe(true);
      expect(record.utterances[1]!.range).toMatchObject({ edited: false });
      expect(textOf(record.utterances[1]!.range)).toBe("gamma");
      expect(record.range.edited).toBe(true);
    });

    it("trims and flags ranges a delete crosses into", () => {
      // Deletes "o. alp".
      edit(4, 10, "");
      expect(draft()).toBe("Intrha beta gamma");
      const record = only();
      expect(textOf(record.range)).toBe("ha beta gamma");
      expect(record.range.edited).toBe(true);
      expect(textOf(record.utterances[0]!.range)).toBe("ha beta");
      expect(record.utterances[0]!.range.edited).toBe(true);
      expect(record.utterances[1]!.range.edited).toBe(false);
    });

    it("trims a delete across the end of an utterance", () => {
      // Deletes "beta g".
      edit(13, 19, "");
      expect(draft()).toBe("Intro. alpha amma");
      const record = only();
      expect(textOf(record.utterances[0]!.range)).toBe("alpha ");
      expect(textOf(record.utterances[1]!.range)).toBe("amma");
      expect(record.utterances.every((u) => u.range.edited)).toBe(true);
    });
  });

  describe("release", () => {
    beforeEach(() => {
      dictate("hello");
    });

    it("drops a draft's records when the draft is sent", () => {
      useTerminalInputStore.getState().clearDraftInput(PANEL, PROJECT);
      expect(records()).toEqual([]);
    });

    it("drops a draft's records when the draft is emptied", () => {
      setDraft("");
      expect(records()).toEqual([]);
    });

    it("drops a removed panel's records", () => {
      useTerminalInputStore.getState().clearTerminalState(PANEL);
      expect(records()).toEqual([]);
    });

    it("keeps records for a draft a project reset preserves", () => {
      useTerminalInputStore.getState().resetForProjectSwitch(PROJECT, new Set([PANEL]));
      expect(records()).toHaveLength(1);
      useTerminalInputStore.getState().resetForProjectSwitch(PROJECT);
      expect(records()).toEqual([]);
    });

    it("leaves other drafts' records alone", () => {
      const other = { ...target, panelId: "panel-2" };
      useTerminalInputStore.getState().setDraftInput("panel-2", "other", PROJECT);
      useDictationRangeStore.getState().recordUtterance(other, {
        insertion: { from: 0, to: 5 },
        words: { from: 0, to: 5 },
      });

      useTerminalInputStore.getState().clearDraftInput(PANEL, PROJECT);

      expect(records()).toEqual([]);
      expect(useDictationRangeStore.getState().listDictations("panel-2", PROJECT)).toHaveLength(1);
    });

    it("starts a fresh record when a session keeps dictating after a send", () => {
      const sent = only().id;
      useTerminalInputStore.getState().clearDraftInput(PANEL, PROJECT);
      dictate("again");

      const record = only();
      expect(record.id).not.toBe(sent);
      expect(record.sessionId).toBe(SESSION);
      expect(textOf(record.range)).toBe("again");
      expect(useDictationRangeStore.getState().getDictation(sent)).toBeNull();
    });

    it("releases one dictation by id", () => {
      dictate("more", { ...target, sessionId: "session-2" });
      const [first, second] = records();
      useDictationRangeStore.getState().releaseDictation(first!.id);
      expect(records()).toEqual([second]);
    });

    it("drops every record and stops mapping once unsubscribed", () => {
      unsubscribe();
      expect(records()).toEqual([]);

      unsubscribe = subscribeDictationRangeTracking();
      dictate("tracked");
      const before = only();
      unsubscribe();
      useDictationRangeStore.setState({ drafts: { [`${PROJECT}:${PANEL}`]: [before] } });
      edit(0, 0, "untracked ");
      expect(only()).toBe(before);
    });
  });

  it("looks a dictation up by id", () => {
    dictate("hello");
    const record = only();
    expect(useDictationRangeStore.getState().getDictation(record.id)).toBe(record);
    expect(useDictationRangeStore.getState().getDictation("missing")).toBeNull();
  });
});
