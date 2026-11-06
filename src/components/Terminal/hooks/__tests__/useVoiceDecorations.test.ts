// @vitest-environment jsdom
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useLayoutEffect } from "react";
import { act, renderHook } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  currentVoiceCaretEffects,
  dictationFollowField,
  interimWidgetField,
  pendingAIField,
  revealDictationStart,
  setDictationFollow,
  VOICE_CARET_LEVEL_PROPERTY,
  voiceCaret,
} from "../../inputEditorExtensions";

// A streamed cleanup's rewrite through the hook that feeds the editor: drawn
// over the passage while the editor shows the draft its positions came from.

vi.mock("@/store", async () => {
  const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
  return { useVoiceRecordingStore };
});

const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
const { useTerminalInputStore } = await import("@/store/terminalInputStore");
const { useDictationRangeStore, subscribeDictationRangeTracking } =
  await import("@/store/dictationRangeStore");
const { useVoiceDecorations } = await import("../useVoiceDecorations");
const { claimWaitingSend } = await import("@/services/voiceDraftSend");

const PANEL = "panel-1";
const DICTATED = "um so fix the bug";

// Where each passage shown from its start begins, in the order they were shown.
let reveals: number[] = [];
// Every follow the hook asked for, and the length of the text it landed in.
let follows: Array<{ end?: number; length: number }> = [];

const recordFollows = EditorView.updateListener.of((update) => {
  for (const tr of update.transactions) {
    for (const effect of tr.effects) {
      if (!effect.is(setDictationFollow)) continue;
      const { end } = effect.value;
      follows.push({ ...(end !== undefined ? { end } : {}), length: tr.newDoc.length });
    }
  }
});

function mount(doc: string, parent: HTMLElement = document.createElement("div")) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        interimWidgetField,
        pendingAIField,
        dictationFollowField,
        voiceCaret,
        recordFollows,
        EditorView.updateListener.of((update) => {
          for (const tr of update.transactions) {
            for (const effect of tr.effects) {
              if (effect.is(revealDictationStart)) reveals.push(effect.value);
            }
          }
        }),
      ],
    }),
  });
  const editorViewRef = { current: view };
  renderHook(() => useVoiceDecorations({ terminalId: PANEL, editorViewRef }));
  return view;
}

function streamRewrite() {
  act(() => {
    useVoiceRecordingStore
      .getState()
      .setCorrectionRanges(PANEL, [
        { from: 0, to: DICTATED.length, rewrite: { to: 9, text: "So fix" } },
      ]);
  });
}

function startDictation(panelId = PANEL) {
  act(() => {
    useVoiceRecordingStore.getState().beginSession({ panelId }, "s1");
    useVoiceRecordingStore.getState().setStatus("recording");
  });
}

const originalGetAnchor = useDictationRangeStore.getState().getAnchor;

afterEach(() => {
  reveals = [];
  follows = [];
  useDictationRangeStore.setState({ getAnchor: originalGetAnchor });
  useDictationRangeStore.getState().clear();
  useVoiceRecordingStore.getState().finishSession();
  useVoiceRecordingStore.getState().setCorrectionRanges(PANEL, []);
  useTerminalInputStore.getState().clearDraftInput(PANEL);
  vi.clearAllMocks();
});

