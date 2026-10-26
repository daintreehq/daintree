// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { createComposerHistory } from "../../inputEditorExtensions/composerHistory";
import { createCorrectionReview } from "../../inputEditorExtensions/correctionReview";

// Enter while dictating, end to end through the real voice service, both real
// stores and a real editor: the send waits for the passage's correction, up to
// the cap, and a late result never reaches the next draft (#14611).

vi.mock("@/store", async () => {
  const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
  return { useVoiceRecordingStore };
});

vi.mock("@/store/panelStore", () => {
  const state = { panelsById: {}, panelIds: [], focusedId: null };
  const getState = () => state;
  return { usePanelStore: Object.assign(getState, { getState, subscribe: vi.fn(() => () => {}) }) };
});

vi.mock("@/store/projectStore", () => {
  const getState = () => ({ currentProject: null, isSwitching: false, switchProject: vi.fn() });
  return { useProjectStore: Object.assign(getState, { getState }) };
});

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ worktrees: new Map() }) }),
}));

vi.mock("@/store/worktreeStore", () => {
  const getState = () => ({ activeWorktreeId: null, selectWorktree: vi.fn() });
  return { useWorktreeSelectionStore: Object.assign(getState, { getState }) };
});

vi.mock("@/store/helpPanelStore", () => {
  const state = { isOpen: false, terminalId: null };
  const getState = () => ({ ...state, setOpen: vi.fn(), requestFocus: vi.fn() });
  return {
    useHelpPanelStore: Object.assign(getState, { getState }),
    selectActiveSlot: (s: typeof state) => s,
  };
});

vi.mock("@/store/macroFocusStore", () => ({ isAssistantFocused: vi.fn(() => false) }));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: vi.fn(),
    getEffectiveCombos: vi.fn(() => []),
    matchesEvent: vi.fn(),
  },
}));

import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { subscribeDictationRangeTracking } from "@/store/dictationRangeStore";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { useVoiceWaitSubmit } from "../useVoiceWaitSubmit";

type DeltaPayload = { text: string; itemId?: string };
type CompletePayload = { text: string; willCorrect: boolean; itemId?: string };
type CorrectResult = { action: "no_change" | "replace"; correctedText: string };

const callbacks: {
  delta: ((payload: DeltaPayload) => void) | null;
  complete: ((payload: CompletePayload) => void) | null;
} = { delta: null, complete: null };

const correct = vi.fn<(request: { rawText: string }) => Promise<CorrectResult>>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let itemSeq = 0;
function dictate(panelId: string, text: string) {
  useVoiceRecordingStore.getState().beginSession({ panelId });
  const itemId = `item-${++itemSeq}`;
  callbacks.delta!({ text, itemId });
  callbacks.complete!({ text, willCorrect: false, itemId });
}

const draft = (panelId: string) => useTerminalInputStore.getState().getDraftInput(panelId);

const PANEL_ID = "panel-1";

