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
  send?: boolean;
  commandText?: string;
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
      onCorrectionProgress: vi.fn(() => () => {}),
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
      onLiveLevel: vi.fn(() => () => {}),
      onPauseRequested: vi.fn(() => () => {}),
      publishDetails: vi.fn().mockResolvedValue(undefined),
      setPausedLive: vi.fn().mockResolvedValue(true),
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

// Escape twice, as a cancel that takes words out needs (#14927): the first
// asks again and must be seen to, the second cancels.
async function escapeToCancel(service: { handleEscape(panelId?: string): boolean }) {
  const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
  expect(service.handleEscape(PANEL)).toBe(true);
  expect(useVoiceRecordingStore.getState().dictationCancelConfirm).not.toBeNull();
  return service.handleEscape(PANEL);
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

    expect(await escapeToCancel(service)).toBe(true);
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

    expect(await escapeToCancel(service)).toBe(true);
    await settled();

    expect(draft()).toBe("Keep");
    expect(ipc.cancel).toHaveBeenCalledWith(SESSION_ID);
  });

  it("removes a spoken command it wrote as one, with the words after it", async () => {
    const { service, draft, records, settled } = await setup();

    callbacks.complete!({
      sessionId: SESSION_ID,
      text: "slash review the last commit",
      commandText: "/review the last commit",
      willCorrect: false,
      itemId: "item-a",
    });
    complete("And the tests.", "item-b");
    expect(draft()).toBe("/review the last commit And the tests.");

    expect(await escapeToCancel(service)).toBe(true);
    await settled();

    expect(draft()).toBe("");
    expect(records()).toEqual([]);
  });

  it("marks the draft it left for the composer, so emptying it stays undoable", async () => {
    const { service, draft, settled } = await setup();
    const { takeScratchLanded } = await import("@/services/voiceScratchCommand");

    complete("Hello.", "item-a");
    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("");
    expect(takeScratchLanded(PANEL, PROJECT, "")).toBe(true);
  });

  it("ends the session without draining it", async () => {
    const { service, settled } = await setup();

    complete("Hello.", "item-a");
    await escapeToCancel(service);
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

    await escapeToCancel(service);
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

    await escapeToCancel(service);
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

    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Typed");
  });

  it("keeps text typed before and after the dictation", async () => {
    const { service, draft, setDraft, settled } = await setup("Start");

    complete("Hello.", "item-a");
    setDraft("Typed first. " + draft());
    setDraft(draft() + " typed after");

    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Typed first. Start typed after");
  });

  it("keeps text typed between two utterances of the dictation", async () => {
    const { service, draft, setDraft, settled } = await setup("Start");

    complete("One.", "item-a");
    setDraft(draft() + " typed");
    complete("Two.", "item-b");
    expect(draft()).toBe("Start One. typed Two.");

    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Start typed");
  });

  it("discards speech that was still a preview", async () => {
    const { service, voiceStore, draft, settled } = await setup("Keep");

    complete("Done.", "item-a");
    delta("half a thou", "item-b");
    expect(voiceStore.getState().panelBuffers[PANEL]?.liveText).toBe("half a thou");

    await escapeToCancel(service);
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

  describe("with a resolved file reference (#14806)", () => {
    const resolve = () =>
      callbacks.fileToken!({
        sessionId: SESSION_ID,
        transcriptId: "t1",
        references: [{ description: "router", path: "src/router.ts" }],
      });

    it("removes the reference with the rest of the dictation", async () => {
      const { service, draft, records, settled } = await setup("Keep");

      complete("Fix the padding.", "item-a");
      complete("Link to the router.", "item-b", SESSION_ID, "t1");
      resolve();
      expect(draft()).toBe("Keep Fix the padding. @src/router.ts.");

      expect(await escapeToCancel(service)).toBe(true);
      await settled();

      expect(draft()).toBe("Keep");
      expect(records()).toEqual([]);
      expect(ipc.cancel).toHaveBeenCalledWith(SESSION_ID);
    });

    it("keeps the dictation once the reference itself was edited", async () => {
      const { service, draft, setDraft, records, announcement, settled } = await setup();

      complete("Link to the router.", "item-a", SESSION_ID, "t1");
      resolve();
      expect(records()[0]!.utterances[0]!.range.edited).toBe(false);
      setDraft(draft().replace("router.ts", "routers.ts"));

      service.handleEscape(PANEL);
      await settled();

      expect(draft()).toBe("@src/routers.ts.");
      expect(ipc.cancel).not.toHaveBeenCalled();
      expect(announcement()).toMatch(/kept/i);
    });
  });

  it("runs no correction for a cancelled dictation", async () => {
    const { service, voiceStore, draft, setDraft, settled } = await setup("Intro.");
    voiceStore.getState().setCorrectionEnabled(true);

    complete("Hello there.", "item-a");
    // Left where the dictation began, so a correction pass would have text to take.
    setDraft(draft() + " and some typed words");
    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Intro. and some typed words");
    expect(ipc.correct).not.toHaveBeenCalled();
    expect(voiceStore.getState().panelBuffers[PANEL]?.correctionRanges).toEqual([]);
  });

  it("drops events the cancelled session still had in flight, even once a new session starts", async () => {
    const { service, voiceStore, begin, draft, settled } = await setup("Keep");

    complete("Link to the router.", "item-a", SESSION_ID, "t1");
    await escapeToCancel(service);
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

  it("drops a spoken send the cancelled session still had in flight, sending nothing", async () => {
    const { service, voiceStore, begin, draft, settled } = await setup("Keep this intro.");
    const spokenSend = vi.fn();
    service.onSpokenSend(PANEL, PROJECT, spokenSend);

    complete("Fix the login bug.", "item-a");
    await escapeToCancel(service);
    await settled();
    // A new dictation into the same composer, which a stray send would submit.
    begin("session-2");
    complete("Fresh words here.", "item-b", "session-2");
    callbacks.complete!({
      sessionId: SESSION_ID,
      text: "",
      willCorrect: false,
      itemId: "item-c",
      send: true,
    });

    expect(spokenSend).not.toHaveBeenCalled();
    expect(voiceStore.getState().status).toBe("recording");
    expect(draft()).toBe("Keep this intro. Fresh words here.");
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
      await escapeToCancel(service);
      await settled();

      expect(ipc.playUiEvent.mock.calls.map(([id]) => id)).toEqual(cues);
    }
  );

  it("does nothing more for a second Escape once the dictation is cancelled", async () => {
    const { service, settled } = await setup();

    complete("Hello.", "item-a");
    expect(await escapeToCancel(service)).toBe(true);
    await settled();

    expect(service.handleEscape(PANEL)).toBe(false);
    expect(ipc.cancel).toHaveBeenCalledOnce();
  });

  it.each(["push-to-talk", "tap-or-hold"])(
    "lets go of a %s press still held when Escape cancels, so its release does nothing",
    async (recordingMode) => {
      const { service, voiceStore, draft, settled } = await setup("Existing.");
      // The settings read initialize() started lands first.
      await service.refreshConfiguration();
      Reflect.set(service, "recordingMode", recordingMode);
      const { keybindingService } = await import("@/services/KeybindingService");
      vi.mocked(keybindingService.getEffectiveCombos).mockImplementation((actionId: string) =>
        actionId === "voiceInput.toggle" ? ["Cmd+D"] : []
      );
      vi.mocked(keybindingService.matchesEvent).mockImplementation(
        (e: KeyboardEvent) => e.code === "KeyD"
      );
      const fire = (type: string, init: object) => {
        const event = Object.assign(new Event(type), init);
        for (const [eventType, listener] of vi.mocked(window.addEventListener).mock.calls) {
          if (eventType !== type) continue;
          if (typeof listener === "function") listener(event);
          else listener.handleEvent(event);
        }
      };

      fire("keydown", { code: "KeyD", key: "d", repeat: false, metaKey: true });
      // The start the press dispatched claims it.
      service["claimHeldPress"]();
      complete("Hello.", "item-a");
      // Held long enough, with speech, that its release would stop a recording.
      const speech = { samples: 1_600, rms: 0.1, peak: 0.3, zeroFraction: 0 };
      service["noteHeldPressAudio"](speech);
      service["noteHeldPressAudio"](speech);
      service["heldPress"]!.pressedAt -= 1_000;

      expect(await escapeToCancel(service)).toBe(true);
      await settled();
      expect(draft()).toBe("Existing.");

      const stop = vi.spyOn(service, "stop");
      const start = vi.spyOn(service, "start");
      fire("keyup", { code: "KeyD" });
      fire("keyup", { code: "MetaLeft" });

      expect(stop).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(ipc.stop).not.toHaveBeenCalled();
      expect(voiceStore.getState().status).toBe("idle");
    }
  );

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
    await escapeToCancel(service);
    await settled();
    expect(draft()).toBe("First passage.");

    resolveCorrection({ action: "replace", correctedText: "First passage, corrected." });
    await vi.waitFor(() => expect(draft()).toBe("First passage, corrected."));
    expect(ipc.correct).toHaveBeenCalledOnce();
  });
});

