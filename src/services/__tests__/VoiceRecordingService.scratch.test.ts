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
      expect(voiceStore.getState().panelBuffers[PANEL]?.completedSegments).toEqual([
        "One.",
        "Two.",
      ]);
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
    expect(buffer?.completedSegments).toEqual(["One."]);
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
