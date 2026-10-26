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
  useDictationRangeStore.setState({ drafts: {}, anchors: {} });
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
    const id = only().id;
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
    expect(record.id).toBe(id);
    expect(useDictationRangeStore.getState().getDictation(id)).toBe(record);
  });

  it("starts a record from a paragraph break spoken before any words", () => {
    setDraft("Intro.");
    setDraft("Intro.\n");
    useDictationRangeStore.getState().recordParagraphBreak(target, { from: 6, to: 7 });
    expect(only()).toMatchObject({ range: { from: 6, to: 7, edited: false }, utterances: [] });

    dictate("words");
    expect(textOf(only().range)).toBe("\nwords");
    expect(only().range.edited).toBe(false);
  });

  it("flags the dictation, not its utterances, when typed text ends up between them", () => {
    dictate("first");
    setDraft(draft() + " typed");
    dictate("second");

    const record = only();
    expect(textOf(record.range)).toBe("first typed second");
    expect(record.range.edited).toBe(true);
    expect(record.utterances.map((u) => u.range.edited)).toEqual([false, false]);

    dictate("third");
    expect(textOf(only().range)).toBe("first typed second third");
    expect(only().range.edited).toBe(true);
    expect(only().utterances.map((u) => u.range.edited)).toEqual([false, false, false]);
  });

  it("keeps separate records for separate sessions in one draft", () => {
    dictate("one");
    dictate("two", { ...target, sessionId: "session-2" });

    const [first, second] = records();
    expect(textOf(first!.range)).toBe("one");
    expect(textOf(second!.range)).toBe(" two");
    expect(first!.id).not.toBe(second!.id);
  });

  it("maps every record when two sessions interleave in one draft", () => {
    const other = { ...target, sessionId: "session-2" };
    dictate("one");
    dictate("two", other);
    dictate("three");
    edit(0, 0, "> ");

    const [first, second] = records();
    expect(records()).toHaveLength(2);
    expect(textOf(first!.range)).toBe("one two three");
    expect(first!.range.edited).toBe(true);
    expect(first!.utterances.map((u) => textOf(u.range))).toEqual(["one", "three"]);
    expect(first!.utterances.map((u) => textOf(u.insertion))).toEqual(["one", " three"]);
    expect(textOf(second!.range)).toBe(" two");
    expect(second!.range.edited).toBe(false);
    expect(textOf(second!.utterances[0]!.insertion)).toBe(" two");
  });

  it("keeps the same panel's drafts in different projects apart", () => {
    const inputs = useTerminalInputStore.getState();
    const elsewhere = { ...target, projectId: "project-2" };
    const bare = { ...target, projectId: undefined };
    inputs.setDraftInput(PANEL, "other", "project-2");
    useDictationRangeStore.getState().recordUtterance(elsewhere, {
      insertion: { from: 0, to: 5 },
      words: { from: 0, to: 5 },
    });
    inputs.setDraftInput(PANEL, "bare");
    useDictationRangeStore.getState().recordUtterance(bare, {
      insertion: { from: 0, to: 4 },
      words: { from: 0, to: 4 },
    });
    dictate("mine");
    const untouched = [
      useDictationRangeStore.getState().listDictations(PANEL, "project-2"),
      useDictationRangeStore.getState().listDictations(PANEL),
    ];

    edit(0, 0, "> ");
    useTerminalInputStore.getState().clearDraftInput(PANEL, PROJECT);

    expect(records()).toEqual([]);
    expect(useDictationRangeStore.getState().listDictations(PANEL, "project-2")).toBe(untouched[0]);
    expect(useDictationRangeStore.getState().listDictations(PANEL)).toBe(untouched[1]);
  });

  it("maps a record through a restored draft", () => {
    dictate("hello");
    const id = only().id;

    useTerminalInputStore.getState().restoreProjectDraftInputs(PROJECT, { [PANEL]: "Note: hello" });
    const record = only();
    expect(record.id).toBe(id);
    expect(record.range).toEqual({ from: 6, to: 11, edited: false });
    expect(record.utterances[0]!.range).toEqual({ from: 6, to: 11, edited: false });
    expect(record.utterances[0]!.insertion).toEqual({ from: 6, to: 11, edited: false });

    useTerminalInputStore
      .getState()
      .restoreProjectDraftInputs(PROJECT, { [PANEL]: "Note: heXllo" });
    expect(only().range.edited).toBe(true);
    expect(only().utterances[0]!.range.edited).toBe(true);
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
      expect(record.utterances.map((u) => textOf(u.insertion))).toEqual([" alpha beta", " gamma"]);
      expect(record.range.edited).toBe(false);
      expect(record.utterances.some((u) => u.range.edited || u.insertion.edited)).toBe(false);
    });

    it("flags the insertion, not the words, when only the separator is replaced", () => {
      // The space between "Intro." and "alpha".
      edit(6, 7, "\n");
      const record = only();
      expect(record.range.edited).toBe(true);
      expect(record.utterances[0]!.insertion.edited).toBe(true);
      expect(textOf(record.utterances[0]!.insertion)).toBe("alpha beta");
      expect(record.utterances[0]!.range).toMatchObject({ edited: false });
      expect(textOf(record.utterances[0]!.range)).toBe("alpha beta");
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
      expect(textOf(record.utterances[0]!.insertion)).toBe(" alpha, beta");
      expect(record.utterances[0]!.insertion.edited).toBe(true);
      expect(record.utterances[1]!.range).toMatchObject({ edited: false });
      expect(record.utterances[1]!.insertion).toMatchObject({ edited: false });
      expect(textOf(record.utterances[1]!.range)).toBe("gamma");
      expect(textOf(record.utterances[1]!.insertion)).toBe(" gamma");
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
      expect(textOf(record.utterances[0]!.insertion)).toBe("ha beta");
      expect(record.utterances[0]!.insertion.edited).toBe(true);
      expect(record.utterances[1]!.range.edited).toBe(false);
      expect(textOf(record.utterances[1]!.insertion)).toBe(" gamma");
    });

    it("trims a delete across the end of an utterance", () => {
      // Deletes "beta g".
      edit(13, 19, "");
      expect(draft()).toBe("Intro. alpha amma");
      const record = only();
      expect(textOf(record.utterances[0]!.range)).toBe("alpha ");
      expect(textOf(record.utterances[1]!.range)).toBe("amma");
      expect(textOf(record.utterances[0]!.insertion)).toBe(" alpha ");
      expect(textOf(record.utterances[1]!.insertion)).toBe("amma");
      expect(record.utterances.every((u) => u.range.edited && u.insertion.edited)).toBe(true);
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

describe("insertion anchors (#14634)", () => {
  const anchor = () => useDictationRangeStore.getState().getAnchor(target);

  it("follows edits before it and stays put for edits after it", () => {
    setDraft("hello world");
    useDictationRangeStore.getState().setAnchor(target, { from: 5, to: 5 });

    edit(0, 0, "Say ");
    expect(anchor()).toEqual({ from: 9, to: 9, edited: false });
    edit(15, 15, "!");
    expect(anchor()).toEqual({ from: 9, to: 9, edited: false });
  });

  it("moves past text typed at it", () => {
    setDraft("hello");
    useDictationRangeStore.getState().setAnchor(target, { from: 5, to: 5 });
    edit(5, 5, " there");
    expect(anchor()).toEqual({ from: 11, to: 11, edited: false });
  });

  it("flags a held selection once its text is edited", () => {
    setDraft("open the zoo store");
    useDictationRangeStore.getState().setAnchor(target, { from: 9, to: 12 });
    edit(10, 11, "xyz");
    expect(anchor()).toEqual({ from: 9, to: 14, edited: true });
  });

  it("is kept for an empty draft until the draft changes, then released with it", () => {
    useDictationRangeStore.getState().setAnchor(target, { from: 0, to: 0 });
    expect(anchor()).toEqual({ from: 0, to: 0, edited: false });

    setDraft("typed");
    expect(anchor()).toEqual({ from: 5, to: 5, edited: false });
    setDraft("");
    expect(anchor()).toBeNull();
  });

  it("keeps sessions apart and releases one session's anchors in every draft", () => {
    setDraft("abc");
    const elsewhere = { ...target, panelId: "panel-2" };
    useTerminalInputStore.getState().setDraftInput("panel-2", "xyz", PROJECT);
    const other = { ...target, sessionId: "session-2" };
    useDictationRangeStore.getState().setAnchor(target, { from: 1, to: 1 });
    useDictationRangeStore.getState().setAnchor(elsewhere, { from: 2, to: 2 });
    useDictationRangeStore.getState().setAnchor(other, { from: 2, to: 2 });

    useDictationRangeStore.getState().releaseAnchors(SESSION);
    expect(anchor()).toBeNull();
    expect(useDictationRangeStore.getState().getAnchor(elsewhere)).toBeNull();
    expect(useDictationRangeStore.getState().getAnchor(other)).toEqual({
      from: 2,
      to: 2,
      edited: false,
    });
  });

  it("drops every anchor when tracking is torn down", () => {
    setDraft("abc");
    const elsewhere = { ...target, panelId: "panel-2" };
    useDictationRangeStore.getState().setAnchor(target, { from: 1, to: 1 });
    useDictationRangeStore.getState().setAnchor(elsewhere, { from: 0, to: 0 });
    unsubscribe();
    expect(anchor()).toBeNull();
    expect(useDictationRangeStore.getState().getAnchor(elsewhere)).toBeNull();
    unsubscribe = subscribeDictationRangeTracking();
  });
});

describe("expected draft changes (#14634)", () => {
  it("maps through the change a writer declared, not the diff's guess", () => {
    setDraft("foo");
    dictate("foo");
    useDictationRangeStore.getState().expectDraftChange(PANEL, PROJECT, "foo foo", "foo foo foo", {
      from: 0,
      to: 0,
      insert: "foo ",
    });
    setDraft("foo foo foo");

    expect(only().utterances[0]!.range).toEqual({ from: 8, to: 11, edited: false });
  });

  it("falls back to the diff when the write isn't the one declared", () => {
    setDraft("foo");
    dictate("foo");
    useDictationRangeStore.getState().expectDraftChange(PANEL, PROJECT, "foo foo", "foo foo foo", {
      from: 0,
      to: 0,
      insert: "foo ",
    });
    setDraft("foo foo!");

    expect(only().utterances[0]!.range).toEqual({ from: 4, to: 7, edited: false });
  });
});
