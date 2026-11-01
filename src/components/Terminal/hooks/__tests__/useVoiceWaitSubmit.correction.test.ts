// @vitest-environment jsdom
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
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
import { createCaretTracker } from "../../inputEditorExtensions/caretTracker";
import { makeDraftKey } from "@/lib/draftKey";

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
import { VOICE_SEND_REFUSED_MESSAGE } from "@/services/voiceSendDiagnostics";
import { logInfo } from "@/utils/logger";
import { planVoiceDraftSend, type VoiceDraftSend } from "@/services/voiceDraftSend";
import { useVoiceWaitSubmit } from "../useVoiceWaitSubmit";

type DeltaPayload = { text: string; itemId?: string };
type CompletePayload = { text: string; willCorrect: boolean; itemId?: string; send?: boolean };
type CorrectResult = {
  action: "no_change" | "replace";
  correctedText: string;
  failed?: true;
  verdict?: "replaced" | "unchanged" | "failed" | "timed_out";
};

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

  function renderComposer(
    options: {
      extensions?: Extension[];
      // A send the composer refuses (an upload still on its way): at once, once
      // it answers, by failing, or when the test lets its answer through.
      holdSend?: boolean | "later" | "reject" | (() => Promise<boolean>);
      duringSend?: () => void;
      isDisabled?: () => boolean;
    } = {}
  ) {
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
      options.duringSend?.();
      if (typeof options.holdSend === "function") return options.holdSend();
      if (options.holdSend === "later") return Promise.resolve(false);
      if (options.holdSend === "reject") return Promise.reject(new Error("upload failed"));
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
        isDisabled: options.isDisabled,
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
    // The cleanup landed, so the receipt says only that it went.
    expect(result.current.voiceSubmitOutcome).toEqual({ kind: "sent", attempt: 1 });
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
    await act(async () => {
      await voiceRecordingService.stop();
    });
    // A newer dictation comes and goes while the cleanup is still out; one
    // that began during the wait would reopen the send instead (#15703).
    const voice = useVoiceRecordingStore.getState();
    voice.beginSession({ panelId: PANEL_ID }, "session-next");
    voice.finishSession();
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
    expect(result.current.voiceSubmitOutcome).toEqual({
      kind: "sent",
      attempt: 1,
      cleanup: "skipped",
    });

    // The draft still holds the passage while the submit is in flight; the
    // late result must not rewrite it under the send.
    await act(async () => {
      pending.resolve({ action: "replace", correctedText: "Hello world." });
    });

    expect(draft(PANEL_ID)).toBe("hello wrld");
    expect(sent).toEqual(["hello wrld"]);
    expect(result.current.voiceSubmitOutcome?.cleanup).toBe("skipped");
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
      pending.resolve({
        action: "no_change",
        correctedText: "hello wrld",
        failed: true,
        verdict: "timed_out",
      });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(sent).toEqual(["hello wrld"]);
    expect(result.current.voiceSubmitPhase).toBeNull();
    expect(result.current.voiceSubmitOutcome).toEqual({
      kind: "sent",
      attempt: 1,
      cleanup: "failed",
    });
  });

  it("says the cleanup failed when it fails before the wait for it begins", async () => {
    correct.mockResolvedValueOnce({
      action: "no_change",
      correctedText: "hello wrld",
      failed: true,
    });
    dictate(PANEL_ID, "hello wrld");
    // A stop that returns only once its cleanup has failed: no wait for it
    // begins, so only a watch kept from the Enter knows it failed.
    const stop = voiceRecordingService.stop.bind(voiceRecordingService);
    const stopSpy = vi
      .spyOn(voiceRecordingService, "stop")
      .mockImplementation(async (...args: Parameters<typeof stop>) => {
        const stopped = await stop(...args);
        while (voiceRecordingService.hasPendingCorrection(PANEL_ID)) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return stopped;
      });
    try {
      const result = renderComposer();
      await act(async () => {
        result.current.startVoiceWaitSubmit();
        await vi.waitFor(() => expect(sent).toEqual(["hello wrld"]));
      });

      expect(result.current.voiceSubmitPhase).toBeNull();
      expect(result.current.voiceSubmitOutcome?.cleanup).toBe("failed");
    } finally {
      stopSpy.mockRestore();
    }
  });

  it("says nothing of a cleanup that came back with nothing to change", async () => {
    correct.mockResolvedValueOnce({ action: "no_change", correctedText: "hello world" });
    dictate(PANEL_ID, "hello world");
    const result = renderComposer();

    await act(async () => {
      result.current.startVoiceWaitSubmit();
    });

    expect(sent).toEqual(["hello world"]);
    expect(result.current.voiceSubmitOutcome).toEqual({ kind: "sent", attempt: 1 });
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
    expect(result.current.voiceSubmitOutcome?.cleanup).toBe("failed");
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

  describe("a dictation started in the draft while its send waits (#15703)", () => {
    /**
     * Enter on a passage whose cleanup is held, then the dictation key again in
     * the same composer, its first words landing straight away.
     */
    async function reopenSend(options: { extensions?: Extension[]; beforeSend?: () => void } = {}) {
      const first = deferred<CorrectResult>();
      correct.mockReturnValueOnce(first.promise);
      dictate(PANEL_ID, "hello wrld");
      const result = renderComposer(options);
      options.beforeSend?.();
      await act(async () => {
        result.current.startVoiceWaitSubmit();
      });
      act(() => {
        dictate(PANEL_ID, "and the next part");
      });
      return { result, first };
    }

    const landFirst = (first: ReturnType<typeof deferred<CorrectResult>>) =>
      act(async () => {
        first.resolve({ action: "replace", correctedText: "Hello world." });
      });

    it("calls the send off as Escape does, and the first cleanup still lands in the draft", async () => {
      const { result, first } = await reopenSend();

      expect(result.current.voiceSubmitOutcome?.kind).toBe("reopened");
      expect(result.current.voiceSubmitPhase).toBeNull();
      expect(useTerminalInputStore.getState().isVoiceSubmitting(PANEL_ID)).toBe(false);
      expect(isEditable()).toBe(true);

      await landFirst(first);

      expect(sent).toEqual([]);
      expect(draft(PANEL_ID)).toBe("Hello world. and the next part");
    });

    it("reopens at the dictation key's press, before its session begins", async () => {
      const first = deferred<CorrectResult>();
      correct.mockReturnValueOnce(first.promise);
      dictate(PANEL_ID, "hello wrld");
      const result = renderComposer();

      await act(async () => {
        result.current.startVoiceWaitSubmit();
      });
      act(() => {
        useVoiceRecordingStore.getState().setArming({ panelId: PANEL_ID });
      });

      expect(result.current.voiceSubmitOutcome?.kind).toBe("reopened");
      await landFirst(first);
      expect(sent).toEqual([]);
    });

    describe("the summary of the session that reopened it (#15704)", () => {
      // The service is a singleton, so its spy keeps the calls of earlier tests.
      const reopened = () => vi.spyOn(voiceRecordingService, "noteSendReopened").mockClear();

      it("names the session that began in the draft", async () => {
        const noted = reopened();
        await reopenSend();

        const session =
          useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.dictationSessionId;
        expect(session).toEqual(expect.any(String));
        expect(noted.mock.calls).toEqual([[{ sessionId: session }]]);
      });

      it("names the armed target when the key's press reopened it, before its session exists", async () => {
        const noted = reopened();
        const first = deferred<CorrectResult>();
        correct.mockReturnValueOnce(first.promise);
        dictate(PANEL_ID, "hello wrld");
        const result = renderComposer();
        await act(async () => {
          result.current.startVoiceWaitSubmit();
        });

        const armed = { panelId: PANEL_ID };
        act(() => {
          useVoiceRecordingStore.getState().setArming(armed);
        });

        expect(noted).toHaveBeenCalledTimes(1);
        const [by] = noted.mock.calls[0]!;
        // The very object the key armed: that identity is what carries the note to its session.
        expect("target" in by && by.target).toBe(armed);
        await landFirst(first);
      });

      it("names nothing for a dictation on another panel, which leaves the send alone", async () => {
        const noted = reopened();
        const first = deferred<CorrectResult>();
        correct.mockReturnValueOnce(first.promise);
        dictate(PANEL_ID, "hello wrld");
        const result = renderComposer();
        await act(async () => {
          result.current.startVoiceWaitSubmit();
        });
        act(() => {
          useVoiceRecordingStore.getState().setArming({ panelId: "panel-2" });
        });

        expect(noted).not.toHaveBeenCalled();
        await landFirst(first);
        expect(sent).toEqual(["Hello world."]);
      });

      it("names nothing for a send nothing reopened", async () => {
        const noted = reopened();
        dictate(PANEL_ID, "hello wrld");
        correct.mockResolvedValueOnce({ action: "no_change", correctedText: "" });
        const result = renderComposer();
        await act(async () => {
          result.current.startVoiceWaitSubmit();
        });

        expect(noted).not.toHaveBeenCalled();
        expect(sent).toEqual(["hello wrld"]);
      });
    });

    it("leaves the send alone for a dictation key pressed on another panel (#14611)", async () => {
      const first = deferred<CorrectResult>();
      correct.mockReturnValueOnce(first.promise);
      dictate(PANEL_ID, "hello wrld");
      const result = renderComposer();

      await act(async () => {
        result.current.startVoiceWaitSubmit();
      });
      act(() => {
        useVoiceRecordingStore.getState().setArming({ panelId: "panel-2" });
      });

      expect(result.current.voiceSubmitPhase).toBe("polishing");
      await landFirst(first);
      expect(sent).toEqual(["Hello world."]);
    });

    it("sends both passages as one prompt at Enter (#14804)", async () => {
      const { result, first } = await reopenSend();
      await landFirst(first);
      // Still recording, its later words join the draft.
      act(() => {
        callbacks.complete!({ text: "and the rest", willCorrect: false, itemId: "item-late" });
      });
      correct.mockResolvedValueOnce({ action: "no_change", correctedText: "" });

      await act(async () => {
        result.current.startVoiceWaitSubmit();
      });

      expect(sent).toEqual(["Hello world. and the next part and the rest"]);
      expect(useVoiceRecordingStore.getState().status).toBe("idle");
    });

    it.each([
      ["the new passage's", "second"],
      ["the first passage's", "first"],
    ] as const)("waits at Enter for both cleanups, %s landing first", async (_, landsFirst) => {
      const { result, first } = await reopenSend();
      const second = deferred<CorrectResult>();
      correct.mockReturnValueOnce(second.promise);
      const landSecond = () =>
        act(async () => {
          second.resolve({ action: "replace", correctedText: "And the next part." });
        });

      await act(async () => {
        result.current.startVoiceWaitSubmit();
      });
      expect(correct).toHaveBeenLastCalledWith(
        expect.objectContaining({ rawText: "and the next part" })
      );
      await (landsFirst === "second" ? landSecond() : landFirst(first));
      expect(sent).toEqual([]);
      expect(result.current.voiceSubmitPhase).toBe("polishing");

      await (landsFirst === "second" ? landFirst(first) : landSecond());

      expect(sent).toEqual(["Hello world. And the next part."]);
    });

    it("sends both from the session panel's Send", async () => {
      const { first } = await reopenSend();
      act(() => {
        useVoiceRecordingStore.getState().setStatus("recording");
      });
      correct.mockResolvedValueOnce({ action: "no_change", correctedText: "" });

      await act(async () => {
        await voiceRecordingService.stopAndSend();
      });
      expect(useVoiceRecordingStore.getState().status).toBe("idle");
      expect(sent).toEqual([]);

      await landFirst(first);

      expect(sent).toEqual(["Hello world. and the next part"]);
    });

    it("sends both at a spoken send", async () => {
      const { first } = await reopenSend();
      act(() => {
        useVoiceRecordingStore.getState().setStatus("recording");
      });
      correct.mockResolvedValueOnce({ action: "no_change", correctedText: "" });

      // Main has already taken "send it" off the utterance.
      await act(async () => {
        callbacks.complete!({
          text: "and that is all",
          willCorrect: false,
          itemId: "item-send",
          send: true,
        });
      });
      expect(useVoiceRecordingStore.getState().status).toBe("idle");
      expect(sent).toEqual([]);

      await landFirst(first);

      expect(sent).toEqual(["Hello world. and the next part and that is all"]);
    });

    it("leaves both passages unsent when the dictation stops without a send", async () => {
      const { first } = await reopenSend();
      const second = deferred<CorrectResult>();
      correct.mockReturnValueOnce(second.promise);

      await act(async () => {
        await voiceRecordingService.stop();
      });
      await landFirst(first);
      await act(async () => {
        second.resolve({ action: "replace", correctedText: "And the next part." });
      });

      expect(sent).toEqual([]);
      expect(draft(PANEL_ID)).toBe("Hello world. And the next part.");
    });

    it("lets Escape take back only the new dictation, leaving the first passage unsent", async () => {
      const { first } = await reopenSend();
      await landFirst(first);

      // The first press asks for a second (#14927).
      await act(async () => {
        expect(voiceRecordingService.handleEscape(PANEL_ID)).toBe(true);
        expect(voiceRecordingService.handleEscape(PANEL_ID)).toBe(true);
      });

      expect(draft(PANEL_ID)).toBe("Hello world.");
      expect(sent).toEqual([]);
    });

    it("writes after the first passage, not over a selection left in it", async () => {
      await reopenSend({
        extensions: [createCaretTracker(() => makeDraftKey(PANEL_ID, undefined))],
        beforeSend: () => {
          view.focus();
          view.dispatch({ selection: { anchor: 6, head: 10 } });
        },
      });

      expect(draft(PANEL_ID)).toBe("hello wrld and the next part");
    });

    it("reopens a spoken send waiting on a short prompt, which the next send takes whole", async () => {
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
      expect(result.current.voiceSubmitOutcome?.kind).toBe("reopened");
      expect(isEditable()).toBe(true);
      await act(async () => {
        pending.resolve({ action: "replace", correctedText: "Fix it." });
      });
      expect(sent).toEqual([]);
      expect(draft(PANEL_ID)).toBe("Fix it. these are the next prompt");

      correct.mockResolvedValueOnce({ action: "no_change", correctedText: "" });
      await act(async () => {
        result.current.startVoiceWaitSubmit();
      });

      expect(sent).toEqual(["Fix it. these are the next prompt"]);
    });

    it("leaves a send alone from the moment the composer takes its text", async () => {
      const pending = deferred<CorrectResult>();
      correct.mockReturnValueOnce(pending.promise);
      dictate(PANEL_ID, "hello wrld");
      // The dictation key lands while the composer is taking the text.
      const result = renderComposer({
        duringSend: () => dictate(PANEL_ID, "the next prompt"),
      });

      await act(async () => {
        result.current.startVoiceWaitSubmit();
      });
      await act(async () => {
        pending.resolve({ action: "replace", correctedText: "Hello world." });
      });

      expect(sent).toEqual(["Hello world."]);
      expect(result.current.voiceSubmitOutcome?.kind).toBe("sent");
    });

    describe("a start already under way at Enter", () => {
      /** The dictation key, then Enter before its session begins, then the session. */
      async function enterWhileArming() {
        const first = deferred<CorrectResult>();
        correct.mockReturnValueOnce(first.promise);
        dictate(PANEL_ID, "hello wrld");
        await act(async () => {
          await voiceRecordingService.stop();
        });
        const result = renderComposer();
        act(() => {
          useVoiceRecordingStore.getState().setArming({ panelId: PANEL_ID });
        });
        await act(async () => {
          result.current.startVoiceWaitSubmit();
        });
        act(() => {
          dictate(PANEL_ID, "the next prompt");
          useVoiceRecordingStore.getState().setStatus("recording");
        });
        return { result, first };
      }

      it("holds its dictation back for the next prompt, as Enter before it began would (#14804)", async () => {
        const { result, first } = await enterWhileArming();
        expect(result.current.voiceSubmitPhase).toBe("polishing");

        await landFirst(first);

        expect(sent).toEqual(["Hello world."]);
        expect(draft(PANEL_ID)).toBe("the next prompt");
      });

      it("reopens the send for a send from that dictation, which takes both", async () => {
        const { result, first } = await enterWhileArming();
        const noted = vi.spyOn(voiceRecordingService, "noteSendReopened").mockClear();
        correct.mockResolvedValueOnce({ action: "no_change", correctedText: "" });

        await act(async () => {
          await voiceRecordingService.stopAndSend();
        });
        expect(useVoiceRecordingStore.getState().status).toBe("idle");
        expect(result.current.voiceSubmitPhase).toBe("polishing");
        // The send that took both says it was that dictation which reopened the wait.
        expect(noted).toHaveBeenCalledTimes(1);
        expect(noted).toHaveBeenCalledWith({ sessionId: expect.any(String) });

        await landFirst(first);

        expect(sent).toEqual(["Hello world. the next prompt"]);
      });
    });
  });

  describe("a send request that goes nowhere leaves a line (#15704)", () => {
    beforeEach(() => {
      vi.mocked(logInfo).mockClear();
    });

    const refusals = () =>
      vi
        .mocked(logInfo)
        .mock.calls.filter(([message]) => message === VOICE_SEND_REFUSED_MESSAGE)
        .map(([, context]) => context);
    const sessionIn = () =>
      useVoiceRecordingStore.getState().panelBuffers[PANEL_ID]?.dictationSessionId ?? null;

    it("says nothing when the send goes", async () => {
      dictate(PANEL_ID, "hello wrld");
      correct.mockResolvedValueOnce({ action: "no_change", correctedText: "" });
      const result = renderComposer();

      await act(async () => {
        result.current.startVoiceWaitSubmit();
      });

      expect(sent).toEqual(["hello wrld"]);
      expect(refusals()).toEqual([]);
    });

    it.each([
      ["Enter", undefined, "enter"],
      ["the session panel's Send", { asker: "session_panel_send" } as const, "session_panel_send"],
    ])("says who asked when %s finds the send already waiting", async (_name, options, asker) => {
      const pending = deferred<CorrectResult>();
      correct.mockReturnValueOnce(pending.promise);
      dictate(PANEL_ID, "hello wrld");
      const result = renderComposer();
      await act(async () => {
        result.current.startVoiceWaitSubmit();
      });

      await act(async () => {
        result.current.startVoiceWaitSubmit(options);
      });

      expect(refusals()).toEqual([
        { asker, reason: "already_waiting", panelId: PANEL_ID, sessionId: sessionIn() },
      ]);
      // The first send is untouched, and goes once.
      expect(result.current.voiceSubmitPhase).toBe("polishing");
      await act(async () => {
        pending.resolve({ action: "replace", correctedText: "Hello world." });
      });
      expect(sent).toEqual(["Hello world."]);
      expect(refusals()).toHaveLength(1);
    });

    it("says there is no dictation when the stop-and-send key lands on a send that is waiting", async () => {
      const pending = deferred<CorrectResult>();
      correct.mockReturnValueOnce(pending.promise);
      dictate(PANEL_ID, "hello wrld");
      const result = renderComposer();
      await act(async () => {
        result.current.startVoiceWaitSubmit();
      });

      await act(async () => {
        await voiceRecordingService.stopAndSend();
      });

      expect(refusals()).toEqual([
        {
          asker: "stop_and_send_key",
          reason: "no_session",
          panelId: null,
          sessionId: null,
        },
      ]);
      await act(async () => {
        pending.resolve({ action: "replace", correctedText: "Hello world." });
      });
      expect(sent).toEqual(["Hello world."]);
    });

    it("says a spoken send is too short once its cleanup has landed", async () => {
      const pending = deferred<CorrectResult>();
      correct.mockReturnValueOnce(pending.promise);
      dictate(PANEL_ID, "fix it");
      const result = renderComposer();
      await act(async () => {
        result.current.startVoiceWaitSubmit({ spoken: true, asker: "spoken_send" });
      });
      expect(refusals()).toEqual([]);

      await act(async () => {
        pending.resolve({ action: "replace", correctedText: "Fix it." });
      });

      expect(sent).toEqual([]);
      expect(refusals()).toEqual([
        {
          asker: "spoken_send",
          reason: "draft_too_short",
          panelId: PANEL_ID,
          sessionId: sessionIn(),
        },
      ]);
    });

    it("says a spoken send found nothing in the draft once its cleanup has landed", async () => {
      const pending = deferred<CorrectResult>();
      correct.mockReturnValueOnce(pending.promise);
      dictate(PANEL_ID, "fix it");
      const result = renderComposer();
      await act(async () => {
        result.current.startVoiceWaitSubmit({ spoken: true, asker: "spoken_send" });
      });
      useTerminalInputStore.getState().setDraftInput(PANEL_ID, "");

      await act(async () => {
        pending.resolve({ action: "replace", correctedText: "Fix it." });
      });

      expect(sent).toEqual([]);
      expect(refusals()).toEqual([
        { asker: "spoken_send", reason: "draft_empty", panelId: PANEL_ID, sessionId: sessionIn() },
      ]);
    });

    it.each([
      ["at once", true, "send_held"],
      ["when its answer comes", "later", "send_held"],
      ["by failing", "reject", "send_failed"],
    ] as const)("says the composer held the send back %s", async (_name, holdSend, reason) => {
      correct.mockResolvedValueOnce({ action: "no_change", correctedText: "" });
      dictate(PANEL_ID, "hello wrld");
      const result = renderComposer({ holdSend });

      await act(async () => {
        result.current.startVoiceWaitSubmit();
      });

      expect(sent).toEqual([]);
      expect(refusals()).toEqual([
        { asker: "enter", reason, panelId: PANEL_ID, sessionId: sessionIn() },
      ]);
    });

    it("names the session the request was made against when the composer answers after a newer dictation began", async () => {
      correct.mockResolvedValueOnce({ action: "no_change", correctedText: "" });
      dictate(PANEL_ID, "hello wrld");
      const answer = deferred<boolean>();
      const result = renderComposer({ holdSend: () => answer.promise });
      await act(async () => {
        result.current.startVoiceWaitSubmit();
      });
      const requested = sessionIn();
      act(() => {
        dictate(PANEL_ID, "and the next prompt");
      });
      expect(sessionIn()).not.toBe(requested);
      expect(refusals()).toEqual([]);

      await act(async () => {
        answer.resolve(false);
      });

      expect(refusals()).toEqual([
        { asker: "enter", reason: "send_held", panelId: PANEL_ID, sessionId: requested },
      ]);
    });

    it("says nothing for an attempt whose wait was cleared from under it", async () => {
      const pending = deferred<CorrectResult>();
      correct.mockReturnValueOnce(pending.promise);
      dictate(PANEL_ID, "hello wrld");
      const result = renderComposer();
      await act(async () => {
        result.current.startVoiceWaitSubmit();
      });

      // As removing the panel does: the flag goes, the attempt is not told.
      act(() => {
        useTerminalInputStore.getState().setVoiceSubmitting(PANEL_ID, false);
      });
      await act(async () => {
        pending.resolve({ action: "replace", correctedText: "Hello world." });
      });

      expect(sent).toEqual([]);
      expect(refusals()).toEqual([]);
    });

    it("says a disabled composer wouldn't send, though the dictation stops", async () => {
      dictate(PANEL_ID, "hello wrld");
      renderComposer({ isDisabled: () => true });
      act(() => {
        useVoiceRecordingStore.getState().setStatus("recording");
      });
      const session = sessionIn();

      await act(async () => {
        await voiceRecordingService.stopAndSend({ asker: "session_panel_send" });
      });

      expect(sent).toEqual([]);
      expect(useVoiceRecordingStore.getState().status).toBe("idle");
      expect(refusals()).toEqual([
        {
          asker: "session_panel_send",
          reason: "composer_disabled",
          panelId: PANEL_ID,
          sessionId: session,
        },
      ]);
    });

    it("says it was a spoken send that a disabled composer wouldn't send", async () => {
      dictate(PANEL_ID, "hello wrld and some more words");
      renderComposer({ isDisabled: () => true });
      act(() => {
        useVoiceRecordingStore.getState().setStatus("recording");
      });

      await act(async () => {
        callbacks.complete!({
          text: "and that is all",
          willCorrect: false,
          itemId: "item-send",
          send: true,
        });
      });

      expect(sent).toEqual([]);
      expect(refusals()).toEqual([
        {
          asker: "spoken_send",
          reason: "composer_disabled",
          panelId: PANEL_ID,
          sessionId: expect.any(String),
        },
      ]);
    });
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

    it("leaves a draft another screen took control of to its driver (#15919)", async () => {
      const PROJECT = "project-1";
      const projectDraft = () => useTerminalInputStore.getState().getDraftInput(PANEL_ID, PROJECT);
      const dictateInProject = (text: string) => {
        useVoiceRecordingStore.getState().beginSession({ panelId: PANEL_ID, projectId: PROJECT });
        const itemId = `item-${++itemSeq}`;
        callbacks.delta!({ text, itemId });
        callbacks.complete!({ text, willCorrect: false, itemId });
      };
      dictateInProject("hello wrld");
      const sessions = voiceRecordingService.sendSessions(PANEL_ID, PROJECT);
      dictateInProject("these are the next prompt");
      const send = planVoiceDraftSend(
        { panelId: PANEL_ID, projectId: PROJECT },
        projectDraft(),
        useDictationRangeStore.getState().listDictations(PANEL_ID, PROJECT),
        sessions
      );
      expect(send.text).toBe("hello wrld");
      const before = projectDraft();

      const { setLeaseInputBlock } = await import("@/services/terminal/inputGate");
      onTestFinished(() => setLeaseInputBlock(null));
      setLeaseInputBlock({ kind: "driven-elsewhere", driverName: "Studio Mac" });

      expect(voiceRecordingService.keepHeldBackDictation(send)).toBeNull();
      expect(projectDraft()).toBe(before);
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