describe("VoiceRecordingService — Escape cancels a dictation at the caret or over a selection (#14631, #14634, #14805)", () => {
  const draftKey = `${PROJECT}:${PANEL}`;

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

  /** What the composer showed: its draft and caret. */
  async function showComposer(doc: string, anchor: number, head = anchor) {
    const { EditorState } = await import("@codemirror/state");
    const { recordComposerState } = await import("@/lib/composerCaret");
    recordComposerState(draftKey, {}, EditorState.create({ doc, selection: { anchor, head } }));
  }
  const takeCaret = async (draft: string) =>
    (await import("@/lib/composerCaret")).takePendingComposerSelection(draftKey, draft);

  it("takes out only what was dictated mid-draft, with the text on both sides intact", async () => {
    const { service, draft, records, settled } = await setup("Fix the bug. Then test.");
    const { useDictationRangeStore } = await import("@/store/dictationRangeStore");
    await showComposer("Fix the bug. Then test.", 12);

    complete("Hello.", "item-a");
    boundary();
    complete("Again.", "item-b");
    expect(draft()).toBe("Fix the bug. Hello.\nAgain. Then test.");

    expect(await escapeToCancel(service)).toBe(true);
    await settled();

    expect(draft()).toBe("Fix the bug. Then test.");
    expect(records()).toEqual([]);
    expect(
      useDictationRangeStore
        .getState()
        .getAnchor({ sessionId: SESSION_ID, panelId: PANEL, projectId: PROJECT })
    ).toBeNull();
    expect(await takeCaret(draft())).toEqual({ from: 12, to: 12 });
  });

  it("takes the space the words were given ahead of the text after them", async () => {
    const { service, draft, settled } = await setup("Intro. Outro.");
    await showComposer("Intro. Outro.", 7);

    complete("One.", "item-a");
    complete("Two.", "item-b");
    expect(draft()).toBe("Intro. One. Two. Outro.");

    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Intro. Outro.");
    expect(await takeCaret(draft())).toEqual({ from: 7, to: 7 });
  });

  it("keeps a caret in the text after the dictation on that text", async () => {
    const { service, draft, settled } = await setup("Intro. Outro.");
    const { useTerminalInputStore } = await import("@/store/terminalInputStore");
    await showComposer("Intro. Outro.", 7);

    complete("One.", "item-a");
    await takeCaret(draft());
    await showComposer(draft(), 15);
    const caretMoving = useTerminalInputStore.getState().caretMovingDraftRevision;

    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Intro. Outro.");
    expect(await takeCaret(draft())).toEqual({ from: 10, to: 10 });
    expect(useTerminalInputStore.getState().caretMovingDraftRevision).toBe(caretMoving);
  });

  it("keeps text typed on both sides of the dictation and against its words", async () => {
    const { service, draft, setDraft, announcement, settled } = await setup("Intro. Outro.");
    await showComposer("Intro. Outro.", 7);

    complete("One.", "item-a");
    setDraft("Say: Intro. One. Outro.");
    setDraft("Say: Intro. One.X Outro.");
    setDraft("Say: Intro. One.X Outro. Done");

    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Say: Intro. X Outro. Done");
    expect(announcement()).toMatch(/discarded/i);
  });

  it("stops and keeps the text when the words dictated at the caret were edited", async () => {
    const { service, draft, setDraft, announcement, settled } = await setup("Intro. Outro.");
    await showComposer("Intro. Outro.", 7);

    complete("One two.", "item-a");
    setDraft("Intro. One too. Outro.");

    service.handleEscape(PANEL);
    await settled();

    expect(draft()).toBe("Intro. One too. Outro.");
    expect(announcement()).toMatch(/kept/i);
    expect(ipc.cancel).not.toHaveBeenCalled();
  });

  it("leaves an earlier session's text right after it untouched", async () => {
    const { service, begin, draft, records, settled } = await setup("Intro.");

    complete("Outro.", "item-a");
    await service.stop("Dictation stopped.");
    expect(draft()).toBe("Intro. Outro.");

    begin("session-2");
    await showComposer("Intro. Outro.", 6);
    complete("One.", "item-b", "session-2");
    expect(draft()).toBe("Intro. One. Outro.");
    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Intro. Outro.");
    // A diff of the removal would have reached into " Outro." and flagged it.
    const [earlier] = records();
    expect(earlier!.sessionId).toBe(SESSION_ID);
    expect(earlier!.utterances[0]!.insertion).toEqual({ from: 6, to: 13, edited: false });
  });

  it("puts back the text the dictation replaced, selected as it was", async () => {
    const { service, draft, records, announcement, settled } = await setup("Keep old text.");
    await showComposer("Keep old text.", 5, 8);

    complete("new", "item-a");
    expect(draft()).toBe("Keep new text.");

    expect(await escapeToCancel(service)).toBe(true);
    await settled();

    expect(draft()).toBe("Keep old text.");
    expect(records()).toEqual([]);
    expect(await takeCaret(draft())).toEqual({ from: 5, to: 8 });
    expect(announcement()).toMatch(/discarded/i);
  });

  it("puts back a longer selection from further into the draft", async () => {
    const { service, draft, settled } = await setup("Say hello there, friend.");
    await showComposer("Say hello there, friend.", 4, 15);

    complete("hi", "item-a");
    expect(draft()).toBe("Say hi, friend.");

    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Say hello there, friend.");
    expect(await takeCaret(draft())).toEqual({ from: 4, to: 15 });
  });

  it("cancels on one press when the utterances together were the text selected", async () => {
    const { service, voiceStore, draft, records, settled } = await setup("Keep old text.");
    await showComposer("Keep old text.", 5, 13);

    // The second utterance changes the text on its own; with the first put
    // back over it, the draft ends as it is, so nothing is lost.
    complete("old", "item-a");
    complete("text", "item-b");
    expect(draft()).toBe("Keep old text.");

    expect(service.handleEscape(PANEL)).toBe(true);
    expect(voiceStore.getState().dictationCancelConfirm).toBeNull();
    await settled();

    expect(draft()).toBe("Keep old text.");
    expect(records()).toEqual([]);
    expect(ipc.cancel).toHaveBeenCalledWith(SESSION_ID);
  });

  it("selects the text again when the dictated word was the one selected", async () => {
    const { useTerminalInputStore } = await import("@/store/terminalInputStore");
    const { takeScratchLanded } = await import("@/services/voiceScratchCommand");
    const { service, draft, records, settled } = await setup("Keep old text.");
    await showComposer("Keep old text.", 5, 8);

    complete("old", "item-a");
    // Nothing changed, so the composer is only told where the selection goes.
    expect(draft()).toBe("Keep old text.");
    const revision = useTerminalInputStore.getState().externalDraftRevision;

    // Cancelling loses no words, so one press does it.
    service.handleEscape(PANEL);
    await settled();

    expect(draft()).toBe("Keep old text.");
    expect(records()).toEqual([]);
    expect(useTerminalInputStore.getState().externalDraftRevision).toBeGreaterThan(revision);
    expect(await takeCaret(draft())).toEqual({ from: 5, to: 8 });
    // The draft did not change, so the composer has no edit to undo.
    expect(takeScratchLanded(PANEL, PROJECT, draft())).toBe(false);
  });

  it("restores the selection a later session replaced and leaves the earlier session alone", async () => {
    const { service, begin, draft, records, settled } = await setup("Keep old text.");

    complete("Done.", "item-a");
    await service.stop("Dictation stopped.");
    expect(draft()).toBe("Keep old text. Done.");

    // The composer keeps publishing its selection after it loses focus, and
    // the next dictation replaces what it holds.
    await showComposer(draft(), 5, 8);
    begin("session-2");
    complete("new", "item-b", "session-2");
    expect(draft()).toBe("Keep new text. Done.");

    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Keep old text. Done.");
    expect(await takeCaret(draft())).toEqual({ from: 5, to: 8 });
    expect(records().map((record) => record.sessionId)).toEqual([SESSION_ID]);
  });

  it("puts the selection back under a spoken break and later utterances", async () => {
    const { service, draft, records, settled } = await setup("Keep old text.");
    await showComposer("Keep old text.", 5, 8);

    boundary();
    complete("one", "item-a");
    complete("two", "item-b");
    expect(draft()).toBe("Keep \none two text.");

    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Keep old text.");
    expect(records()).toEqual([]);
    expect(await takeCaret(draft())).toEqual({ from: 5, to: 8 });
  });

  it("puts the selection back under a spoken break when the words were the selected ones", async () => {
    const { service, draft, settled } = await setup("Keep old text.");
    await showComposer("Keep old text.", 5, 8);

    boundary();
    complete("old", "item-a");
    expect(draft()).toBe("Keep \nold text.");

    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Keep old text.");
    expect(await takeCaret(draft())).toEqual({ from: 5, to: 8 });
  });

  it("puts back a replaced selection that had a space put after the words", async () => {
    const { service, draft, settled } = await setup("Keep oldtext.");
    await showComposer("Keep oldtext.", 5, 8);

    complete("new", "item-a");
    expect(draft()).toBe("Keep new text.");

    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Keep oldtext.");
    expect(await takeCaret(draft())).toEqual({ from: 5, to: 8 });
  });

  it("leaves a caret the user moved elsewhere on its text", async () => {
    const { service, draft, settled } = await setup("Keep old text.");
    await showComposer("Keep old text.", 5, 8);

    complete("brand new", "item-a");
    expect(draft()).toBe("Keep brand new text.");
    await takeCaret(draft());
    await showComposer(draft(), 18);

    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Keep old text.");
    expect(await takeCaret(draft())).toEqual({ from: 12, to: 12 });
  });

  it("keeps the words and not the selection when the dictated words were edited", async () => {
    const { service, draft, records, setDraft, announcement, settled } =
      await setup("Keep old text.");
    await showComposer("Keep old text.", 5, 8);

    complete("brand new", "item-a");
    expect(records()[0]!.utterances[0]!.replaced).toBe("old");
    setDraft("Keep brand knew text.");

    service.handleEscape(PANEL);
    await settled();

    expect(draft()).toBe("Keep brand knew text.");
    expect(announcement()).toMatch(/kept/i);
  });

  it("leaves a caret the user placed ahead of the dictated words where it is", async () => {
    const { service, draft, setDraft, settled } = await setup("Keep old text.");
    await showComposer("Keep old text.", 5, 8);

    complete("new", "item-a");
    await takeCaret(draft());
    setDraft("Keep typed new text.");
    await showComposer(draft(), 11);

    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Keep typed old text.");
    expect(await takeCaret(draft())).toEqual({ from: 11, to: 11 });
  });

  it("selects the text again when the caret was inside the dictated words", async () => {
    const { service, draft, settled } = await setup("Keep old text.");
    await showComposer("Keep old text.", 5, 8);

    complete("brand new", "item-a");
    await takeCaret(draft());
    await showComposer(draft(), 9);

    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Keep old text.");
    expect(await takeCaret(draft())).toEqual({ from: 5, to: 8 });
  });

  it("keeps a selection that reaches past the dictated words where it was", async () => {
    const { service, draft, settled } = await setup("Keep old text.");
    await showComposer("Keep old text.", 5, 8);

    complete("brand new", "item-a");
    await takeCaret(draft());
    await showComposer(draft(), 7, 18);

    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Keep old text.");
    expect(await takeCaret(draft())).toEqual({ from: 5, to: 12 });
  });

  it("keeps a selection across words that were the selected ones", async () => {
    const { service, draft, settled } = await setup("Keep old text.");
    await showComposer("Keep old text.", 5, 8);

    complete("old", "item-a");
    complete("again", "item-b");
    expect(draft()).toBe("Keep old again text.");
    await takeCaret(draft());
    await showComposer(draft(), 6, 20);

    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Keep old text.");
    expect(await takeCaret(draft())).toEqual({ from: 6, to: 14 });
  });

  it("keeps the dictated words when the dictation is stopped rather than cancelled", async () => {
    const { service, draft } = await setup("Keep old text.");
    await showComposer("Keep old text.", 5, 8);

    complete("new", "item-a");
    await service.stop("Dictation stopped.");

    expect(draft()).toBe("Keep new text.");
  });

  it("puts back the earlier session's words when a second session replaced them", async () => {
    const { service, begin, draft, records, settled } = await setup("Keep old text.");
    await showComposer("Keep old text.", 5, 8);

    complete("new", "item-a");
    await service.stop("Dictation stopped.");
    expect(draft()).toBe("Keep new text.");

    begin("session-2");
    await showComposer(draft(), 5, 8);
    complete("fresh", "item-b", "session-2");
    expect(draft()).toBe("Keep fresh text.");

    await escapeToCancel(service);
    await settled();

    expect(draft()).toBe("Keep new text.");
    expect(await takeCaret(draft())).toEqual({ from: 5, to: 8 });
    expect(records().map((record) => record.sessionId)).toEqual([SESSION_ID]);
  });

  describe("asks for a second Escape first (#14927)", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const confirmMs = async () => (await import("@/lib/pressAgain")).PRESS_AGAIN_CONFIRM_MS;

    it("keeps the session and its words on the first press, and says so", async () => {
      const { service, voiceStore, draft, announcement } = await setup("Existing.");

      complete("Hello.", "item-a");
      expect(service.handleEscape(PANEL)).toBe(true);

      expect(announcement()).toBe("Press Escape again to cancel dictation");

      expect(draft()).toBe("Existing. Hello.");
      expect(voiceStore.getState().status).toBe("recording");
      expect(voiceStore.getState().dictationCancelConfirm).toMatchObject({ panelId: PANEL });
      expect(ipc.cancel).not.toHaveBeenCalled();
      expect(ipc.stop).not.toHaveBeenCalled();
    });

    it.each([
      [false, "Press Escape again to cancel dictation"],
      [true, null],
    ])(
      "announces a Canopy reply's prompt itself only while Canopy is closed (open: %s)",
      async (open, expected) => {
        const { service, voiceStore, announcement } = await setup();
        const { useCanopyStore } = await import("@/store/canopyStore");
        useCanopyStore.setState({ isOpen: open });
        voiceStore
          .getState()
          .beginSession(
            { panelId: PANEL, projectId: PROJECT, surface: "canopy-reply" },
            SESSION_ID
          );
        voiceStore.getState().setStatus("recording");

        complete("Hello.", "item-a");
        voiceStore.getState().clearAnnouncement();
        expect(service.handleEscape(PANEL)).toBe(true);

        expect(voiceStore.getState().dictationCancelConfirm).not.toBeNull();
        expect(announcement()).toBe(expected);
      }
    );

    it("takes out the words that landed while it waited too", async () => {
      const { service, draft, settled } = await setup("Existing.");

      complete("Hello.", "item-a");
      service.handleEscape(PANEL);
      complete("Again.", "item-b");
      expect(draft()).toBe("Existing. Hello. Again.");

      expect(service.handleEscape(PANEL)).toBe(true);
      await settled();

      expect(draft()).toBe("Existing.");
      expect(ipc.cancel).toHaveBeenCalledWith(SESSION_ID);
    });

    it("stands down when the window ends, and the next press starts over", async () => {
      const { service, voiceStore, draft } = await setup();

      complete("Hello.", "item-a");
      service.handleEscape(PANEL);
      const ms = await confirmMs();
      vi.advanceTimersByTime(ms - 1);
      expect(voiceStore.getState().dictationCancelConfirm).not.toBeNull();
      vi.advanceTimersByTime(1);

      expect(voiceStore.getState().dictationCancelConfirm).toBeNull();
      expect(voiceStore.getState().status).toBe("recording");
      expect(service.handleEscape(PANEL)).toBe(true);
      expect(voiceStore.getState().dictationCancelConfirm).not.toBeNull();
      expect(draft()).toBe("Hello.");
      expect(ipc.cancel).not.toHaveBeenCalled();
    });

    it("cancels on a second press late in the window", async () => {
      const { service, draft, settled } = await setup();

      complete("Hello.", "item-a");
      service.handleEscape(PANEL);
      vi.advanceTimersByTime((await confirmMs()) - 1);
      expect(service.handleEscape(PANEL)).toBe(true);
      await settled();

      expect(draft()).toBe("");
    });

    it("confirms across routes: the composer's press, then the global fallback's", async () => {
      const { service, draft, settled } = await setup();

      complete("Hello.", "item-a");
      service.handleEscape(PANEL);
      expect(service.handleEscape()).toBe(true);
      await settled();

      expect(draft()).toBe("");
    });

    it("leaves the waiting press alone for another pane's Escape", async () => {
      const { service, voiceStore, draft } = await setup();

      complete("Hello.", "item-a");
      service.handleEscape(PANEL);

      expect(service.handleEscape("panel-2")).toBe(false);
      expect(voiceStore.getState().dictationCancelConfirm).not.toBeNull();
      expect(draft()).toBe("Hello.");
    });

    it("never takes a held Escape's repeat as the second press", async () => {
      const { service, voiceStore, draft, settled } = await setup();
      const keydown = (repeat: boolean) => {
        const event = Object.assign(new Event("keydown"), {
          key: "Escape",
          code: "Escape",
          repeat,
        });
        for (const [type, listener] of vi.mocked(window.addEventListener).mock.calls) {
          if (type !== "keydown") continue;
          if (typeof listener === "function") listener(event);
          else listener.handleEvent(event);
        }
      };

      complete("Hello.", "item-a");
      keydown(false);
      service.handleEscape(PANEL);
      keydown(true);
      expect(service.handleEscape(PANEL)).toBe(true);

      expect(draft()).toBe("Hello.");
      expect(voiceStore.getState().dictationCancelConfirm).not.toBeNull();
      expect(ipc.cancel).not.toHaveBeenCalled();

      // Let go and press again: that one is the second press.
      keydown(false);
      expect(service.handleEscape(PANEL)).toBe(true);
      await settled();
      expect(draft()).toBe("");
      expect(voiceStore.getState().dictationCancelConfirm).toBeNull();
    });

    it("stands down when the dictation key stops the session, which keeps its words", async () => {
      const { service, voiceStore, draft, settled } = await setup();

      complete("Hello.", "item-a");
      service.handleEscape(PANEL);
      const stopping = service.stop("Dictation stopped.", { preserveLiveText: true });

      expect(voiceStore.getState().dictationCancelConfirm).toBeNull();
      await stopping;
      await settled();
      expect(draft()).toBe("Hello.");
      expect(ipc.cancel).not.toHaveBeenCalled();
    });

    it("cancels on one press when nothing has been written yet", async () => {
      const { service, voiceStore, settled } = await setup("Existing.");

      expect(service.handleEscape(PANEL)).toBe(true);
      expect(voiceStore.getState().dictationCancelConfirm).toBeNull();
      await settled();

      expect(ipc.cancel).toHaveBeenCalledWith(SESSION_ID);
    });
  });
});