describe("useVoiceDecorations", () => {
  it("draws a streamed rewrite over the passage it was measured against", () => {
    useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
    const view = mount(DICTATED);

    streamRewrite();

    expect(view.contentDOM.textContent).toBe("So fix the bug");
    expect(view.state.doc.toString()).toBe(DICTATED);
    view.destroy();
  });

  it("puts the passage back as dictated when its reply is turned down", () => {
    useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
    const view = mount(DICTATED);
    streamRewrite();
    expect(view.contentDOM.querySelector(".cm-voice-rewrite")?.textContent).toBe("So fix");

    act(() => {
      useVoiceRecordingStore
        .getState()
        .setCorrectionRanges(PANEL, [{ from: 0, to: DICTATED.length }]);
    });

    expect(view.contentDOM.querySelector(".cm-voice-rewrite")).toBeNull();
    expect(view.contentDOM.textContent).toBe(DICTATED);
    view.destroy();
  });

  it("shows the passage as dictated while the editor is ahead of the draft", () => {
    useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
    const view = mount(`${DICTATED}!`);

    streamRewrite();

    expect(view.contentDOM.textContent).toBe(`${DICTATED}!`);
    expect(view.contentDOM.querySelector(".cm-voice-pending-ai")?.textContent).toBe(DICTATED);
    view.destroy();
  });

  it("shows a passage from its start once, when its cleanup begins", () => {
    useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
    const view = mount(DICTATED);

    act(() => {
      useVoiceRecordingStore
        .getState()
        .setCorrectionRanges(PANEL, [{ from: 3, to: DICTATED.length, session: "s1" }]);
    });
    act(() => {
      useVoiceRecordingStore
        .getState()
        .setCorrectionRanges(PANEL, [
          { from: 3, to: DICTATED.length, session: "s1", rewrite: { to: 9, text: "So fix" } },
        ]);
    });

    expect(reveals).toEqual([3]);
    view.destroy();
  });

  it("follows a dictation, and leaves its cleanup until it has stopped", () => {
    useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
    const view = mount(DICTATED);

    startDictation();
    expect(view.state.field(dictationFollowField).session).toBe("s1");

    // A chunk cleaned while the dictation runs.
    act(() => {
      useVoiceRecordingStore
        .getState()
        .setCorrectionRanges(PANEL, [{ from: 0, to: 9, session: "s1" }]);
    });
    expect(reveals).toEqual([]);

    act(() => {
      useVoiceRecordingStore.getState().finishSession();
    });
    expect(view.state.field(dictationFollowField).session).toBeNull();
    expect(reveals).toEqual([0]);
    view.destroy();
  });

  it("never moves for a spoken rewrite of a selection", () => {
    useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
    const view = mount(DICTATED);

    act(() => {
      useVoiceRecordingStore.getState().setCorrectionRanges(PANEL, [{ from: 3, to: 9 }]);
    });

    expect(reveals).toEqual([]);
    view.destroy();
  });

  it("follows the end of the words dictated so far, once the editor shows them", () => {
    useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
    const anchor = { from: 9, to: 9, edited: false };
    useDictationRangeStore.setState({ getAnchor: () => anchor });
    const view = mount(`${DICTATED}!`);

    startDictation();
    // The editor is a keystroke ahead of the store: its positions aren't the editor's.
    expect(view.state.field(dictationFollowField)).toEqual({ session: "s1", end: null });

    // The next words land, and the editor shows the draft they landed in.
    const moved = { from: 12, to: 12, edited: false };
    act(() => {
      view.dispatch({ changes: { from: DICTATED.length, to: DICTATED.length + 1 } });
      useDictationRangeStore.setState({ getAnchor: () => moved });
    });
    expect(view.state.field(dictationFollowField)).toEqual({ session: "s1", end: 12 });
    view.destroy();
  });

  it("follows nothing into the words a send took while the session finishes (#15716)", () => {
    onTestFinished(subscribeDictationRangeTracking());
    const sent = "x".repeat(389);
    useTerminalInputStore.getState().setDraftInput(PANEL, sent);
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        doc: sent,
        extensions: [
          interimWidgetField,
          pendingAIField,
          dictationFollowField,
          voiceCaret,
          recordFollows,
        ],
      }),
    });
    onTestFinished(() => view.destroy());
    const editorViewRef = { current: view };
    // The send goes between a render and its effects: it empties the editor
    // and the draft after the render read the stores.
    let sendOnCommit = false;
    renderHook(() => {
      useVoiceDecorations({ terminalId: PANEL, editorViewRef });
      const status = useVoiceRecordingStore((s) => s.status);
      useLayoutEffect(() => {
        if (!sendOnCommit) return;
        sendOnCommit = false;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length } });
        useTerminalInputStore.getState().setDraftInput(PANEL, "");
      }, [status]);
    });
    startDictation();
    const target = { sessionId: "s1", panelId: PANEL, projectId: undefined };
    act(() => useDictationRangeStore.getState().setAnchor(target, { from: 312, to: 312 }));
    expect(view.state.field(dictationFollowField)).toEqual({ session: "s1", end: 312 });

    follows = [];
    sendOnCommit = true;
    act(() => useVoiceRecordingStore.getState().setStatus("finishing"));

    expect(view.state.doc.toString()).toBe("");
    // The hook's first pass after the render came after the send.
    expect(follows[0]?.length).toBe(0);
    expect(useDictationRangeStore.getState().getAnchor(target)).toBeNull();
    expect(follows.filter(({ end = 0, length }) => end > length)).toEqual([]);
    // The drain's last words land in the emptied composer, and the session ends.
    act(() => view.dispatch({ changes: { from: 0, insert: "next" } }));
    expect(view.state.doc.toString()).toBe("next");
    act(() => useVoiceRecordingStore.getState().finishSession());
    expect(view.state.field(dictationFollowField).session).toBeNull();
  });

  it("ignores an anchor that doesn't fit the draft it is read with (#15716)", () => {
    const sent = "x".repeat(389);
    useTerminalInputStore.getState().setDraftInput(PANEL, sent);
    const view = mount(sent);
    onTestFinished(() => view.destroy());
    startDictation();
    const target = { sessionId: "s1", panelId: PANEL, projectId: undefined };
    act(() => {
      useDictationRangeStore.getState().setAnchor(target, { from: 312, to: 312 });
      useVoiceRecordingStore.getState().setStatus("finishing");
    });
    expect(view.state.field(dictationFollowField)).toEqual({ session: "s1", end: 312 });

    act(() => {
      view.dispatch({ changes: { from: 0, to: sent.length } });
      useTerminalInputStore.getState().setDraftInput(PANEL, "");
    });
    // A position taken in the text that went, arriving after the send.
    follows = [];
    act(() => useDictationRangeStore.getState().setAnchor(target, { from: 312, to: 312 }));
    expect(follows).toContainEqual({ end: 312, length: 0 });
    expect(view.state.field(dictationFollowField)).toEqual({ session: "s1", end: 0 });

    // The next words into the emptied composer.
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "next" } });
    });
    expect(view.state.doc.toString()).toBe("next");
  });

  it("leaves a dictation into another composer alone", () => {
    useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
    const view = mount(DICTATED);
    // This composer still holds the session it last took words from.
    startDictation();
    act(() => useVoiceRecordingStore.getState().finishSession());

    startDictation("panel-2");

    expect(view.state.field(dictationFollowField).session).toBeNull();
    view.destroy();
  });

  it("waits for the editor to show the draft before showing a passage's start", () => {
    useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
    const view = mount(`${DICTATED}!`);

    act(() => {
      useVoiceRecordingStore
        .getState()
        .setCorrectionRanges(PANEL, [{ from: 3, to: DICTATED.length, session: "s1" }]);
    });
    expect(reveals).toEqual([]);

    act(() => {
      view.dispatch({ changes: { from: DICTATED.length, to: DICTATED.length + 1 } });
      useVoiceRecordingStore
        .getState()
        .setCorrectionRanges(PANEL, [
          { from: 3, to: DICTATED.length, session: "s1", rewrite: { to: 9, text: "So fix" } },
        ]);
    });
    expect(reveals).toEqual([3]);
    view.destroy();
  });

  describe("dictation caret", () => {
    const caret = (view: EditorView) =>
      view.contentDOM.querySelector<HTMLElement>(".cm-voice-caret");
    const caretPos = (view: EditorView) => {
      const el = caret(view);
      return el ? view.posAtDOM(el) : null;
    };
    const level = (view: EditorView) => view.dom.style.getPropertyValue(VOICE_CARET_LEVEL_PROPERTY);

    // Destroyed whatever an assertion did, so a failure leaves no editor behind.
    let views: EditorView[] = [];
    const mountCaret = (doc: string, parent?: HTMLElement) => {
      const view = mount(doc, parent);
      views.push(view);
      return view;
    };
    afterEach(() => {
      for (const view of views) {
        view.dom.parentElement?.remove();
        view.destroy();
      }
      views = [];
    });

    it("tracks the mic from pending through silent, live, paused, reconnecting and finishing", () => {
      useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
      const view = mountCaret(DICTATED);
      const phases: (string | null)[] = [];
      const seen = () => phases.push(caret(view)?.dataset.phase ?? null);
      const store = () => useVoiceRecordingStore.getState();

      seen();
      act(() => store().beginSession({ panelId: PANEL }, "s1"));
      seen();
      // The mic can hear before the provider's session has opened.
      act(() => store().setMicSignal("live"));
      seen();
      act(() => {
        store().setStatus("recording");
        store().setMicSignal("silent");
      });
      seen();
      act(() => store().setMicSignal("live"));
      seen();
      act(() => store().setStatus("paused"));
      seen();
      act(() => store().setStatus("recording"));
      seen();
      // Reconnecting isn't listening, however live the mic still is.
      act(() => store().setStatus("reconnecting"));
      seen();
      act(() => store().setStatus("finishing"));
      seen();
      act(() => store().finishSession());
      seen();

      expect(phases).toEqual([
        null,
        "starting",
        "live",
        "starting",
        "live",
        "held",
        "live",
        "held",
        "held",
        null,
      ]);
    });

    it("shows where the words go in a composer that never had focus", () => {
      useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
      const view = mountCaret(DICTATED);
      expect(view.hasFocus).toBe(false);

      startDictation();

      // Never focused, so its caret at 0 isn't the user's: the words append.
      expect(caretPos(view)).toBe(DICTATED.length);
    });

    it("shows at the caret the user left, after focus has gone elsewhere", () => {
      useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
      const parent = document.body.appendChild(document.createElement("div"));
      const view = mountCaret(DICTATED, parent);
      view.focus();
      view.dispatch({ selection: { anchor: 6 } });
      view.contentDOM.blur();

      startDictation();

      expect(view.hasFocus).toBe(false);
      expect(caretPos(view)).toBe(6);
    });

    it("shows at the end for a session held back behind a waiting send", () => {
      useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
      const parent = document.body.appendChild(document.createElement("div"));
      const view = mountCaret(DICTATED, parent);
      view.focus();
      view.dispatch({ selection: { anchor: 6 } });
      const release = claimWaitingSend(PANEL, new Set(["an-earlier-session"]));
      try {
        startDictation();
        expect(caretPos(view)).toBe(DICTATED.length);
      } finally {
        release();
      }
    });

    it.each([
      [{ from: 3, to: 9, edited: false }, 3],
      // A selection edited since dictation began is the user's again: the
      // words go after it.
      [{ from: 3, to: 9, edited: true }, 9],
    ])("stays where the session's anchor puts the words (%o)", (anchor, expected) => {
      useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
      useDictationRangeStore.setState({ getAnchor: () => anchor });
      const view = mountCaret(DICTATED);

      startDictation();

      expect(caretPos(view)).toBe(expected);
    });

    it("keeps its place through typing the store hasn't caught up with", () => {
      useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
      const anchor = { from: 6, to: 6, edited: false };
      useDictationRangeStore.setState({ getAnchor: () => anchor });
      const view = mountCaret(DICTATED);
      startDictation();

      view.dispatch({ changes: { from: 0, insert: "ok " } });
      act(() => useVoiceRecordingStore.getState().setMicSignal("live"));

      expect(caret(view)?.dataset.phase).toBe("live");
      expect(caretPos(view)).toBe(9);
    });

    it("draws none for a spoken rewrite, which writes no words of its own", () => {
      useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
      const view = mountCaret(DICTATED);
      const selection = {
        text: "um so",
        range: () => ({ from: 0, to: 5 }),
        onLost: () => {},
        apply: () => true,
        release: () => {},
      };
      act(() => {
        useVoiceRecordingStore
          .getState()
          .beginSession(
            { panelId: PANEL, rewrite: { selection, instruction: [], cancelled: false } },
            "s1"
          );
        useVoiceRecordingStore.getState().setMicSignal("live");
      });
      expect(caret(view)).toBeNull();
    });

    it("leaves the session's caret where a popped stash can find it", () => {
      useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
      const view = mountCaret(DICTATED);
      startDictation();
      expect(currentVoiceCaretEffects(view).map((effect) => effect.value.phase)).toEqual([
        "starting",
      ]);
      act(() => useVoiceRecordingStore.getState().finishSession());
      expect(currentVoiceCaretEffects(view)).toEqual([]);
    });

    it("shows nothing of a session whose draft another screen took control of (#15919)", () => {
      useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
      const view = mountCaret(DICTATED);
      const store = () => useVoiceRecordingStore.getState();
      startDictation();
      act(() => {
        store().setMicSignal("live");
        store().appendDelta(" and the parser", "item-1");
      });
      expect(view.state.field(interimWidgetField).text).toContain("and the parser");
      expect(view.state.field(dictationFollowField).session).toBe("s1");
      expect(caret(view)).not.toBeNull();

      act(() => store().detachSessionDraft("s1"));

      expect(view.state.field(interimWidgetField).text).toBe("");
      expect(view.state.field(dictationFollowField).session).toBeNull();
      expect(caret(view)).toBeNull();

      // Only that session: the next one in the composer shows as usual.
      act(() => {
        store().finishSession();
        store().beginSession({ panelId: PANEL }, "s2");
        store().setStatus("recording");
        store().appendDelta(" more words", "item-2");
      });
      expect(view.state.field(interimWidgetField).text).toContain("more words");
      expect(caret(view)).not.toBeNull();
    });

    it("draws none for a session writing to another composer", () => {
      useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
      const view = mountCaret(DICTATED);
      startDictation("panel-2");
      expect(caret(view)).toBeNull();
    });

    it("follows the voice level, kept to 0-1, only while live and without a transaction per level", () => {
      useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
      const view = mountCaret(DICTATED);
      const dispatch = vi.spyOn(view, "dispatch");
      startDictation();
      act(() => useVoiceRecordingStore.getState().setAudioLevel(1));
      expect(level(view)).toBe("");

      useVoiceRecordingStore.getState().setAudioLevel(0);
      act(() => useVoiceRecordingStore.getState().setMicSignal("live"));
      const before = dispatch.mock.calls.length;
      const readings: number[] = [];
      for (const reading of [0.4, 1.6, -0.2]) {
        useVoiceRecordingStore.getState().setAudioLevel(reading);
        readings.push(Number(level(view)));
      }
      expect(dispatch.mock.calls.length).toBe(before);
      expect(readings).toEqual([0.4, 1, 0]);

      // Paused, the voice no longer reaches it.
      act(() => useVoiceRecordingStore.getState().setStatus("paused"));
      expect(level(view)).toBe("");
      useVoiceRecordingStore.getState().setAudioLevel(0.7);
      expect(level(view)).toBe("");
    });
  });
});
