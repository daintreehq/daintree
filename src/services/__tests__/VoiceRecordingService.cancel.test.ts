import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Escape cancels a dictation (#14631): the text it added comes out of the
// draft, everything else stays, and nothing the session still had in flight
// lands afterwards. Drives the real voice, draft and dictation-range stores.

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
};
type FileTokenPayload = {
  sessionId: string;
  transcriptId: string;
  references: Array<{ description: string; path: string | null }>;
};
type BoundaryPayload = { sessionId: string; rawText: string | null };
type StatusPayload = { sessionId: string; status: string };
type EndedPayload = { sessionId: string; reason: string };
type ErrorPayload = {
  sessionId: string;
  error: { severity: "transient" | "fatal"; code: string; message: string };
};

const SESSION_ID = "session-1";

const callbacks: {
  delta: ((payload: DeltaPayload) => void) | null;
  complete: ((payload: CompletePayload) => void) | null;
  boundary: ((payload: BoundaryPayload) => void) | null;
  fileToken: ((payload: FileTokenPayload) => void) | null;
  status: ((payload: StatusPayload) => void) | null;
  error: ((payload: ErrorPayload) => void) | null;
  ended: ((payload: EndedPayload) => void) | null;
} = {
  delta: null,
  complete: null,
  boundary: null,
  fileToken: null,
  status: null,
  error: null,
  ended: null,
};

const ipc = {
  correct: vi.fn<(request: { rawText: string }) => Promise<unknown>>(),
  stop: vi.fn<(sessionId: string) => Promise<unknown>>(),
  cancel: vi.fn<(sessionId: string) => Promise<unknown>>(),
  playUiEvent: vi.fn<(id: string) => Promise<unknown>>(),
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
      onError: vi.fn((cb: (payload: ErrorPayload) => void) => {
        callbacks.error = cb;
        return () => {};
      }),
      onStatus: vi.fn((cb: (payload: StatusPayload) => void) => {
        callbacks.status = cb;
        return () => {};
      }),
      onSessionEnded: vi.fn((cb: (payload: EndedPayload) => void) => {
        callbacks.ended = cb;
        return () => {};
      }),
      onLiveSession: vi.fn(() => () => {}),
      onStopRequested: vi.fn(() => () => {}),
      onRevealRequested: vi.fn(() => () => {}),
      getLiveSession: vi.fn().mockResolvedValue({ revision: 0, session: null }),
      getSettings: vi.fn().mockResolvedValue({ enabled: false }),
      stop: ipc.stop,
      cancel: ipc.cancel,
      correct: ipc.correct,
    },
    systemSleep: {
      onSuspend: vi.fn(() => () => {}),
      onWake: vi.fn(() => () => {}),
    },
    notification: { playUiEvent: ipc.playUiEvent },
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

let unsubscribe: (() => void) | null = null;

async function setup(initialDraft = "") {
  stubElectron();
  const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
  const { useTerminalInputStore } = await import("@/store/terminalInputStore");
  const { useDictationRangeStore, subscribeDictationRangeTracking } =
    await import("@/store/dictationRangeStore");
  const { voiceRecordingService } = await import("../VoiceRecordingService");

  unsubscribe = subscribeDictationRangeTracking();
  voiceRecordingService.initialize();
  if (initialDraft) {
    useTerminalInputStore.getState().setDraftInput(PANEL, initialDraft, PROJECT);
  }

  // Stands in for start(): main knows the session by this id, and every event
  // it sends carries it.
  const begin = (sessionId = SESSION_ID) => {
    useVoiceRecordingStore
      .getState()
      .beginSession({ panelId: PANEL, projectId: PROJECT }, sessionId);
    useVoiceRecordingStore.getState().setStatus("recording");
    Reflect.set(voiceRecordingService, "sessionId", sessionId);
  };
  begin();

  const draft = () => useTerminalInputStore.getState().getDraftInput(PANEL, PROJECT);
  const setDraft = (value: string) =>
    useTerminalInputStore.getState().setDraftInput(PANEL, value, PROJECT);
  const records = () => useDictationRangeStore.getState().listDictations(PANEL, PROJECT);
  const announcement = () => useVoiceRecordingStore.getState().announcement?.text ?? null;
  // Idle, and the capture teardown a following start would wait on is done.
  const settled = () =>
    vi.waitFor(() => {
      expect(useVoiceRecordingStore.getState().status).toBe("idle");
      expect(Reflect.get(voiceRecordingService, "stopPromise")).toBeNull();
    });
  return {
    service: voiceRecordingService,
    voiceStore: useVoiceRecordingStore,
    begin,
    draft,
    setDraft,
    records,
    announcement,
    settled,
  };
}