describe("useVoiceWaitSubmit with a real correction pass (#14611)", () => {
  let view: EditorView;
  let sent: string[];
  // The store orchestrator keeps dictation ranges on their text in the app;
  // correction finds its passages through them.
  let unsubscribeRanges: () => void;

  beforeEach(async () => {
    Object.assign(window, {
      electron: {
        voiceInput: {
          onTranscriptionDelta: vi.fn((cb: (payload: DeltaPayload) => void) => {
            callbacks.delta = cb;
            return () => {};
          }),
          onTranscriptionComplete: vi.fn((cb: (payload: CompletePayload) => void) => {
            callbacks.complete = cb;
            return () => {};
          }),
          onParagraphBoundary: vi.fn(() => () => {}),
          onFileTokenResolved: vi.fn(() => () => {}),
          onError: vi.fn(() => () => {}),
          onStatus: vi.fn(() => () => {}),
          onSessionEnded: vi.fn(() => () => {}),
          getSettings: vi.fn().mockResolvedValue({
            enabled: true,
            openaiApiKey: "sk-key",
            correctionEnabled: true,
          }),
          stop: vi.fn().mockResolvedValue(undefined),
          correct,
        },
        systemSleep: {
          onSuspend: vi.fn(() => () => {}),
          onWake: vi.fn(() => () => {}),
        },
      },
    });
    correct.mockReset();
    useTerminalInputStore.setState({ draftInputs: new Map(), voiceSubmittingPanels: new Set() });
    useVoiceRecordingStore.setState({ panelBuffers: {}, activeTarget: null, status: "idle" });
    unsubscribeRanges = subscribeDictationRangeTracking();
    voiceRecordingService.initialize();
    await voiceRecordingService.refreshConfiguration();
    sent = [];
  });

  afterEach(() => {
    voiceRecordingService.destroy();
    unsubscribeRanges();
    view?.destroy();
    vi.useRealTimers();
  });

  const isEditable = () => view.state.facet(EditorView.editable);

  function renderComposer(options: { extensions?: Extension[]; holdSend?: boolean } = {}) {
    const compartment = new Compartment();
    // The editor still shows the raw transcript: a store write only reaches it
    // on the next render, which the hook has to beat (#9172).
    view = new EditorView({
      state: EditorState.create({
        doc: draft(PANEL_ID),
        extensions: [compartment.of(EditorView.editable.of(true)), ...(options.extensions ?? [])],
      }),
      parent: document.body,
    });
    // Like the composer's own send: it drops what is still being corrected,
    // then reads the editor. The submit is still in flight, so the draft stays.
    // A held send is one the composer refuses (an upload still on its way).
    const sendFromEditor = vi.fn(() => {
      if (options.holdSend) return;
      voiceRecordingService.discardPendingCorrections(PANEL_ID);
      sent.push(view.state.doc.toString());
    });
    const { result } = renderHook(() =>
      useVoiceWaitSubmit({
        terminalId: PANEL_ID,
        editorViewRef: { current: view },
        editableCompartmentRef: { current: compartment },
        sendFromEditor,
      })
    );
    return result;
  }

  it("holds Enter while dictating until a slow correction lands, then sends it", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    dictate(PANEL_ID, "hello wrld");
    const result = renderComposer();

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    expect(correct).toHaveBeenCalledWith({ rawText: "hello wrld" });
    expect(result.current.voiceSubmitPhase).toBe("polishing");
    expect(isEditable()).toBe(false);
    expect(sent).toEqual([]);

    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(sent).toEqual(["Hello world."]);
    expect(result.current.voiceSubmitPhase).toBeNull();
    expect(isEditable()).toBe(true);
  });

  it("leaves a correction it synced marked and undoable when the send is held back", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    dictate(PANEL_ID, "hello wrld");
    const result = renderComposer({
      extensions: [createComposerHistory(), createCorrectionReview()],
      holdSend: true,
    });

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(sent).toEqual([]);
    expect(view.state.doc.toString()).toBe("Hello world.");
    expect(view.contentDOM.querySelectorAll(".cm-voice-corrected")).toHaveLength(1);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("hello wrld");
  });

  it("sends the current text at the cap, and the late correction never touches the draft", async () => {
    vi.useFakeTimers();
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    dictate(PANEL_ID, "hello wrld");
    const result = renderComposer();

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(sent).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(sent).toEqual(["hello wrld"]);

    // The draft still holds the passage while the submit is in flight; the
    // late result must not rewrite it under the send.
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(draft(PANEL_ID)).toBe("hello wrld");
    expect(sent).toEqual(["hello wrld"]);
  });

  it("still sends the corrected text when a session elsewhere starts and stops meanwhile", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    correct.mockResolvedValueOnce({ action: "no_change", correctedText: "elsewhere" });
    dictate(PANEL_ID, "hello wrld");
    const result = renderComposer();

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    await act(async () => {
      dictate("panel-2", "elsewhere");
      await voiceRecordingService.stop();
    });
    expect(sent).toEqual([]);

    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(sent).toEqual(["Hello world."]);
  });

  it("lets the correction land in the draft when Escape cancels the send", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    dictate(PANEL_ID, "hello wrld");
    const result = renderComposer();

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    act(() => {
      result.current.cancelVoiceWaitSubmit();
    });
    expect(isEditable()).toBe(true);
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(sent).toEqual([]);
    expect(draft(PANEL_ID)).toBe("Hello world.");
  });
});
