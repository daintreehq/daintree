// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { interimWidgetField, pendingAIField } from "../../inputEditorExtensions";

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
    state: EditorState.create({ doc, extensions: [interimWidgetField, pendingAIField] }),
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

afterEach(() => {
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
});