const delta = (text: string, itemId?: string, sessionId = SESSION_ID) =>
  callbacks.delta!({ sessionId, text, itemId });
const complete = (text: string, itemId?: string, sessionId = SESSION_ID, transcriptId?: string) =>
  callbacks.complete!({ sessionId, text, willCorrect: false, itemId, transcriptId });
const boundary = (sessionId = SESSION_ID) => callbacks.boundary!({ sessionId, rawText: null });

describe("VoiceRecordingService — Escape cancels a dictation (#14631)", () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(callbacks, {
      delta: null,
      complete: null,
      boundary: null,
      fileToken: null,
      status: null,
      error: null,
      ended: null,
    });
    ipc.correct.mockReset();
    ipc.stop.mockReset().mockResolvedValue({ rawText: null });
    ipc.cancel.mockReset().mockResolvedValue(undefined);
    ipc.playUiEvent.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    vi.unstubAllGlobals();
  });

  it("removes the text the dictation added and leaves the draft as it was", async () => {
    const { service, draft, records, announcement, settled } = await setup("Existing.");

    delta("hel", "item-a");
    complete("Hello.", "item-a");
    complete("Again.", "item-b");
    expect(draft()).toBe("Existing. Hello. Again.");

    expect(service.handleEscape(PANEL)).toBe(true);
    await settled();

    expect(draft()).toBe("Existing.");
    expect(records()).toEqual([]);
    expect(announcement()).toMatch(/cancelled/i);
    expect(announcement()).toMatch(/discarded/i);
  });

  it("still cancels after a spoken scratch took an utterance and its paragraph break", async () => {
    const { service, draft, settled } = await setup("Keep");

    complete("First.", "item-a");
    boundary();
    complete("Second.", "item-b");
    boundary();
    complete("Scratch that.", "item-c");
    expect(draft()).toBe("Keep First.\n");

    expect(service.handleEscape(PANEL)).toBe(true);
    await settled();

    expect(draft()).toBe("Keep");
    expect(ipc.cancel).toHaveBeenCalledWith(SESSION_ID);
  });

  it("marks the draft it left for the composer, so emptying it stays undoable", async () => {
    const { service, draft, settled } = await setup();
    const { takeScratchLanded } = await import("@/services/voiceScratchCommand");

    complete("Hello.", "item-a");
    service.handleEscape(PANEL);
    await settled();

    expect(draft()).toBe("");
    expect(takeScratchLanded(PANEL, PROJECT, "")).toBe(true);
  });

  it("ends the session without draining it", async () => {
    const { service, settled } = await setup();

    complete("Hello.", "item-a");
    service.handleEscape(PANEL);
    await settled();

    expect(ipc.cancel).toHaveBeenCalledWith(SESSION_ID);
    expect(ipc.stop).not.toHaveBeenCalled();
  });

  it("removes paragraph breaks the dictation inserted", async () => {
    const { service, draft, settled } = await setup("Keep");

    complete("One.", "item-a");
    boundary();
    complete("Two.", "item-a");
    expect(draft()).toBe("Keep One.\nTwo.");

    service.handleEscape(PANEL);
    await settled();

    expect(draft()).toBe("Keep");
  });

  it("removes a break spoken before any words and every break after it", async () => {
    const { service, draft, settled } = await setup("  ");

    boundary();
    complete("One.", "item-a");
    boundary();
    boundary();
    complete("Two.", "item-b");
    expect(draft()).toBe("  \nOne.\n\nTwo.");

    service.handleEscape(PANEL);
    await settled();

    expect(draft()).toBe("  ");
  });

  it("removes only what was dictated since the draft was last sent", async () => {
    const { service, draft, setDraft, settled } = await setup();

    complete("Sent.", "item-a");
    setDraft("");
    setDraft("Typed");
    complete("More.", "item-b");
    expect(draft()).toBe("Typed More.");

    service.handleEscape(PANEL);
    await settled();

    expect(draft()).toBe("Typed");
  });

  it("keeps text typed before and after the dictation", async () => {
    const { service, draft, setDraft, settled } = await setup("Start");

    complete("Hello.", "item-a");
    setDraft("Typed first. " + draft());
    setDraft(draft() + " typed after");

    service.handleEscape(PANEL);
    await settled();

    expect(draft()).toBe("Typed first. Start typed after");
  });

  it("keeps text typed between two utterances of the dictation", async () => {
    const { service, draft, setDraft, settled } = await setup("Start");

    complete("One.", "item-a");
    setDraft(draft() + " typed");
    complete("Two.", "item-b");
    expect(draft()).toBe("Start One. typed Two.");

    service.handleEscape(PANEL);
    await settled();

    expect(draft()).toBe("Start typed");
  });

  it("discards speech that was still a preview", async () => {
    const { service, voiceStore, draft, settled } = await setup("Keep");

    complete("Done.", "item-a");
    delta("half a thou", "item-b");
    expect(voiceStore.getState().panelBuffers[PANEL]?.liveText).toBe("half a thou");

    service.handleEscape(PANEL);
    await settled();

    expect(draft()).toBe("Keep");
    const buffer = voiceStore.getState().panelBuffers[PANEL];
    expect(buffer?.liveText).toBe("");
    expect(buffer?.completedSegments).not.toContain("half a thou");
  });

  it("stops and keeps the text when the dictated words were edited", async () => {
    const { service, draft, setDraft, announcement, settled } = await setup();

    complete("Hello world.", "item-a");
    setDraft(draft().replace("world", "there"));

    service.handleEscape(PANEL);
    await settled();

    expect(draft()).toBe("Hello there.");
    expect(ipc.cancel).not.toHaveBeenCalled();
    expect(ipc.stop).toHaveBeenCalledWith(SESSION_ID);
    expect(announcement()).not.toMatch(/discarded/i);
    expect(announcement()).toMatch(/kept/i);
  });

  it("runs no correction for a cancelled dictation", async () => {
    const { service, voiceStore, draft, setDraft, settled } = await setup("Intro.");
    voiceStore.getState().setCorrectionEnabled(true);

    complete("Hello there.", "item-a");
    // Left where the dictation began, so a correction pass would have text to take.
    setDraft(draft() + " and some typed words");
    service.handleEscape(PANEL);
    await settled();

    expect(draft()).toBe("Intro. and some typed words");
    expect(ipc.correct).not.toHaveBeenCalled();
    expect(voiceStore.getState().panelBuffers[PANEL]?.correctionRanges).toEqual([]);
  });

  it("drops events the cancelled session still had in flight, even once a new session starts", async () => {
    const { service, voiceStore, begin, draft, settled } = await setup("Keep");

    complete("Link to the router.", "item-a", SESSION_ID, "t1");
    service.handleEscape(PANEL);
    await settled();
    begin("session-2");

    delta("late preview", "item-b");
    complete("Late.", "item-b");
    boundary();
    callbacks.fileToken!({
      sessionId: SESSION_ID,
      transcriptId: "t1",
      references: [{ description: "router", path: "src/router.ts" }],
    });
    callbacks.error!({
      sessionId: SESSION_ID,
      error: { severity: "transient", code: "rate_limit", message: "slow down" },
    });
    callbacks.status!({ sessionId: SESSION_ID, status: "idle" });
    expect(draft()).toBe("Keep");
    expect(voiceStore.getState().panelBuffers[PANEL]?.liveText).toBe("");
    expect(voiceStore.getState().lastError).toBeNull();
    expect(voiceStore.getState().status).toBe("recording");

    delta("fresh", "item-c", "session-2");
    expect(voiceStore.getState().panelBuffers[PANEL]?.liveText).toBe("fresh");
    complete("Fresh.", "item-c", "session-2");
    expect(draft()).toBe("Keep Fresh.");
  });

  it("lets a cancelled session go once main reports it ended", async () => {
    const { service, begin, draft, settled } = await setup();

    service.handleEscape(PANEL);
    await settled();
    callbacks.ended!({ sessionId: SESSION_ID, reason: "cancelled" });
    begin(SESSION_ID);
    complete("Heard.", "item-a");

    expect(draft()).toBe("Heard.");
  });

  it("lets go only of the session main reported ended", async () => {
    const { service, begin, draft, settled } = await setup();

    service.handleEscape(PANEL);
    await settled();
    begin("session-2");
    service.handleEscape(PANEL);
    await settled();
    callbacks.ended!({ sessionId: "session-2", reason: "cancelled" });
    const discarded: unknown = Reflect.get(service, "discardedSessionIds");
    expect(discarded).toEqual(new Set([SESSION_ID]));
    begin("session-3");

    complete("Late.", "item-a", SESSION_ID);
    expect(draft()).toBe("");
    complete("Heard.", "item-b", "session-3");
    expect(draft()).toBe("Heard.");
  });

  it("leaves no tombstone for a session main had already ended", async () => {
    const { service, settled } = await setup();

    complete("Hello.", "item-a");
    callbacks.ended!({ sessionId: SESSION_ID, reason: "superseded" });
    service.handleEscape(PANEL);
    await settled();

    const discarded: unknown = Reflect.get(service, "discardedSessionIds");
    expect(discarded).toEqual(new Set());
  });

  it.each([
    ["live", ["dictation-stop"]],
    ["pending", []],
  ] as const)(
    "cues the end of a cancelled dictation only once the mic was %s",
    async (signal, cues) => {
      const { service, voiceStore, settled } = await setup();
      voiceStore.getState().setMicSignal(signal);

      complete("Hello.", "item-a");
      service.handleEscape(PANEL);
      await settled();

      expect(ipc.playUiEvent.mock.calls.map(([id]) => id)).toEqual(cues);
    }
  );

  it("does nothing more for a second Escape once the dictation is cancelled", async () => {
    const { service, settled } = await setup();

    complete("Hello.", "item-a");
    expect(service.handleEscape(PANEL)).toBe(true);
    await settled();

    expect(service.handleEscape(PANEL)).toBe(false);
    expect(ipc.cancel).toHaveBeenCalledOnce();
  });

  it("keeps a dictation whose words a file reference already rewrote", async () => {
    const { service, draft, settled } = await setup();

    complete("Link to the router.", "item-a", SESSION_ID, "t1");
    callbacks.fileToken!({
      sessionId: SESSION_ID,
      transcriptId: "t1",
      references: [{ description: "router", path: "src/router.ts" }],
    });
    expect(draft()).toBe("@src/router.ts.");

    service.handleEscape(PANEL);
    await settled();

    expect(draft()).toBe("@src/router.ts.");
    expect(ipc.cancel).not.toHaveBeenCalled();
  });

  it("lets an earlier passage's correction land after a later dictation is cancelled", async () => {
    const { service, voiceStore, begin, draft, settled } = await setup();
    let resolveCorrection!: (value: unknown) => void;
    ipc.correct.mockReturnValue(new Promise((resolve) => (resolveCorrection = resolve)));
    voiceStore.getState().setCorrectionEnabled(true);

    complete("First passage.", "item-a");
    await service.stop("Dictation stopped.");
    expect(ipc.correct).toHaveBeenCalledWith(
      expect.objectContaining({ rawText: "First passage." })
    );

    begin("session-2");
    complete("Second.", "item-b", "session-2");
    service.handleEscape(PANEL);
    await settled();
    expect(draft()).toBe("First passage.");

    resolveCorrection({ action: "replace", correctedText: "First passage, corrected." });
    await vi.waitFor(() => expect(draft()).toBe("First passage, corrected."));
    expect(ipc.correct).toHaveBeenCalledOnce();
  });
});
