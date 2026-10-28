// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  dictationFollowField,
  interimWidgetField,
  pendingAIField,
  revealDictationStart,
} from "../../inputEditorExtensions";

// A streamed cleanup's rewrite through the hook that feeds the editor: drawn
// over the passage while the editor shows the draft its positions came from.

vi.mock("@/store", async () => {
  const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
  return { useVoiceRecordingStore };
});

const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
const { useTerminalInputStore } = await import("@/store/terminalInputStore");
const { useDictationRangeStore } = await import("@/store/dictationRangeStore");
const { useVoiceDecorations } = await import("../useVoiceDecorations");

const PANEL = "panel-1";
const DICTATED = "um so fix the bug";

// Where each passage shown from its start begins, in the order they were shown.
let reveals: number[] = [];

function mount(doc: string) {
  const view = new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({
      doc,
      extensions: [
        interimWidgetField,
        pendingAIField,
        dictationFollowField,
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
  useDictationRangeStore.setState({ getAnchor: originalGetAnchor });
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

  it("leaves a dictation into another composer alone", () => {
    useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
    const view = mount(DICTATED);

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
});
