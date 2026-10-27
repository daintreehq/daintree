import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planVoiceBreak, planVoiceWords, type VoiceInsertPlan } from "@/services/voiceInsertion";
import { collectCorrectionPassages } from "@/services/voiceCorrectionPassages";
import { useTerminalInputStore } from "../terminalInputStore";
import {
  dictatedSpans,
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
function dictate(
  words: string,
  sessionTarget = target,
  uncertain?: Array<{ from: number; to: number }>
): void {
  const base = draft();
  const separator = base && !base.endsWith(" ") && !base.endsWith("\n") ? " " : "";
  const next = base + separator + words;
  // Voice writes say where they went, as commitVoicePlan's do.
  useDictationRangeStore.getState().expectDraftChange(PANEL, PROJECT, base, next, {
    from: base.length,
    to: base.length,
    insert: separator + words,
  });
  setDraft(next);
  const from = base.length + separator.length;
  useDictationRangeStore.getState().recordUtterance(sessionTarget, {
    insertion: { from: base.length, to: from + words.length },
    words: { from, to: from + words.length },
    ...(uncertain ? { uncertain } : {}),
  });
}

function paragraphBreak(sessionTarget = target): void {
  const base = draft();
  useDictationRangeStore.getState().expectDraftChange(PANEL, PROJECT, base, base + "\n", {
    from: base.length,
    to: base.length,
    insert: "\n",
  });
  setDraft(base + "\n");
  useDictationRangeStore
    .getState()
    .recordParagraphBreak(sessionTarget, { from: base.length, to: base.length + 1 });
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

  it("keeps a word retyped at either end in the learning span, and text typed at its edges out", () => {
    setDraft("Use");
    dictate("racked query");

    edit(4, 10, "React");
    expect(textOf(only().utterances[0]!.range)).toBe(" query");
    edit(10, 15, "queries");
    edit(0, 0, "Please ");
    setDraft(`${draft()} now`);

    expect(draft()).toBe("Please Use React queries now");
    expect(textOf(only().learningSpan!)).toBe("React queries");
  });

  it("keeps what an utterance was heard as", () => {
    setDraft("Zustand");
    useDictationRangeStore.getState().recordUtterance(target, {
      insertion: { from: 0, to: 7 },
      words: { from: 0, to: 7 },
      heard: "zoo stand",
    });
    expect(only().utterances[0]!.heard).toBe("zoo stand");
  });

  describe("unsure words", () => {
    /** The words each of the dictation's passages flags, as correction would read them. */
    const flaggedWords = () =>
      collectCorrectionPassages(only(), draft()).map((passage) =>
        (passage.uncertain ?? []).map(({ from, to }) => `${from}:${passage.text.slice(from, to)}`)
      );

    it("hands correction each utterance's unsure words at their place in the passage", () => {
      dictate("test foo test", target, [{ from: 9, to: 13 }]);
      dictate("then racked native", target, [{ from: 5, to: 11 }]);
      expect(flaggedWords()).toEqual([["9:test", "19:racked"]]);
    });

    it("keeps them through the session's own writes, which say what they changed", () => {
      dictate("foo", target, [{ from: 0, to: 3 }]);
      dictate("foo");
      paragraphBreak();
      dictate("foo");
      expect(flaggedWords()).toEqual([["0:foo"]]);
    });

    // A diff can't say which copy of repeated text an edit took, nor see the
    // separate edits one update holds, so any of these could have left the
    // flag on another copy of its word.
    it.each([
      ["deletes the first of two copies", (d: string) => d.slice(4), "foo end"],
      ["deletes one copy and rewrites another word", () => "foo bar", "foo bar"],
      ["deletes one copy and writes a near copy elsewhere", () => "foo fox end", "foo fox end"],
      ["types far from the words", (d: string) => `${d} today`, "foo foo end today"],
    ])("drops them on an edit nobody described that %s", (_name, next, expected) => {
      dictate("foo", target, [{ from: 0, to: 3 }]);
      dictate("foo");
      dictate("end");
      expect(flaggedWords()).toEqual([["0:foo"]]);
      setDraft(next(draft()));
      expect(draft()).toBe(expected);
      expect(flaggedWords().flat()).toEqual([]);
    });
  });

  describe("rewritePassage", () => {
    const rewrite = (text: string, heard = text) => {
      const record = records()[0]!;
      const ids = record.utterances.slice(0, 2).map((u) => u.id);
      return useDictationRangeStore
        .getState()
        .rewritePassage(record.id, { utteranceIds: ids, text: "add zoo stand" }, text, heard);
    };

    it("writes the passage as one unedited utterance and moves what follows", () => {
      setDraft("Typed.");
      dictate("add zoo");
      dictate("stand");
      dictate("to it");
      const other = { ...target, sessionId: "session-2" };
      dictate("later", other);

      expect(rewrite("add Zustand", "add zoo stand")).toEqual({ from: 7, to: 20 });

      expect(draft()).toBe("Typed. add Zustand to it later");
      const [record, later] = records();
      expect(record!.range).toEqual({ from: 6, to: 24, edited: false });
      expect(record!.utterances.map((u) => [textOf(u.range), u.range.edited])).toEqual([
        ["add Zustand", false],
        ["to it", false],
      ]);
      expect(textOf(record!.utterances[0]!.insertion)).toBe(" add Zustand");
      expect(textOf(record!.utterances[1]!.insertion)).toBe(" to it");
      expect(record!.utterances[0]!.heard).toBe("add zoo stand");
      expect(textOf(later!.range)).toBe(" later");
    });

    it("gives the merged utterance the unsure words the rewriter placed, and drops the old ones", () => {
      dictate("add zoo", target, [{ from: 4, to: 7 }]);
      dictate("stand", target, [{ from: 0, to: 5 }]);
      const record = only();
      useDictationRangeStore
        .getState()
        .rewritePassage(
          record.id,
          { utteranceIds: record.utterances.map((u) => u.id), text: "add zoo stand" },
          "add Zustand",
          "add zoo stand",
          { text: [{ from: 4, to: 11 }], heard: [{ from: 8, to: 13 }] }
        );
      const [merged] = only().utterances;
      expect(merged!.uncertain).toEqual([{ from: 4, to: 11 }]);
      expect(merged!.heardUncertain).toEqual([{ from: 8, to: 13 }]);
    });

    it("keeps a flag the dictation already carried", () => {
      dictate("add zoo");
      dictate("stand");
      setDraft(draft() + " typed");
      dictate("more");
      expect(only().range.edited).toBe(true);

      expect(rewrite("add Zustand")).not.toBeNull();
      expect(only().range.edited).toBe(true);
      expect(draft()).toBe("add Zustand typed more");
    });

    it("writes nothing once the passage holds other text", () => {
      dictate("add zoo");
      dictate("stand");
      edit(0, 3, "put");
      expect(rewrite("add Zustand")).toBeNull();
      expect(draft()).toBe("put zoo stand");
    });

    it("writes nothing over words that were edited, even back to the same text", () => {
      dictate("add zoo");
      dictate("stand");
      edit(1, 2, "x");
      edit(1, 2, "d");
      expect(draft()).toBe("add zoo stand");
      expect(only().utterances[0]!.range.edited).toBe(true);
      expect(rewrite("add Zustand")).toBeNull();
      expect(draft()).toBe("add zoo stand");
    });

    it("keeps the transcript a passage's file references will land in", () => {
      dictate("add zoo");
      const { utterances } = only();
      setDraft(draft() + " stand");
      useDictationRangeStore.getState().recordUtterance(target, {
        insertion: { from: 7, to: 13 },
        words: { from: 8, to: 13 },
        transcriptId: "t-1",
      });
      expect(only().utterances).toHaveLength(utterances.length + 1);

      expect(rewrite("add Zustand")).not.toBeNull();
      expect(only().utterances.map((u) => [textOf(u.range), u.transcriptId])).toEqual([
        ["add Zustand", "t-1"],
      ]);
    });

    it("merges two transcripts, keeping the first for a file reference still due", () => {
      for (const [words, transcriptId] of [
        ["add zoo", "t-1"],
        ["stand", "t-2"],
      ] as const) {
        const base = draft();
        const separator = base ? " " : "";
        setDraft(base + separator + words);
        const from = base.length + separator.length;
        useDictationRangeStore.getState().recordUtterance(target, {
          insertion: { from: base.length, to: from + words.length },
          words: { from, to: from + words.length },
          transcriptId,
        });
      }

      expect(rewrite("add Zustand")).not.toBeNull();
      expect(only().utterances.map((u) => [textOf(u.range), u.transcriptId])).toEqual([
        ["add Zustand", "t-1"],
      ]);
    });

    it("writes nothing for a dictation the draft released", () => {
      dictate("add zoo");
      dictate("stand");
      const { id, utterances } = only();
      setDraft("");
      expect(
        useDictationRangeStore
          .getState()
          .rewritePassage(
            id,
            { utteranceIds: utterances.map((u) => u.id), text: "add zoo stand" },
            "add Zustand",
            "add zoo stand"
          )
      ).toBeNull();
      expect(records()).toEqual([]);
    });

    it("rewrites words dictated at the caret in place, carrying the space after them, the learning span and the anchor", () => {
      /** One utterance at the session's anchor, written the way the voice service writes it. */
      const dictateAtAnchor = (words: string) => {
        const before = draft();
        const plan = planVoiceWords(
          before,
          useDictationRangeStore.getState().getAnchor(target),
          words
        );
        useDictationRangeStore
          .getState()
          .expectDraftChange(PANEL, PROJECT, before, plan.next, plan.change);
        setDraft(plan.next);
        useDictationRangeStore.getState().recordUtterance(target, {
          insertion: plan.insertion,
          words: plan.words,
          ...(plan.separatorAfter ? { separatorAfter: plan.separatorAfter } : {}),
        });
        useDictationRangeStore.getState().setAnchor(target, plan.anchor);
      };
      setDraft("Please then test it.");
      useDictationRangeStore.getState().setAnchor(target, { from: 7, to: 7 });
      dictateAtAnchor("use zoo");
      dictateAtAnchor("stand");
      expect(draft()).toBe("Please use zoo stand then test it.");
      const { id, utterances } = only();

      expect(
        useDictationRangeStore
          .getState()
          .rewritePassage(
            id,
            { utteranceIds: utterances.map((u) => u.id), text: "use zoo stand" },
            "use Zustand",
            "use zoo stand"
          )
      ).toEqual({ from: 7, to: 20 });

      expect(draft()).toBe("Please use Zustand then test it.");
      const record = only();
      expect(record.range).toEqual({ from: 7, to: 18, edited: false });
      expect(textOf(record.learningSpan!)).toBe("use Zustand");
      expect(record.utterances).toHaveLength(1);
      expect(textOf(record.utterances[0]!.range)).toBe("use Zustand");
      expect(record.utterances[0]!.separatorAfter).toEqual({ from: 18, to: 19, edited: false });
      expect(useDictationRangeStore.getState().getAnchor(target)).toEqual({
        from: 18,
        to: 18,
        edited: false,
      });
      // Scratching it leaves the typed text as it was before the dictation.
      const span = useDictationRangeStore.getState().takeLastUtterance(target, draft());
      expect(span).toEqual({ from: 7, to: 19 });
      expect(draft().slice(0, span!.from) + draft().slice(span!.to)).toBe("Please then test it.");
    });
  });

  it("keeps each paragraph break on its own through edits around it", () => {
    dictate("first");
    paragraphBreak();
    dictate("second");
    edit(0, 0, "Intro: ");

    const [paragraph] = only().breaks;
    expect(textOf(paragraph!)).toBe("\n");
    expect(paragraph!.edited).toBe(false);

    edit(paragraph!.from, paragraph!.to, " ");
    expect(only().breaks[0]!.edited).toBe(true);
  });

  describe("takeLastUtterance", () => {
    const take = () => {
      const span = useDictationRangeStore.getState().takeLastUtterance(target, draft())!;
      setDraft(draft().slice(0, span.from) + draft().slice(span.to));
    };

    it("forgets the paragraph break it took with the utterance", () => {
      setDraft("Keep");
      dictate("First.");
      paragraphBreak();
      dictate("Second.");
      paragraphBreak();

      take();

      expect(draft()).toBe("Keep First.\n");
      expect(only().breaks.map(textOf)).toEqual(["\n"]);
      expect(only().breaks.every((paragraphBreak) => !paragraphBreak.edited)).toBe(true);
      const spans = dictatedSpans(only(), draft())!;
      expect(
        spans.reduce((text, { from, to }) => text.slice(0, from) + text.slice(to), draft())
      ).toBe("Keep");
    });

    it("keeps a break past the text typed after the utterance", () => {
      dictate("First.");
      dictate("Second.");
      paragraphBreak();
      edit(draft().length, draft().length, "x");
      paragraphBreak();
      expect(draft()).toBe("First. Second.\nx\n");

      take();

      expect(draft()).toBe("First.\nx\n");
      expect(only().breaks.map(textOf)).toEqual(["\n", "\n"]);
    });
  });

  describe("dictatedSpans", () => {
    const without = (spans: { from: number; to: number }[]) =>
      spans.reduce((text, { from, to }) => text.slice(0, from) + text.slice(to), draft());

    it("lists every utterance and paragraph break, last first", () => {
      setDraft("Keep");
      dictate("first");
      paragraphBreak();
      dictate("second");

      const spans = dictatedSpans(only(), draft())!;
      expect(spans.map(textOf)).toEqual(["second", "\n", " first"]);
      expect(without(spans)).toBe("Keep");
    });

    it("leaves text typed before, between and after the dictation", () => {
      setDraft("Start");
      dictate("first");
      setDraft(draft() + " typed");
      dictate("second");
      edit(0, 0, "Before ");
      setDraft(draft() + " after");

      expect(only().range.edited).toBe(true);
      expect(without(dictatedSpans(only(), draft())!)).toBe("Before Start typed after");
    });

    it("refuses once an utterance's words were edited", () => {
      dictate("hello world");
      setDraft(draft().replace("world", "there"));
      expect(dictatedSpans(only(), draft())).toBeNull();
    });

    it("refuses once text was typed between an utterance's separator and its words", () => {
      setDraft("Keep");
      dictate("words");
      edit(5, 5, "typed ");
      expect(draft()).toBe("Keep typed words");
      expect(dictatedSpans(only(), draft())).toBeNull();
    });

    it("refuses once the separator itself was replaced", () => {
      setDraft("Keep");
      dictate("words");
      edit(4, 5, "\n");

      const [utterance] = only().utterances;
      expect(utterance!.range.edited).toBe(false);
      expect(utterance!.insertion.edited).toBe(true);
      expect(dictatedSpans(only(), draft())).toBeNull();
    });

    it("lists a break spoken before any words and each break after it", () => {
      setDraft("Keep");
      paragraphBreak();
      dictate("first");
      paragraphBreak();
      paragraphBreak();
      dictate("second");

      expect(only().breaks).toHaveLength(3);
      const spans = dictatedSpans(only(), draft())!;
      expect(spans.map(textOf)).toEqual(["second", "\n", "\n", "first", "\n"]);
      expect(without(spans)).toBe("Keep");
    });

    it("refuses once a paragraph break was deleted", () => {
      dictate("first");
      paragraphBreak();
      dictate("second");
      setDraft("firstsecond");
      expect(dictatedSpans(only(), draft())).toBeNull();
    });

    it("refuses spans that no longer fit the draft", () => {
      dictate("words");
      expect(dictatedSpans(only(), draft().slice(0, 2))).toBeNull();
    });

    it("takes a passage the stop-time heard-as pass rewrote, and keeps the break after it to take (#14737)", () => {
      setDraft("Keep");
      dictate("use zoo stand");
      paragraphBreak();
      setDraft(draft() + "Typed. ");
      dictate("more");
      const record = only();
      const [passage, later] = collectCorrectionPassages(record, draft());
      expect(later?.text).toBe("more");

      expect(
        useDictationRangeStore
          .getState()
          .rewritePassage(record.id, passage!, "use Zustand", passage!.text)
      ).toEqual({ from: 5, to: 18 });
      expect(draft()).toBe("Keep use Zustand\nTyped. more");
      expect(only().breaks).toEqual([{ from: 16, to: 17, edited: false }]);

      const spans = dictatedSpans(only(), draft())!;
      expect(spans.map(textOf)).toEqual(["more", "\n", " use Zustand"]);
      expect(without(spans)).toBe("KeepTyped. ");
    });
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

describe("taking the last utterance at the caret (#14634)", () => {
  /** "Intro. Outro." with "One." dictated before "Outro.", as the voice service writes it. */
  function dictateMidDraft(): void {
    setDraft("Intro. One. Outro.");
    useDictationRangeStore.getState().recordUtterance(target, {
      insertion: { from: 7, to: 11 },
      words: { from: 7, to: 11 },
      separatorAfter: { from: 11, to: 12 },
    });
  }
  const take = () => useDictationRangeStore.getState().takeLastUtterance(target, draft());

  it("takes the space the words were given ahead of the text after them", () => {
    dictateMidDraft();
    expect(take()).toEqual({ from: 7, to: 12 });
  });

  it("leaves that space once text is typed between it and the words", () => {
    dictateMidDraft();
    edit(11, 11, "X");
    expect(draft()).toBe("Intro. One.X Outro.");
    expect(take()).toEqual({ from: 7, to: 11 });
  });

  it("leaves that space once it is edited", () => {
    dictateMidDraft();
    edit(11, 12, "_");
    expect(take()).toEqual({ from: 7, to: 11 });
  });
});

describe("cancelling a dictation at the caret (#14631, #14634)", () => {
  const anchor = () => useDictationRangeStore.getState().getAnchor(target);

  /** Writes a plan and records it the way the voice service does. */
  function commit(plan: VoiceInsertPlan, words: boolean): void {
    const store = useDictationRangeStore.getState();
    store.expectDraftChange(PANEL, PROJECT, draft(), plan.next, plan.change);
    setDraft(plan.next);
    if (words) {
      store.recordUtterance(target, {
        insertion: plan.insertion,
        words: plan.words,
        ...(plan.separatorAfter ? { separatorAfter: plan.separatorAfter } : {}),
      });
    } else {
      store.recordParagraphBreak(target, plan.insertion);
    }
    store.setAnchor(target, plan.anchor);
  }
  const speak = (text: string) => commit(planVoiceWords(draft(), anchor(), text), true);
  const breakLine = () => commit(planVoiceBreak(draft(), anchor()), false);
  const cancelled = () => {
    const spans = dictatedSpans(only(), draft());
    return (
      spans && spans.reduce((text, { from, to }) => text.slice(0, from) + text.slice(to), draft())
    );
  };

  beforeEach(() => {
    setDraft("Intro. Outro.");
    useDictationRangeStore.getState().setAnchor(target, { from: 7, to: 7 });
  });

  it("takes the words and the space they were given ahead of the text after them", () => {
    speak("One.");
    speak("Two.");
    expect(draft()).toBe("Intro. One. Two. Outro.");

    expect(cancelled()).toBe("Intro. Outro.");
  });

  it("takes a paragraph break spoken between them too", () => {
    speak("One.");
    breakLine();
    speak("Two.");
    expect(draft()).toBe("Intro. One.\nTwo. Outro.");

    expect(cancelled()).toBe("Intro. Outro.");
  });

  it("keeps text typed on both sides of the dictation", () => {
    speak("One.");
    edit(0, 0, "Say: ");
    edit(draft().length, draft().length, " Done");
    expect(draft()).toBe("Say: Intro. One. Outro. Done");

    expect(cancelled()).toBe("Say: Intro. Outro. Done");
  });

  it("leaves the space once text is typed between it and the words", () => {
    speak("One.");
    edit(11, 11, "X");
    expect(draft()).toBe("Intro. One.X Outro.");

    expect(cancelled()).toBe("Intro. X Outro.");
  });

  it("still takes the words once that space was deleted", () => {
    speak("One.");
    edit(11, 12, "");
    expect(draft()).toBe("Intro. One.Outro.");

    expect(cancelled()).toBe("Intro. Outro.");
  });

  describe("once the stop-time heard-as pass rewrote a passage (#14737)", () => {
    /** Rewrites each passage the way the stop-time pass does. */
    const rewritePassages = (from: string, to: string) => {
      const { id } = only();
      for (const passage of collectCorrectionPassages(only(), draft())) {
        const text = passage.text.replace(from, to);
        if (text === passage.text) continue;
        expect(
          useDictationRangeStore.getState().rewritePassage(id, passage, text, passage.text)
        ).not.toBeNull();
      }
    };

    it("takes exactly the rewritten words and the space after them", () => {
      speak("Use zoo");
      speak("stand.");
      expect(draft()).toBe("Intro. Use zoo stand. Outro.");

      rewritePassages("zoo stand", "Zustand");
      expect(draft()).toBe("Intro. Use Zustand. Outro.");
      expect(only().utterances).toHaveLength(1);

      expect(cancelled()).toBe("Intro. Outro.");
    });

    it("takes a paragraph break the rewritten passage spans", () => {
      speak("One.");
      breakLine();
      speak("Use zoo stand.");
      expect(collectCorrectionPassages(only(), draft())).toHaveLength(1);

      rewritePassages("zoo stand", "Zustand");
      expect(draft()).toBe("Intro. One.\nUse Zustand. Outro.");
      expect(only().breaks).toEqual([]);

      expect(cancelled()).toBe("Intro. Outro.");
    });
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

describe("draft writes that touch several places (#14781)", () => {
  const other = { sessionId: "session-2", panelId: PANEL, projectId: PROJECT };

  it("leaves a record and an anchor between two declared changes untouched", () => {
    setDraft("aa bb cc");
    useDictationRangeStore.getState().recordUtterance(other, {
      insertion: { from: 3, to: 5 },
      words: { from: 3, to: 5 },
    });
    useDictationRangeStore.getState().setAnchor(other, { from: 5, to: 5 });

    const changes = [
      { from: 0, to: 2, insert: "AAA" },
      { from: 6, to: 8, insert: "C" },
    ];
    useDictationRangeStore
      .getState()
      .expectDraftChange(PANEL, PROJECT, "aa bb cc", "AAA bb C", changes);
    setDraft("AAA bb C");

    expect(only().utterances[0]!.range).toEqual({ from: 4, to: 6, edited: false });
    expect(useDictationRangeStore.getState().getAnchor(other)).toEqual({
      from: 6,
      to: 6,
      edited: false,
    });
  });

  it("still flags the words the diff of an undeclared write runs across", () => {
    setDraft("aa bb cc");
    useDictationRangeStore.getState().recordUtterance(other, {
      insertion: { from: 3, to: 5 },
      words: { from: 3, to: 5 },
    });
    setDraft("AAA bb C");

    expect(only().utterances[0]!.range.edited).toBe(true);
  });

  it("never shows a subscriber anchors that moved with ranges that haven't", () => {
    dictate("the parsr");
    useDictationRangeStore.getState().setAnchor(other, { from: 9, to: 9 });
    const seen: string[] = [];
    const stop = useDictationRangeStore.subscribe(() =>
      seen.push(textOf(only().utterances[0]!.range))
    );

    edit(0, 0, "note: ");
    stop();

    expect(seen).toEqual(["the parsr"]);
  });
});
