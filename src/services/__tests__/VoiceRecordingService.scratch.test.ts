import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drives the real voice, draft and dictation-range stores through the IPC
// callbacks to check what a spoken "scratch that" removes (#14636).

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

type DeltaPayload = { sessionId: string; text: string; itemId?: string };
type CompletePayload = {
  sessionId: string;
  text: string;
  willCorrect: boolean;
  itemId?: string;
  transcriptId?: string;
  send?: boolean;
};
type FileTokenPayload = {
  sessionId: string;
  transcriptId: string;
  references: Array<{ description: string; path: string | null }>;
};
type BoundaryPayload = { sessionId: string; rawText: string | null };

const SESSION_ID = "session-1";

const callbacks: {
  delta: ((payload: DeltaPayload) => void) | null;
  complete: ((payload: CompletePayload) => void) | null;
  boundary: ((payload: BoundaryPayload) => void) | null;
  fileToken: ((payload: FileTokenPayload) => void) | null;
} = { delta: null, complete: null, boundary: null, fileToken: null };

type CorrectRequest = { rawText: string; recentContext?: string[] };

const correct = {
  fn: vi.fn<(request: CorrectRequest) => Promise<unknown>>(),
};

function stubElectron() {
  const electron = {
    voiceInput: {
      onTranscriptionDelta: vi.fn((cb: (payload: DeltaPayload) => void) => {
        callbacks.delta = cb;
        return () => {};
      }),
      onTranscriptionComplete: vi.fn((cb: (payload: CompletePayload) => void) => {
        callbacks.complete = cb;
        return () => {};
      }),
      onParagraphBoundary: vi.fn((cb: (payload: BoundaryPayload) => void) => {
        callbacks.boundary = cb;
        return () => {};
      }),
      onCorrectionProgress: vi.fn(() => () => {}),
      onFileTokenResolved: vi.fn((cb: (payload: FileTokenPayload) => void) => {
        callbacks.fileToken = cb;
        return () => {};
      }),
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
      getSettings: vi.fn().mockResolvedValue({ enabled: false }),
      stop: vi.fn().mockResolvedValue(undefined),
      correct: correct.fn,
    },
    systemSleep: {
      onSuspend: vi.fn(() => () => {}),
      onWake: vi.fn(() => () => {}),
    },
  };
  vi.stubGlobal("window", {
    electron,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    requestAnimationFrame: vi.fn(),
    cancelAnimationFrame: vi.fn(),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

const PANEL = "panel-1";
const PROJECT = "project-1";

async function setup(initialDraft = "") {
  stubElectron();
  const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
  const { useTerminalInputStore } = await import("@/store/terminalInputStore");
  const { useDictationRangeStore, subscribeDictationRangeTracking } =
    await import("@/store/dictationRangeStore");
  const { voiceRecordingService } = await import("../VoiceRecordingService");

  unsubscribe = subscribeDictationRangeTracking();
  voiceRecordingService.initialize();
  const inputs = useTerminalInputStore.getState();
  if (initialDraft) inputs.setDraftInput(PANEL, initialDraft, PROJECT);

  const begin = (sessionId?: string) =>
    useVoiceRecordingStore
      .getState()
      .beginSession({ panelId: PANEL, projectId: PROJECT }, sessionId);
  begin(SESSION_ID);

  const draft = () => useTerminalInputStore.getState().getDraftInput(PANEL, PROJECT);
  const setDraft = (value: string) =>
    useTerminalInputStore.getState().setDraftInput(PANEL, value, PROJECT);
  const records = () => useDictationRangeStore.getState().listDictations(PANEL, PROJECT);
  const textOf = (range: { from: number; to: number }) => draft().slice(range.from, range.to);
  const sessionId = () =>
    useVoiceRecordingStore.getState().panelBuffers[PANEL]?.dictationSessionId ?? null;
  const getDictation = (id: string) => useDictationRangeStore.getState().getDictation(id);
  return {
    service: voiceRecordingService,
    voiceStore: useVoiceRecordingStore,
    begin,
    draft,
    setDraft,
    records,
    textOf,
    sessionId,
    getDictation,
  };
}

let unsubscribe: (() => void) | null = null;

const complete = (text: string, itemId?: string, transcriptId?: string) =>
  callbacks.complete!({ sessionId: SESSION_ID, text, willCorrect: false, itemId, transcriptId });

beforeEach(() => {
  vi.resetModules();
  callbacks.delta = null;
  callbacks.complete = null;
  callbacks.boundary = null;
  callbacks.fileToken = null;
  correct.fn.mockReset();
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  vi.unstubAllGlobals();
});

describe("VoiceRecordingService — scratch that (#14636)", () => {
  it.each(["Scratch that.", "delete that", "Scratch that!", " Delete that. "])(
    "removes the latest utterance on %j and inserts nothing",
    async (phrase) => {
      const { draft, records, voiceStore } = await setup("Existing.");

      complete("One.", "a");
      complete("Two.", "b");
      complete(phrase, "c");

      expect(draft()).toBe("Existing. One.");
      expect(records()[0]!.utterances).toHaveLength(1);
      // The transcript recent dictations keep follows the draft (#14637).
      expect(voiceStore.getState().panelBuffers[PANEL]?.completedSegments).toEqual(["One."]);
    }
  );

  it("scratches without sending when the command ends in a spoken send", async () => {
    const { service, voiceStore, draft } = await setup("Existing.");
    voiceStore.getState().setStatus("recording");
    const send = vi.fn();
    service.onSpokenSend(PANEL, PROJECT, send);
    const stop = vi.spyOn(service, "stop").mockResolvedValue(undefined);

    complete("Fix the login bug.", "a");
    complete("Wrong words.", "b");
    // "Scratch that, send it." reaches the renderer with main's send flag and
    // the phrase stripped.
    callbacks.complete!({
      sessionId: SESSION_ID,
      text: "Scratch that",
      willCorrect: false,
      itemId: "c",
      send: true,
    });

    expect(draft()).toBe("Existing. Fix the login bug.");
    expect(send).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(voiceStore.getState().status).toBe("recording");
  });

  it("removes one more utterance each time, never into earlier text", async () => {
    const { draft, records } = await setup("Existing.");

    complete("One.", "a");
    complete("Two.", "b");
    complete("Scratch that.", "c");
    complete("Scratch that.", "d");
    expect(draft()).toBe("Existing.");
    complete("Scratch that.", "e");
    complete("Delete that", "f");
    expect(draft()).toBe("Existing.");
    expect(records()[0]!.utterances).toEqual([]);
  });

  it("dictates normally after everything was scratched", async () => {
    const { draft } = await setup("Existing.");

    complete("One.", "a");
    complete("Scratch that.", "b");
    complete("Fresh.", "c");

    expect(draft()).toBe("Existing. Fresh.");
  });

  it("leaves a phrase inside a longer sentence literal", async () => {
    const { draft } = await setup();

    complete("One.", "a");
    complete("I should scratch that idea.", "b");

    expect(draft()).toBe("One. I should scratch that idea.");
  });

  it("does nothing when the session dictated nothing", async () => {
    const { draft } = await setup("Typed before.");

    complete("Scratch that.", "a");

    expect(draft()).toBe("Typed before.");
  });

  it("keeps text typed after the utterance", async () => {
    const { draft, setDraft } = await setup();

    complete("One.", "a");
    complete("Two.", "b");
    setDraft(draft() + " typed");
    complete("Scratch that.", "c");

    expect(draft()).toBe("One. typed");
  });

  it("does not remove an utterance the user edited", async () => {
    const { draft, setDraft } = await setup();

    complete("One.", "a");
    complete("Two.", "b");
    setDraft("One. Tw0.");
    complete("Scratch that.", "c");

    expect(draft()).toBe("One. Tw0.");
  });

  describe("an utterance with a resolved file reference (#14806)", () => {
    const resolve = () =>
      callbacks.fileToken!({
        sessionId: SESSION_ID,
        transcriptId: "t1",
        references: [{ description: "router", path: "src/router.ts" }],
      });

    it("is removed whole, with the reference", async () => {
      const { draft, records } = await setup("Existing.");

      complete("One.", "a");
      complete("Link to the router.", "b", "t1");
      resolve();
      expect(draft()).toBe("Existing. One. @src/router.ts.");
      complete("Scratch that.", "c");

      expect(draft()).toBe("Existing. One.");
      expect(records()[0]!.utterances).toHaveLength(1);
    });

    it("is not removed once the reference was edited", async () => {
      const { draft, setDraft, records } = await setup();

      complete("One.", "a");
      complete("Link to the router.", "b", "t1");
      resolve();
      expect(records()[0]!.utterances.map((u) => u.range.edited)).toEqual([false, false]);
      setDraft(draft().replace("router.ts", "routers.ts"));
      complete("Scratch that.", "c");

      expect(draft()).toBe("One. @src/routers.ts.");
    });
  });

  it("never takes a newline the user typed between utterances", async () => {
    const { draft, setDraft } = await setup();

    complete("One.", "a");
    setDraft(draft() + "\n");
    complete("Two.", "b");
    complete("Scratch that.", "c");
    expect(draft()).toBe("One.\n");
    complete("Scratch that.", "d");

    expect(draft()).toBe("\n");
  });

  it("removes the utterance on a completion with no item id, keeping none of its words", async () => {
    const { draft, voiceStore } = await setup("Existing.");

    complete("One.");
    callbacks.delta!({ sessionId: SESSION_ID, text: "Scratch that" });
    complete("Scratch that.");

    expect(draft()).toBe("Existing.");
    const buffer = voiceStore.getState().panelBuffers[PANEL];
    // Neither the command nor the words it scratched stay in the transcript.
    expect(buffer?.completedSegments).toEqual([]);
    expect(buffer?.liveText).toBe("");
  });

  it("marks the draft it left for the composer, so emptying it stays undoable", async () => {
    const { draft } = await setup();
    const { takeScratchLanded } = await import("@/services/voiceScratchCommand");

    complete("One.", "a");
    complete("Scratch that.", "b");

    expect(draft()).toBe("");
    expect(takeScratchLanded(PANEL, PROJECT, "")).toBe(true);
    expect(takeScratchLanded(PANEL, PROJECT, "")).toBe(false);
  });

  it("takes the paragraph break the utterance ended with", async () => {
    const { draft } = await setup();

    complete("One.", "a");
    complete("Two.", "b");
    callbacks.boundary!({ sessionId: SESSION_ID, rawText: null });
    complete("Scratch that.", "c");

    expect(draft()).toBe("One.");
  });
});

describe("VoiceRecordingService — a scratch that removes nothing says why (#14973)", () => {
  it("says an edited passage was kept", async () => {
    const { draft, setDraft, voiceStore } = await setup();

    complete("One.", "a");
    complete("Two.", "b");
    setDraft("One. Tw0.");
    complete("Scratch that.", "c");

    expect(draft()).toBe("One. Tw0.");
    expect(voiceStore.getState().announcement?.text).toMatch(/edited by hand/);
    expect(voiceStore.getState().scratchRefusal).toMatchObject({
      panelId: PANEL,
      reason: "edited",
    });
  });

  it("says there was nothing left once the session's words are all gone", async () => {
    const { draft, voiceStore } = await setup("Typed before.");

    complete("One.", "a");
    complete("Scratch that.", "b");
    expect(voiceStore.getState().scratchRefusal).toBeNull();
    complete("Scratch that.", "c");

    expect(draft()).toBe("Typed before.");
    expect(voiceStore.getState().announcement?.text).toMatch(/nothing/i);
    expect(voiceStore.getState().scratchRefusal).toMatchObject({
      panelId: PANEL,
      reason: "nothing",
    });
  });

  it("says nothing for a scratch that removed words, and drops an earlier refusal", async () => {
    const { voiceStore } = await setup();

    complete("Scratch that.", "a");
    expect(voiceStore.getState().scratchRefusal).not.toBeNull();
    voiceStore.getState().clearAnnouncement();
    complete("One.", "b");
    complete("Scratch that.", "c");

    expect(voiceStore.getState().scratchRefusal).toBeNull();
    expect(voiceStore.getState().announcement).toBeNull();
  });

  it("keeps the note through the replacement words, then lets it go", async () => {
    const { draft, setDraft, voiceStore } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      complete("One.", "a");
      setDraft("0ne.");
      complete("Scratch that.", "b");
      complete("Two.", "c");
      vi.advanceTimersByTime(5_000);

      expect(draft()).toBe("0ne. Two.");
      expect(voiceStore.getState().scratchRefusal?.reason).toBe("edited");

      complete("Scratch that.", "d");
      expect(draft()).toBe("0ne.");
      expect(voiceStore.getState().scratchRefusal).toBeNull();

      // A second refusal starts the time again.
      complete("Scratch that.", "e");
      vi.advanceTimersByTime(5_000);
      complete("Scratch that.", "f");
      vi.advanceTimersByTime(5_000);
      expect(voiceStore.getState().scratchRefusal?.reason).toBe("edited");
      vi.advanceTimersByTime(1_000);
      expect(voiceStore.getState().scratchRefusal).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the note when the next session begins, or its panel's buffer is cleared", async () => {
    const { begin, voiceStore } = await setup();

    complete("Scratch that.", "a");
    begin("session-2");
    expect(voiceStore.getState().scratchRefusal).toBeNull();

    begin(SESSION_ID);
    complete("Scratch that.", "b");
    voiceStore.getState().clearPanelBuffer("other-panel");
    expect(voiceStore.getState().scratchRefusal).not.toBeNull();
    voiceStore.getState().clearPanelBuffer(PANEL);
    expect(voiceStore.getState().scratchRefusal).toBeNull();
  });

  it("says a refusal the stop's drain brought with the stop, which would cut it off", async () => {
    const { service, voiceStore } = await setup();
    Reflect.set(service, "sessionId", SESSION_ID);
    const ipcStop = window.electron.voiceInput.stop as unknown as ReturnType<typeof vi.fn>;
    ipcStop.mockImplementationOnce(async () => {
      complete("Scratch that.", "a");
    });

    await service.stop("Dictation stopped.");

    expect(voiceStore.getState().announcement?.text).toMatch(/^Dictation stopped\. .*nothing/i);
    // The note outlives the session it was heard in.
    expect(voiceStore.getState().scratchRefusal?.reason).toBe("nothing");
  });

  it("leaves an open Canopy reply's refusal to its own composer", async () => {
    const { voiceStore } = await setup();
    const { useCanopyStore } = await import("@/store/canopyStore");
    useCanopyStore.setState({ isOpen: true });
    voiceStore
      .getState()
      .beginSession({ panelId: PANEL, projectId: PROJECT, surface: "canopy-reply" }, SESSION_ID);

    complete("Scratch that.", "a");

    expect(voiceStore.getState().scratchRefusal?.reason).toBe("nothing");
    expect(voiceStore.getState().announcement).toBeNull();
  });
});

describe("VoiceRecordingService — scratch that at the caret (#14634)", () => {
  const draftKey = `${PROJECT}:${PANEL}`;

  /** What the composer showed when dictation began: its draft and caret. */
  async function showComposer(doc: string, anchor: number) {
    const { EditorState } = await import("@codemirror/state");
    const { recordComposerState } = await import("@/lib/composerCaret");
    recordComposerState(draftKey, {}, EditorState.create({ doc, selection: { anchor } }));
  }
  const takeCaret = async (draft: string) =>
    (await import("@/lib/composerCaret")).takePendingComposerSelection(draftKey, draft);

  it("removes only the utterance dictated mid-draft, with the text on both sides intact", async () => {
    const { draft, records, textOf } = await setup("Fix the bug. Then test.");
    await showComposer("Fix the bug. Then test.", 12);

    complete("Hello.", "a");
    complete("Again.", "b");
    expect(draft()).toBe("Fix the bug. Hello. Again. Then test.");

    complete("Scratch that.", "c");
    expect(draft()).toBe("Fix the bug. Hello. Then test.");
    const [record] = records();
    expect(record!.utterances.map((u) => textOf(u.range))).toEqual(["Hello."]);
    // Learning diffs only the words still there.
    expect(textOf(record!.learningSpan!)).toBe("Hello.");

    complete("Scratch that.", "d");
    complete("Scratch that.", "e");
    expect(draft()).toBe("Fix the bug. Then test.");
  });

  it("takes the space the words were given ahead of the text after them", async () => {
    const { draft } = await setup("Intro. Outro.");
    await showComposer("Intro. Outro.", 7);

    complete("One.", "a");
    expect(draft()).toBe("Intro. One. Outro.");
    complete("Scratch that.", "b");

    expect(draft()).toBe("Intro. Outro.");
  });

  it("never takes text typed against the words, or the space before it", async () => {
    const { draft, setDraft } = await setup("Intro. Outro.");
    await showComposer("Intro. Outro.", 7);

    complete("One.", "a");
    setDraft("Intro. One.X Outro.");
    complete("Scratch that.", "b");

    expect(draft()).toBe("Intro. X Outro.");
  });

  it("dictates at the scratched spot afterwards", async () => {
    const { draft } = await setup("Intro. Outro.");
    await showComposer("Intro. Outro.", 7);

    complete("One.", "a");
    complete("Scratch that.", "b");
    complete("Two.", "c");

    expect(draft()).toBe("Intro. Two. Outro.");
  });

  it("puts a caret that followed the words where they were, and leaves any other alone", async () => {
    const { draft } = await setup("Intro. Outro.");
    await showComposer("Intro. Outro.", 7);

    complete("One.", "a");
    complete("Scratch that.", "b");
    expect(await takeCaret(draft())).toEqual({ from: 7, to: 7 });

    complete("Two.", "c");
    await takeCaret(draft());
    await showComposer(draft(), 0);
    complete("Scratch that.", "d");
    expect(await takeCaret(draft())).toBeNull();
  });

  it("marks the draft it left for the composer without moving the caret to the end", async () => {
    const { draft } = await setup("Intro. Outro.");
    const { useTerminalInputStore } = await import("@/store/terminalInputStore");
    const { takeScratchLanded } = await import("@/services/voiceScratchCommand");
    await showComposer("Intro. Outro.", 7);
    complete("One.", "a");
    const caretMoving = useTerminalInputStore.getState().caretMovingDraftRevision;

    complete("Scratch that.", "b");

    expect(takeScratchLanded(PANEL, PROJECT, draft())).toBe(true);
    expect(useTerminalInputStore.getState().caretMovingDraftRevision).toBe(caretMoving);
  });
});
