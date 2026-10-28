// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { createComposerHistory } from "../../inputEditorExtensions/composerHistory";
import {
  correctionReviewField,
  createCorrectionReview,
} from "../../inputEditorExtensions/correctionReview";
import { addImageChip, imageChipField, readImageChipPaths } from "../../inputEditorExtensions";

// Enter while dictating, end to end through the real voice service, both real
// stores and a real editor: the send waits for the passage's correction to land
// or fail, a second Enter sends what stands, and a late result never reaches
// the next draft (#14611, #14780).

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
import {
  subscribeDictationRangeTracking,
  useDictationRangeStore,
} from "@/store/dictationRangeStore";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { planVoiceDraftSend, type VoiceDraftSend } from "@/services/voiceDraftSend";
import { useVoiceWaitSubmit } from "../useVoiceWaitSubmit";

type DeltaPayload = { text: string; itemId?: string };
type CompletePayload = { text: string; willCorrect: boolean; itemId?: string };
type CorrectResult = { action: "no_change" | "replace"; correctedText: string; failed?: true };

const callbacks: {
  delta: ((payload: DeltaPayload) => void) | null;
  complete: ((payload: CompletePayload) => void) | null;
} = { delta: null, complete: null };

const correct = vi.fn<(request: { rawText: string }) => Promise<CorrectResult>>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// The lock blurs the editor, so a key during the wait reaches the page, not it.
function pressKey(key: string, init: KeyboardEventInit = {}) {
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
  );
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

// jsdom has no layout: CodeMirror's measure frame reads text through Range
// rects it lacks, and a marked passage gives it something to measure.
const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
const originalRangeBounds = Range.prototype.getBoundingClientRect;
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(() => {
  if (originalRangeRects)
    Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
  else delete (Range.prototype as Partial<Range>).getClientRects;
  Range.prototype.getBoundingClientRect = originalRangeBounds;
});

