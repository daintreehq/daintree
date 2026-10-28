// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { EditorState, type TransactionSpec } from "@codemirror/state";
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
const { useVoiceDecorations } = await import("../useVoiceDecorations");

const PANEL = "panel-1";
const DICTATED = "um so fix the bug";

function mount(doc: string) {
  const view = new EditorView({
    parent: document.createElement("div"),
    state: EditorState.create({
      doc,
      extensions: [interimWidgetField, pendingAIField, dictationFollowField],
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

/** Where each passage shown from its start begins, in the order they were shown. */
function reveals(dispatch: { mock: { calls: unknown[][] } }) {
  return dispatch.mock.calls.flatMap(([spec]) =>
    [(spec as TransactionSpec).effects ?? []]
      .flat()
      .flatMap((effect) => (effect.is(revealDictationStart) ? [effect.value] : []))
  );
}

afterEach(() => {
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
    const dispatch = vi.spyOn(view, "dispatch");

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

    expect(reveals(dispatch)).toEqual([3]);
    view.destroy();
  });

  it("follows a dictation, and leaves its cleanup until it has stopped", () => {
    useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
    const view = mount(DICTATED);
    const dispatch = vi.spyOn(view, "dispatch");

    act(() => {
      useVoiceRecordingStore.getState().beginSession({ panelId: PANEL }, "s1");
      useVoiceRecordingStore.getState().setStatus("recording");
    });
    expect(view.state.field(dictationFollowField).session).toBe("s1");

    // A chunk cleaned while the dictation runs.
    act(() => {
      useVoiceRecordingStore
        .getState()
        .setCorrectionRanges(PANEL, [{ from: 0, to: 9, session: "s1" }]);
    });
    expect(reveals(dispatch)).toEqual([]);

    act(() => {
      useVoiceRecordingStore.getState().finishSession();
    });
    expect(view.state.field(dictationFollowField).session).toBeNull();
    expect(reveals(dispatch)).toEqual([0]);
    view.destroy();
  });

  it("never moves for a spoken rewrite of a selection", () => {
    useTerminalInputStore.getState().setDraftInput(PANEL, DICTATED);
    const view = mount(DICTATED);
    const dispatch = vi.spyOn(view, "dispatch");

    act(() => {
      useVoiceRecordingStore.getState().setCorrectionRanges(PANEL, [{ from: 3, to: 9 }]);
    });

    expect(reveals(dispatch)).toEqual([]);
    view.destroy();
  });
});