describe("useVoiceWaitSubmit with a real correction pass (#14611, #14780)", () => {
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
          onCorrectionProgress: vi.fn(() => () => {}),
          onFileTokenResolved: vi.fn(() => () => {}),
          onError: vi.fn(() => () => {}),
          onStatus: vi.fn(() => () => {}),
          onSessionEnded: vi.fn(() => () => {}),
          onLiveSession: vi.fn(() => () => {}),
          onStopRequested: vi.fn(() => () => {}),
          onRevealRequested: vi.fn(() => () => {}),
          onLiveLevel: vi.fn(() => () => {}),
          onPauseRequested: vi.fn(() => () => {}),
          publishDetails: vi.fn().mockResolvedValue(undefined),
          setPausedLive: vi.fn().mockResolvedValue(true),
          getLiveSession: vi.fn().mockResolvedValue({ revision: 0, session: null }),
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
    // then reads the editor. The submit is still in flight, so the draft stays,
    // unless the send holds back a newer dictation's words: those are all it
    // leaves. A held send is one the composer refuses (an upload still on its
    // way).
    const sendFromEditor = vi.fn((_handBack?: unknown, voiceSend?: VoiceDraftSend) => {
      if (options.holdSend) return false;
      voiceRecordingService.discardPendingCorrections(PANEL_ID, voiceSend?.sessions);
      const doc = view.state.doc.toString();
      const split = voiceSend?.kept && voiceSend.draft === doc ? voiceSend : null;
      sent.push(split?.text ?? doc);
      const kept = split ? voiceRecordingService.keepHeldBackDictation(split) : null;
      if (kept !== null) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: kept } });
      }
      return true;
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
    expect(correct).toHaveBeenCalledWith({
      rawText: "hello wrld",
      startsPrompt: true,
      terminalId: "panel-1",
      sessionId: expect.any(String),
      streamId: expect.any(String),
    });
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

  it("sends an image between two corrected passages still attached (#14781)", async () => {
    correct.mockImplementation(async ({ rawText }) => ({
      action: "replace",
      correctedText: rawText.replace("parsr", "parser").replace("lexr", "lexer"),
    }));
    const image = "/tmp/screenshot.png";
    dictate(PANEL_ID, "the parsr");
    useTerminalInputStore.getState().setDraftInput(PANEL_ID, `${draft(PANEL_ID)} ${image} `);
    const itemId = `item-${++itemSeq}`;
    callbacks.delta!({ text: "the lexr", itemId });
    callbacks.complete!({ text: "the lexr", willCorrect: false, itemId });
    const result = renderComposer({ extensions: [imageChipField] });
    const at = draft(PANEL_ID).indexOf(image);
    view.dispatch({
      effects: addImageChip.of({
        from: at,
        to: at + image.length,
        filePath: image,
        thumbnailUrl: "data:image/png;base64,",
      }),
    });

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });

    expect(sent).toEqual([`the parser ${image} the lexer`]);
    expect(readImageChipPaths(view)).toEqual([image]);
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

  it("syncs a correction a newer dictation overtook without its review, still undoable (#14875)", async () => {
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
    useVoiceRecordingStore.getState().beginSession({ panelId: PANEL_ID }, "session-next");
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(view.state.doc.toString()).toBe("Hello world.");
    expect(view.state.field(correctionReviewField, false)).toBeNull();
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("hello wrld");
  });

  it.each([
    ["its own dictation", false],
    ["a newer dictation", true],
  ])(
    "replays a correction the composer already shows, reviewed only for %s's (#14875)",
    async (_, overtaken) => {
      correct.mockResolvedValueOnce({ action: "replace", correctedText: "Hello world." });
      dictate(PANEL_ID, "hello wrld");
      await act(async () => {
        await voiceRecordingService.stop();
      });
      await vi.waitFor(() => expect(draft(PANEL_ID)).toBe("Hello world."));
      if (overtaken) {
        const voice = useVoiceRecordingStore.getState();
        voice.beginSession({ panelId: PANEL_ID }, "session-next");
        voice.finishSession();
      }
      const result = renderComposer({
        extensions: [createComposerHistory(), createCorrectionReview()],
        holdSend: true,
      });

      await act(async () => {
        result.current.startVoiceWaitSubmit();
      });

      expect(view.state.doc.toString()).toBe("Hello world.");
      expect(view.state.field(correctionReviewField, false) === null).toBe(overtaken);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("hello wrld");
    }
  );

  it("waits for a cleanup slower than two seconds and sends it cleaned", async () => {
    vi.useFakeTimers();
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    dictate(PANEL_ID, "hello wrld");
    const result = renderComposer();

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(sent).toEqual([]);
    expect(result.current.voiceSubmitPhase).toBe("polishing");
    expect(isEditable()).toBe(false);

    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(sent).toEqual(["Hello world."]);
    expect(isEditable()).toBe(true);
  });

  it("sends the text as it stands at a second Enter, and the late cleanup never touches the draft", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    dictate(PANEL_ID, "hello wrld");
    const result = renderComposer();

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    expect(result.current.voiceSubmitPhase).toBe("polishing");

    await act(async () => {
      pressKey("Enter");
    });
    expect(sent).toEqual(["hello wrld"]);
    expect(result.current.voiceSubmitPhase).toBeNull();
    expect(isEditable()).toBe(true);

    // The draft still holds the passage while the submit is in flight; the
    // late result must not rewrite it under the send.
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(draft(PANEL_ID)).toBe("hello wrld");
    expect(sent).toEqual(["hello wrld"]);
  });

  it("sends the raw text once a slow cleanup fails", async () => {
    vi.useFakeTimers();
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    dictate(PANEL_ID, "hello wrld");
    const result = renderComposer();

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_900);
    });
    expect(sent).toEqual([]);

    // What main hands back when the request times out.
    await act(async () => {
      pending.resolve({ action: "no_change", correctedText: "hello wrld", failed: true });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(sent).toEqual(["hello wrld"]);
    expect(result.current.voiceSubmitPhase).toBeNull();
  });

  it("sends the raw text when the cleanup request throws", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    dictate(PANEL_ID, "hello wrld");
    const result = renderComposer();

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    expect(sent).toEqual([]);

    await act(async () => {
      pending.reject(new Error("IPC channel closed"));
    });

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

  it("keeps a dictation started on the same panel during the wait out of the send (#14804)", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    dictate(PANEL_ID, "hello wrld");
    const result = renderComposer();

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    // The dictation key again straight away, for the next prompt: its first
    // words land while the send still waits on the cleanup.
    act(() => {
      dictate(PANEL_ID, "these are the next prompt");
    });
    expect(sent).toEqual([]);

    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(sent).toEqual(["Hello world."]);
    expect(draft(PANEL_ID)).toBe("these are the next prompt");

    // Still recording, its later words join the ones it kept.
    act(() => {
      callbacks.complete!({ text: "and the rest", willCorrect: false, itemId: "item-late" });
    });
    expect(draft(PANEL_ID)).toBe("these are the next prompt and the rest");
  });

  it("doesn't wait for a dictation started and stopped during the wait, and its cleanup lands on what it kept", async () => {
    const pending = deferred<CorrectResult>();
    const later = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise).mockReturnValueOnce(later.promise);
    dictate(PANEL_ID, "hello wrld");
    const result = renderComposer();

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    await act(async () => {
      dictate(PANEL_ID, "the nxt prompt");
      await voiceRecordingService.stop();
    });
    expect(correct).toHaveBeenLastCalledWith(
      expect.objectContaining({ rawText: "the nxt prompt" })
    );

    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });
    expect(sent).toEqual(["Hello world."]);
    expect(draft(PANEL_ID)).toBe("the nxt prompt");

    await act(async () => {
      later.resolve({ action: "replace", correctedText: "The next prompt." });
    });
    expect(draft(PANEL_ID)).toBe("The next prompt.");
    expect(sent).toEqual(["Hello world."]);
  });

  it("keeps a newer dictation's words out of the send when its cleanup lands first", async () => {
    const pending = deferred<CorrectResult>();
    const later = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise).mockReturnValueOnce(later.promise);
    dictate(PANEL_ID, "hello wrld");
    const result = renderComposer();

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    await act(async () => {
      dictate(PANEL_ID, "the nxt prompt");
      await voiceRecordingService.stop();
    });
    await act(async () => {
      later.resolve({ action: "replace", correctedText: "The next prompt." });
    });
    expect(draft(PANEL_ID)).toBe("hello wrld The next prompt.");
    expect(sent).toEqual([]);

    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });
    expect(sent).toEqual(["Hello world."]);
    expect(draft(PANEL_ID)).toBe("The next prompt.");
  });

  it("sends only what the stopped dictation left at a second Enter, keeping the newer one's words", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    dictate(PANEL_ID, "hello wrld");
    const result = renderComposer();

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    act(() => {
      dictate(PANEL_ID, "these are the next prompt");
    });
    await act(async () => {
      pressKey("Enter");
    });

    expect(sent).toEqual(["hello wrld"]);
    expect(draft(PANEL_ID)).toBe("these are the next prompt");
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });
    expect(draft(PANEL_ID)).toBe("these are the next prompt");
  });

  it("lets Escape take back a newer dictation it held back, as if nothing came before it", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    dictate(PANEL_ID, "hello wrld");
    const result = renderComposer();

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    act(() => {
      dictate(PANEL_ID, "these are the next prompt");
    });
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });
    expect(draft(PANEL_ID)).toBe("these are the next prompt");

    expect(sent).toEqual(["Hello world."]);

    // The space it was written with went with the sent prompt, and none of
    // its words count as edited for it.
    await act(async () => {
      // The first press asks for a second (#14927).
      expect(voiceRecordingService.handleEscape(PANEL_ID)).toBe(true);
      expect(voiceRecordingService.handleEscape(PANEL_ID)).toBe(true);
    });
    expect(draft(PANEL_ID)).toBe("");
  });

  it("holds back a spoken send whose own prompt is too short, whatever the newer dictation adds", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    dictate(PANEL_ID, "fix it");
    const result = renderComposer();

    await act(async () => {
      result.current.startVoiceWaitSubmit({ spoken: true });
    });
    act(() => {
      dictate(PANEL_ID, "these are the next prompt");
    });
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Fix it." });
    });

    expect(sent).toEqual([]);
    expect(draft(PANEL_ID)).toBe("Fix it. these are the next prompt");
  });

  describe("keeping what it held back once the send has gone", () => {
    /** The old prompt stopped and cleaned, and a newer dictation after it. */
    function splitDraft(): VoiceDraftSend {
      dictate(PANEL_ID, "hello wrld");
      const sessions = voiceRecordingService.sendSessions(PANEL_ID, undefined);
      dictate(PANEL_ID, "these are the next prompt");
      return planVoiceDraftSend(
        { panelId: PANEL_ID, projectId: undefined },
        draft(PANEL_ID),
        useDictationRangeStore.getState().listDictations(PANEL_ID),
        sessions
      );
    }

    it("takes in what the newer dictation wrote while the send was out", () => {
      const send = splitDraft();
      expect(send.text).toBe("hello wrld");

      callbacks.complete!({ text: "and the rest", willCorrect: false, itemId: "item-late" });

      expect(voiceRecordingService.keepHeldBackDictation(send)).toBe(
        "these are the next prompt and the rest"
      );
      expect(draft(PANEL_ID)).toBe("these are the next prompt and the rest");
    });

    it("leaves the draft alone once the sent text itself changed", () => {
      const send = splitDraft();
      const changed = draft(PANEL_ID).replace("hello", "goodbye");
      useTerminalInputStore.getState().setDraftInput(PANEL_ID, changed);

      expect(voiceRecordingService.keepHeldBackDictation(send)).toBeNull();
      expect(draft(PANEL_ID)).toBe(changed);
    });
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
      pressKey("Escape");
      // Held down, its repeats must not reach the editor's own Escape.
      pressKey("Escape", { repeat: true });
    });
    expect(isEditable()).toBe(true);
    expect(result.current.voiceSubmitPhase).toBeNull();
    expect(view.hasFocus).toBe(false);
    // The keyboard was nowhere: on release it goes back to the unlocked editor.
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
    });
    expect(view.hasFocus).toBe(true);
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(sent).toEqual([]);
    expect(draft(PANEL_ID)).toBe("Hello world.");
  });

  it("calls the send off at Enter on Cancel send, and hands the keyboard back on its release", async () => {
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);
    dictate(PANEL_ID, "hello wrld");
    const result = renderComposer();
    const bar = document.createElement("div");
    bar.setAttribute("data-hybrid-input-root", PANEL_ID);
    const cancel = document.createElement("button");
    cancel.setAttribute("data-voice-wait-cancel", "");
    bar.appendChild(cancel);
    document.body.appendChild(bar);

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });
    act(() => {
      cancel.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
      );
    });
    expect(isEditable()).toBe(true);
    expect(result.current.voiceSubmitPhase).toBeNull();
    // The button goes with the wait, leaving the keyboard nowhere.
    bar.remove();
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    });
    expect(view.hasFocus).toBe(true);
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(sent).toEqual([]);
    expect(draft(PANEL_ID)).toBe("Hello world.");
  });
});
