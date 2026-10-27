import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectCorrectionPassages, locatePassage } from "../voiceCorrectionPassages";

// Drives the real voice, draft and dictation-range stores through the IPC
// callbacks: every final the service writes is recorded as a range on the
// text it wrote, and the draft itself comes out exactly as before (#14597).

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
  commandText?: string;
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

type CorrectRequest = { rawText: string; recentContext?: string[]; terminalId?: string };

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

const delta = (text: string, itemId?: string) =>
  callbacks.delta!({ sessionId: SESSION_ID, text, itemId });
const complete = (text: string, itemId?: string, transcriptId?: string) =>
  callbacks.complete!({ sessionId: SESSION_ID, text, willCorrect: false, itemId, transcriptId });
const fileReferences = (
  transcriptId: string,
  references: FileTokenPayload["references"],
  sessionId = SESSION_ID
) => callbacks.fileToken!({ sessionId, transcriptId, references });

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

describe("VoiceRecordingService — dictation ranges (#14597)", () => {
  it("records each unidentified final on the text it wrote", async () => {
    const { draft, records, textOf, sessionId } = await setup("Existing.");

    delta("hel");
    delta("lo");
    expect(records()).toEqual([]);
    complete("Hello.");
    delta("again");
    complete("Again.");

    expect(draft()).toBe("Existing. Hello. Again.");
    const [record] = records();
    expect(record!.sessionId).toBe(sessionId());
    expect(textOf(record!.range)).toBe(" Hello. Again.");
    expect(record!.utterances.map((u) => textOf(u.range))).toEqual(["Hello.", "Again."]);
    expect(record!.range.edited).toBe(false);
  });

  it("keeps text typed at the anchor mid-utterance and lands the final after it (#14634)", async () => {
    const { draft, setDraft, records, textOf } = await setup("prefix");

    delta("fin");
    // Typed at the dictation's own point while the utterance streamed: the
    // anchor moves past it rather than slicing it away.
    setDraft("prefix typed");
    complete("Final.");

    expect(draft()).toBe("prefix typed Final.");
    const [record] = records();
    expect(record!.utterances[0]!.range).toEqual({ from: 13, to: 19, edited: false });
    expect(textOf(record!.range)).toBe(" Final.");
  });

  it("records nothing for a whitespace-only unidentified final", async () => {
    const { draft, records } = await setup("keep");

    delta("um");
    complete("  ");

    expect(draft()).toBe("keep");
    expect(records()).toEqual([]);
  });

  it("records identified items in the order they land", async () => {
    const { draft, records, textOf } = await setup();

    delta("one", "item-a");
    delta("two", "item-b");
    complete("One.", "item-a");
    complete("Two.", "item-b");

    expect(draft()).toBe("One. Two.");
    expect(records()[0]!.utterances.map((u) => textOf(u.range))).toEqual(["One.", "Two."]);
  });

  it("tells repeated item ids apart across a paragraph break", async () => {
    const { draft, records, textOf } = await setup();

    delta("first", "item-a");
    complete("First.", "item-a");
    callbacks.boundary!({ sessionId: SESSION_ID, rawText: null });
    complete("Second para.", "item-a");

    expect(draft()).toBe("First.\nSecond para.");
    const [record] = records();
    expect(textOf(record!.range)).toBe("First.\nSecond para.");
    expect(record!.range.edited).toBe(false);
    const ids = record!.utterances.map((u) => u.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("records nothing for an empty final", async () => {
    const { draft, records } = await setup("keep");

    delta("um", "item-a");
    complete("", "item-a");

    expect(draft()).toBe("keep");
    expect(records()).toEqual([]);
  });

  it("follows typing before and after the dictation, and flags typing inside it", async () => {
    const { draft, setDraft, records, textOf } = await setup();

    complete("Hello there.", "item-a");
    setDraft("Note: " + draft());
    setDraft(draft() + " Thanks.");
    expect(textOf(records()[0]!.range)).toBe("Hello there.");
    expect(records()[0]!.range.edited).toBe(false);

    const [utterance] = records()[0]!.utterances;
    expect(textOf(utterance!.range)).toBe("Hello there.");
    expect(textOf(utterance!.insertion)).toBe("Hello there.");

    setDraft(draft().replace("Hello there", "Hello over there"));
    const [record] = records();
    expect(textOf(record!.range)).toBe("Hello over there.");
    expect(record!.range.edited).toBe(true);
    expect(textOf(record!.utterances[0]!.range)).toBe("Hello over there.");
    expect(record!.utterances[0]!.range.edited).toBe(true);
  });

  it("trims and flags every span a delete crosses into", async () => {
    const { draft, setDraft, records, textOf } = await setup("Intro.");

    complete("Hello.", "item-a");
    // Deletes "o. Hel".
    setDraft("Intrlo.");

    const [record] = records();
    const [utterance] = record!.utterances;
    for (const range of [record!.range, utterance!.range, utterance!.insertion]) {
      expect(textOf(range)).toBe("lo.");
      expect(range.edited).toBe(true);
    }
    expect(draft()).toBe("Intrlo.");
  });

  it("records the stop flush of unfinished speech", async () => {
    const { service, draft, records, textOf } = await setup("Prefix");

    delta("half a thought");
    await service.stop("Dictation stopped.", { skipRemoteStop: true, preserveLiveText: true });

    expect(draft()).toBe("Prefix half a thought");
    const [record] = records();
    expect(textOf(record!.range)).toBe(" half a thought");
    expect(textOf(record!.utterances[0]!.range)).toBe("half a thought");
  });

  it("flushes a stopped utterance at the anchor, past text typed meanwhile (#14634)", async () => {
    const { service, draft, setDraft, records, textOf } = await setup("prefix");

    delta("half");
    setDraft("prefix typed");
    await service.stop("Dictation stopped.", { skipRemoteStop: true, preserveLiveText: true });

    expect(draft()).toBe("prefix typed half");
    expect(records()[0]!.utterances[0]!.range).toEqual({ from: 13, to: 17, edited: false });
    expect(textOf(records()[0]!.range)).toBe(" half");
  });

  it("keeps the dictation findable through post-stop correction, which flags what it rewrote", async () => {
    const { service, voiceStore, draft, records, textOf, getDictation } = await setup("Intro.");
    let resolveCorrection!: (value: unknown) => void;
    correct.fn.mockReturnValue(new Promise((resolve) => (resolveCorrection = resolve)));
    voiceStore.getState().setCorrectionEnabled(true);

    delta("hello", "item-a");
    complete("Hello there.", "item-a");
    const id = records()[0]!.id;
    await service.stop("Dictation stopped.");

    expect(correct.fn).toHaveBeenCalledWith({
      rawText: "Hello there.",
      recentContext: ["Intro."],
      startsPrompt: false,
      terminalId: "panel-1",
      sessionId: SESSION_ID,
    });
    expect(getDictation(id)).not.toBeNull();

    resolveCorrection({ action: "replace", correctedText: "Hello, there." });
    await vi.waitFor(() => expect(draft()).toBe("Intro. Hello, there."));

    const record = getDictation(id)!;
    expect(textOf(record.utterances[0]!.range)).toBe("Hello, there.");
    expect(record.utterances[0]!.range.edited).toBe(true);
    expect(record.utterances[0]!.insertion.edited).toBe(true);
    expect(record.range.edited).toBe(true);
  });

  it("hands a correction that swapped the passage to the composer, and only that", async () => {
    const { service, voiceStore, draft } = await setup("Intro.");
    const { takeLandedCorrection } = await import("../voiceCorrectionLanding");
    voiceStore.getState().setCorrectionEnabled(true);

    let resolveCorrection!: (value: unknown) => void;
    correct.fn.mockReturnValueOnce(new Promise((resolve) => (resolveCorrection = resolve)));
    complete("Hello there.", "item-a");
    await service.stop("Dictation stopped.");
    expect(service.hasPendingCorrection(PANEL)).toBe(true);
    resolveCorrection({ action: "replace", correctedText: "Hello there." });
    // The pass retires in the same step that would swap the text.
    await vi.waitFor(() => expect(service.hasPendingCorrection(PANEL)).toBe(false));
    expect(takeLandedCorrection(PANEL, PROJECT, draft())).toBeNull();

    voiceStore.getState().beginSession({ panelId: PANEL, projectId: PROJECT });
    correct.fn.mockResolvedValueOnce({ action: "replace", correctedText: "Hello, again." });
    complete("hello again", "item-b");
    await service.stop("Dictation stopped.");
    await vi.waitFor(() => expect(draft()).toBe("Intro. Hello there. Hello, again."));

    expect(takeLandedCorrection(PANEL, PROJECT, draft())).toEqual({
      from: "Intro. Hello there. ".length,
      rawText: "hello again",
      correctedText: "Hello, again.",
      baseline: { raw: "hello again", corrected: "Hello, again." },
      write: {
        before: "Intro. Hello there. hello again",
        after: "Intro. Hello there. Hello, again.",
        changes: [{ from: 20, to: 31, insert: "Hello, again." }],
      },
    });
  });

  it("keeps a session's ranges after the stop and beside the next session's", async () => {
    const { service, begin, records, textOf, sessionId } = await setup();

    complete("First session.", "item-a");
    const first = sessionId();
    await service.stop("Dictation stopped.", { skipRemoteStop: true });
    begin();
    complete("Second session.", "item-b");

    const list = records();
    expect(list.map((r) => r.sessionId)).toEqual([first, sessionId()]);
    expect(list.map((r) => textOf(r.range))).toEqual(["First session.", " Second session."]);
  });

  it("releases the ranges on send and starts a fresh record for later speech", async () => {
    const { draft, setDraft, records, textOf, sessionId } = await setup();

    complete("Sent part.", "item-a");
    const sentId = records()[0]!.id;
    setDraft("");
    expect(records()).toEqual([]);

    complete("Kept part.", "item-b");
    expect(draft()).toBe("Kept part.");
    const [record] = records();
    expect(record!.id).not.toBe(sentId);
    expect(record!.sessionId).toBe(sessionId());
    expect(textOf(record!.range)).toBe("Kept part.");
  });

  it("moves a newer session's learning baseline once when an older one's file link lands before it", async () => {
    const { service, voiceStore, begin, draft } = await setup();

    complete("Link to the readme file.", "item-a", "t1");
    await service.stop("Dictation stopped.");
    begin("session-2");
    callbacks.complete!({
      sessionId: "session-2",
      text: "hello there",
      willCorrect: false,
      itemId: "item-b",
    });
    await service.stop("Dictation stopped.");
    expect(voiceStore.getState().panelBuffers[PANEL]!.sessionCorrectedText).toBe("hello there");

    fileReferences("t1", [{ description: "readme file", path: "README.md" }]);

    expect(draft()).toBe("@README.md. hello there");
    const buffer = voiceStore.getState().panelBuffers[PANEL]!;
    expect(buffer.sessionCorrectedText).toBe("hello there");
    expect(draft().slice(buffer.sessionDraftStart)).toBe("hello there");
  });
});

describe("VoiceRecordingService — correction over dictated ranges (#14613)", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const upperCase = async ({ rawText }: CorrectRequest) => ({
    action: "replace",
    correctedText: rawText.toUpperCase(),
  });
  const sentTexts = () => correct.fn.mock.calls.map(([request]) => request.rawText);
  // An OpenAI utterance: partials first, then its final.
  const say = (text: string, itemId: string) => {
    delta(text, itemId);
    complete(text, itemId);
  };

  it("corrects a Deepgram session, whose finals arrive without partials", async () => {
    const { service, voiceStore, draft } = await setup();
    correct.fn.mockResolvedValue({ action: "replace", correctedText: "Hello, there." });
    voiceStore.getState().setCorrectionEnabled(true);

    complete("hello there");
    await service.stop("Dictation stopped.");

    expect(correct.fn).toHaveBeenCalledWith({
      rawText: "hello there",
      startsPrompt: true,
      terminalId: "panel-1",
      sessionId: SESSION_ID,
    });
    await vi.waitFor(() => expect(draft()).toBe("Hello, there."));
    const buffer = voiceStore.getState().panelBuffers[PANEL]!;
    expect(buffer.sessionCorrectedText).toBe("Hello, there.");
    expect(buffer.sessionDraftStart).toBe(0);
  });

  it("gives a Deepgram session a learning baseline when correction is off", async () => {
    const { service, voiceStore } = await setup("Intro.");

    complete("hello there");
    await service.stop("Dictation stopped.");

    expect(correct.fn).not.toHaveBeenCalled();
    const buffer = voiceStore.getState().panelBuffers[PANEL]!;
    expect(buffer.sessionCorrectedText).toBe("hello there");
    expect(buffer.sessionDraftStart).toBe("Intro. ".length);
  });

  it("never sends or rewrites text typed between two utterances", async () => {
    const { service, voiceStore, draft, setDraft } = await setup();
    correct.fn.mockImplementation(upperCase);
    voiceStore.getState().setCorrectionEnabled(true);

    say("first part", "item-a");
    setDraft(draft() + " typed note");
    say("second part", "item-b");
    await service.stop("Dictation stopped.");

    expect(sentTexts()).toEqual(["first part", "second part"]);
    expect(correct.fn.mock.calls[1]![0].recentContext).toEqual(["first part typed note"]);
    await vi.waitFor(() => expect(draft()).toBe("FIRST PART typed note SECOND PART"));
    expect(voiceStore.getState().panelBuffers[PANEL]!.sessionCorrectedText).toBe(
      "FIRST PART SECOND PART"
    );
  });

  it("sends the text before the dictation as context and leaves typed text around it alone", async () => {
    const { service, voiceStore, draft, setDraft } = await setup("Note: the build fails when");
    correct.fn.mockResolvedValue({ action: "replace", correctedText: "it runs on Windows" });
    voiceStore.getState().setCorrectionEnabled(true);

    say("it runs on windows", "item-a");
    setDraft(draft() + ". Thanks.");
    await service.stop("Dictation stopped.");

    expect(correct.fn).toHaveBeenCalledWith({
      rawText: "it runs on windows",
      recentContext: ["Note: the build fails when"],
      startsPrompt: false,
      terminalId: "panel-1",
      sessionId: SESSION_ID,
    });
    await vi.waitFor(() =>
      expect(draft()).toBe("Note: the build fails when it runs on Windows. Thanks.")
    );
  });

  it("applies the result to the dictated range after typing around it while correction runs", async () => {
    const { service, voiceStore, draft, setDraft } = await setup();
    let resolveCorrection!: (value: unknown) => void;
    correct.fn.mockReturnValue(new Promise((resolve) => (resolveCorrection = resolve)));
    voiceStore.getState().setCorrectionEnabled(true);

    say("hello there", "item-a");
    await service.stop("Dictation stopped.");
    setDraft("hello there and more");
    setDraft("Before: " + draft());

    resolveCorrection({ action: "replace", correctedText: "Hello, there." });
    await vi.waitFor(() => expect(draft()).toBe("Before: Hello, there. and more"));
  });

  it("discards the result when the dictated text is edited while correction runs", async () => {
    const { service, voiceStore, draft, setDraft } = await setup();
    let resolveCorrection!: (value: unknown) => void;
    correct.fn.mockReturnValue(new Promise((resolve) => (resolveCorrection = resolve)));
    voiceStore.getState().setCorrectionEnabled(true);

    say("hello there", "item-a");
    await service.stop("Dictation stopped.");
    setDraft("hello over there");

    resolveCorrection({ action: "replace", correctedText: "Hello, there." });
    await flush();
    expect(draft()).toBe("hello over there");
    expect(voiceStore.getState().panelBuffers[PANEL]!.correctionRanges).toEqual([]);
  });

  it("leaves an utterance the user edited during the session out of correction", async () => {
    const { service, voiceStore, draft, setDraft } = await setup();
    correct.fn.mockImplementation(upperCase);
    voiceStore.getState().setCorrectionEnabled(true);

    say("first part", "item-a");
    setDraft(draft().replace("first part", "first bit"));
    say("second part", "item-b");
    await service.stop("Dictation stopped.");

    expect(sentTexts()).toEqual(["second part"]);
    await vi.waitFor(() => expect(draft()).toBe("first bit SECOND PART"));
  });

  it("corrects a paragraph break and the text either side as one passage", async () => {
    const { service, voiceStore, draft } = await setup();
    correct.fn.mockImplementation(upperCase);
    voiceStore.getState().setCorrectionEnabled(true);

    say("first para", "item-a");
    callbacks.boundary!({ sessionId: SESSION_ID, rawText: null });
    say("second para", "item-b");
    await service.stop("Dictation stopped.");

    expect(sentTexts()).toEqual(["first para\nsecond para"]);
    await vi.waitFor(() => expect(draft()).toBe("FIRST PARA\nSECOND PARA"));
  });

  it("marks only the dictated passages while correction runs", async () => {
    const { service, voiceStore, draft, setDraft } = await setup();
    const resolvers: Array<(value: unknown) => void> = [];
    correct.fn.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    voiceStore.getState().setCorrectionEnabled(true);

    say("first part", "item-a");
    setDraft(draft() + " typed note");
    say("second part", "item-b");
    await service.stop("Dictation stopped.");

    const pending = () => voiceStore.getState().panelBuffers[PANEL]!.correctionRanges;
    expect(pending().map((r) => draft().slice(r.from, r.to))).toEqual([
      "first part",
      "second part",
    ]);
    resolvers.forEach((resolve) => resolve({ action: "no_change", correctedText: "" }));
    await vi.waitFor(() => expect(pending()).toEqual([]));
    expect(draft()).toBe("first part typed note second part");
  });

  it("hands the composer one span over every corrected passage, typed text between kept", async () => {
    const { service, voiceStore, draft, setDraft } = await setup("Intro.");
    const { takeLandedCorrection } = await import("../voiceCorrectionLanding");
    correct.fn.mockImplementation(upperCase);
    voiceStore.getState().setCorrectionEnabled(true);

    say("first part", "item-a");
    setDraft(draft() + " typed note");
    say("second part", "item-b");
    await service.stop("Dictation stopped.");
    await vi.waitFor(() => expect(draft()).toBe("Intro. FIRST PART typed note SECOND PART"));

    expect(takeLandedCorrection(PANEL, PROJECT, draft())).toEqual({
      from: "Intro. ".length,
      rawText: "first part typed note second part",
      correctedText: "FIRST PART typed note SECOND PART",
      baseline: { raw: "first part second part", corrected: "FIRST PART SECOND PART" },
      // Passage by passage, so the composer leaves what was typed between them alone.
      write: {
        before: "Intro. first part typed note second part",
        after: "Intro. FIRST PART typed note SECOND PART",
        changes: [
          { from: 7, to: 17, insert: "FIRST PART" },
          { from: 29, to: 40, insert: "SECOND PART" },
        ],
      },
    });
  });

  it("applies every passage when one result shifts text identical to the next", async () => {
    const { service, voiceStore, draft, setDraft } = await setup();
    correct.fn.mockImplementation(async ({ rawText }: CorrectRequest) => ({
      action: "replace",
      correctedText: rawText === "go go" ? "go" : "go.",
    }));
    voiceStore.getState().setCorrectionEnabled(true);

    say("go go", "item-a");
    setDraft(draft() + " go");
    say("go", "item-b");
    expect(draft()).toBe("go go go go");
    const writes: string[] = [];
    const { useTerminalInputStore } = await import("@/store/terminalInputStore");
    const off = useTerminalInputStore.subscribe((state, prev) => {
      if (state.draftInputs !== prev.draftInputs) writes.push(draft());
    });
    await service.stop("Dictation stopped.");

    await vi.waitFor(() => expect(draft()).toBe("go go go."));
    off();
    expect(writes).toEqual(["go go go."]);
  });

  it("keeps a passage whose request failed while applying the others", async () => {
    const { service, voiceStore, draft, setDraft } = await setup();
    correct.fn.mockImplementation(async ({ rawText }: CorrectRequest) => {
      if (rawText === "first part") throw new Error("rate limited");
      return { action: "replace", correctedText: "Second part." };
    });
    voiceStore.getState().setCorrectionEnabled(true);

    say("first part", "item-a");
    setDraft(draft() + " typed");
    say("second part", "item-b");
    await service.stop("Dictation stopped.");

    await vi.waitFor(() => expect(draft()).toBe("first part typed Second part."));
    const buffer = voiceStore.getState().panelBuffers[PANEL]!;
    expect(buffer.sessionCorrectedText).toBe("first part Second part.");
    expect(buffer.correctionRanges).toEqual([]);
  });

  it("keeps the raw text as the learning baseline when a result can't be applied", async () => {
    const { service, voiceStore, setDraft } = await setup();
    let resolveCorrection!: (value: unknown) => void;
    correct.fn.mockReturnValue(new Promise((resolve) => (resolveCorrection = resolve)));
    voiceStore.getState().setCorrectionEnabled(true);

    say("helo world", "item-a");
    await service.stop("Dictation stopped.");
    setDraft("hello world");

    resolveCorrection({ action: "replace", correctedText: "Hello, world." });
    await flush();
    expect(voiceStore.getState().panelBuffers[PANEL]!.sessionCorrectedText).toBe("helo world");
  });

  it("drops a result whose dictation was sent while correction ran", async () => {
    const { service, voiceStore, draft, setDraft } = await setup();
    let resolveCorrection!: (value: unknown) => void;
    correct.fn.mockReturnValue(new Promise((resolve) => (resolveCorrection = resolve)));
    voiceStore.getState().setCorrectionEnabled(true);

    say("hello there", "item-a");
    await service.stop("Dictation stopped.");
    setDraft("");
    setDraft("hello there");

    resolveCorrection({ action: "replace", correctedText: "Hello, there." });
    await flush();
    expect(draft()).toBe("hello there");
  });

  it("bounds the context to the draft's last few hundred characters, on a word boundary", async () => {
    const intro = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const { service, voiceStore } = await setup(intro);
    correct.fn.mockResolvedValue({ action: "no_change", correctedText: "" });
    voiceStore.getState().setCorrectionEnabled(true);

    say("and then some", "item-a");
    await service.stop("Dictation stopped.");

    const [context] = correct.fn.mock.calls[0]![0].recentContext!;
    expect(context!.length).toBeLessThanOrEqual(500);
    expect(context!.length).toBeGreaterThan(400);
    expect(intro.endsWith(context!)).toBe(true);
    expect(intro.charAt(intro.length - context!.length - 1)).toBe(" ");
  });

  it.each([
    [{ action: "replace", correctedText: " \nHello, there.\n " }, "Hello, there."],
    [{ action: "replace", correctedText: " \n\t " }, "hello there"],
    [{ action: "no_change", correctedText: "Ignored." }, "hello there"],
  ])("settles %j as %j, keeping a trailing newline in the context", async (result, expected) => {
    const { service, voiceStore, draft, setDraft } = await setup("Intro.\n");
    correct.fn.mockResolvedValue(result);
    voiceStore.getState().setCorrectionEnabled(true);

    say("hello there", "item-a");
    setDraft(draft() + " Thanks.");
    await service.stop("Dictation stopped.");
    await flush();

    expect(correct.fn).toHaveBeenCalledWith({
      rawText: "hello there",
      recentContext: ["Intro.\n"],
      startsPrompt: false,
      terminalId: "panel-1",
      sessionId: SESSION_ID,
    });
    expect(draft()).toBe(`Intro.\n${expected} Thanks.`);
    expect(voiceStore.getState().panelBuffers[PANEL]!.sessionCorrectedText).toBe(expected);
  });

  it("keeps a whole word that starts exactly where the context bound falls", async () => {
    const word = "a".repeat(499);
    const { service, voiceStore } = await setup(`x ${word}`);
    correct.fn.mockResolvedValue({ action: "no_change", correctedText: "" });
    voiceStore.getState().setCorrectionEnabled(true);

    say("more", "item-a");
    await service.stop("Dictation stopped.");

    expect(correct.fn).toHaveBeenCalledWith({
      rawText: "more",
      recentContext: [word],
      startsPrompt: false,
      terminalId: "panel-1",
      sessionId: SESSION_ID,
    });
  });

  it("leaves typed text out of the learning baseline when correction is off", async () => {
    const { service, voiceStore, draft, setDraft } = await setup();

    say("first part", "item-a");
    setDraft(draft() + " typed note");
    say("second part", "item-b");
    await service.stop("Dictation stopped.");

    expect(voiceStore.getState().panelBuffers[PANEL]!.sessionCorrectedText).toBe(
      "first part second part"
    );
  });

  it("discards the result when a paragraph break inside the passage was edited and put back", async () => {
    const { service, voiceStore, draft, setDraft } = await setup();
    let resolveCorrection!: (value: unknown) => void;
    correct.fn.mockReturnValue(new Promise((resolve) => (resolveCorrection = resolve)));
    voiceStore.getState().setCorrectionEnabled(true);

    say("alpha", "item-a");
    callbacks.boundary!({ sessionId: SESSION_ID, rawText: null });
    say("beta", "item-b");
    await service.stop("Dictation stopped.");
    expect(sentTexts()).toEqual(["alpha\nbeta"]);
    setDraft("alpha beta");
    setDraft("alpha\nbeta");

    resolveCorrection({ action: "replace", correctedText: "Alpha.\nBeta." });
    await flush();
    expect(draft()).toBe("alpha\nbeta");
  });

  it("corrects only the stopping session when stopped while a retarget to another panel is still arming", async () => {
    const { service, voiceStore } = await setup();
    correct.fn.mockResolvedValue({ action: "replace", correctedText: "Rewritten." });
    voiceStore.getState().setCorrectionEnabled(true);

    say("old words", "item-a");
    await service.stop("Dictation stopped.", { skipRemoteStop: true });
    voiceStore.getState().beginSession({ panelId: "panel-2", projectId: PROJECT });
    say("new words", "item-b");
    // Retargeting back to the first panel only queues it (#14604): the live
    // session on panel-2 is what stops, and the first panel's old dictation
    // is never corrected.
    voiceStore.getState().setArming({ panelId: PANEL, projectId: PROJECT });
    await service.stop("Dictation stopped.");

    expect(correct.fn).toHaveBeenCalledTimes(1);
    expect(correct.fn).toHaveBeenCalledWith(expect.objectContaining({ rawText: "new words" }));
    expect(correct.fn).not.toHaveBeenCalledWith(
      expect.objectContaining({ rawText: expect.stringContaining("old words") })
    );
  });

  it("sends nothing for a dictation the draft already released", async () => {
    const { service, voiceStore, setDraft } = await setup();
    voiceStore.getState().setCorrectionEnabled(true);

    say("sent already", "item-a");
    setDraft("");
    await service.stop("Dictation stopped.");

    expect(correct.fn).not.toHaveBeenCalled();
  });
});

describe("VoiceRecordingService — the target agent's commands (#14655)", () => {
  const say = (text: string, itemId: string) => {
    delta(text, itemId);
    complete(text, itemId);
  };
  const sayCommand = (text: string, commandText: string, itemId: string) => {
    delta(text, itemId);
    callbacks.complete!({ sessionId: SESSION_ID, text, willCorrect: false, itemId, commandText });
  };
  async function showComposer(doc: string, anchor: number) {
    const { EditorState } = await import("@codemirror/state");
    const { recordComposerState } = await import("@/lib/composerCaret");
    recordComposerState(
      `${PROJECT}:${PANEL}`,
      {},
      EditorState.create({ doc, selection: { anchor } })
    );
  }

  it("writes a spoken command as typed when it opens the prompt", async () => {
    const { draft, records, textOf } = await setup();
    sayCommand("Slash review the last commit.", "/review the last commit.", "item-a");
    expect(draft()).toBe("/review the last commit.");
    expect(textOf(records()[0]!.utterances[0]!.range)).toBe("/review the last commit.");
  });

  it("keeps the words when text comes before them", async () => {
    const { draft } = await setup("Note:");
    sayCommand("Slash compact.", "/compact", "item-a");
    expect(draft()).toBe("Note: Slash compact.");
  });

  it("keeps the words at a caret with typed text before it (#14634)", async () => {
    const { draft } = await setup("Note: fix it");
    await showComposer("Note: fix it", 6);
    sayCommand("slash compact", "/compact", "item-a");
    expect(draft()).toBe("Note: slash compact fix it");
  });

  it("writes the command at a caret that opens the prompt, ahead of typed text (#14634)", async () => {
    const { draft, records, textOf } = await setup("fix it");
    await showComposer("fix it", 0);
    sayCommand("slash compact", "/compact", "item-a");
    expect(draft()).toBe("/compact fix it");
    expect(textOf(records()[0]!.utterances[0]!.range)).toBe("/compact");
  });

  it("keeps the words after a whitespace-only draft is filled in", async () => {
    const { draft } = await setup("  ");
    sayCommand("slash compact", "/compact", "item-a");
    expect(draft().trim()).toBe("/compact");
  });

  it("drops a command correction wrote once text is typed in front of the passage", async () => {
    const { service, voiceStore, draft, setDraft } = await setup();
    let resolveCorrection!: (value: unknown) => void;
    correct.fn.mockReturnValue(new Promise((resolve) => (resolveCorrection = resolve)));
    voiceStore.getState().setCorrectionEnabled(true);

    say("run the compact command", "item-a");
    await service.stop("Dictation stopped.");
    expect(correct.fn).toHaveBeenCalledWith(expect.objectContaining({ startsPrompt: true }));
    setDraft("First: " + draft());

    resolveCorrection({ action: "replace", correctedText: "/compact" });
    await vi.waitFor(() => expect(service.hasPendingCorrection(PANEL)).toBe(false));
    expect(draft()).toBe("First: run the compact command");
  });

  it("lands a path correction once text is typed in front of the passage", async () => {
    const { service, voiceStore, draft, setDraft } = await setup();
    let resolveCorrection!: (value: unknown) => void;
    correct.fn.mockReturnValue(new Promise((resolve) => (resolveCorrection = resolve)));
    voiceStore.getState().setCorrectionEnabled(true);

    say("slash etc slash hosts is wrong", "item-a");
    await service.stop("Dictation stopped.");
    setDraft("Check: " + draft());

    resolveCorrection({ action: "replace", correctedText: "/etc/hosts is wrong" });
    await vi.waitFor(() => expect(draft()).toBe("Check: /etc/hosts is wrong"));
  });

  it("lands a command correction wrote while the passage still opens the prompt", async () => {
    const { service, voiceStore, draft } = await setup();
    correct.fn.mockResolvedValue({ action: "replace", correctedText: "/compact" });
    voiceStore.getState().setCorrectionEnabled(true);

    say("run the compact command", "item-a");
    await service.stop("Dictation stopped.");
    await vi.waitFor(() => expect(draft()).toBe("/compact"));
  });
});

describe("voiceCorrectionPassages (#14613)", () => {
  it("splits at a separator typed into, though the words either side are untouched", async () => {
    const { draft, setDraft, records } = await setup();

    complete("first", "item-a");
    complete("second", "item-b");
    setDraft("first typed second");

    const record = records()[0]!;
    expect(record.utterances[1]!.range.edited).toBe(false);
    expect(record.utterances[1]!.insertion.edited).toBe(true);
    expect(collectCorrectionPassages(record, draft()).map((p) => p.text)).toEqual([
      "first",
      "second",
    ]);
  });

  it("still joins utterances written straight after each other once typing split the dictation", async () => {
    const { draft, setDraft, records } = await setup();

    complete("first", "item-a");
    setDraft(draft() + " typed");
    complete("second", "item-b");
    complete("third", "item-c");

    expect(records()[0]!.range.edited).toBe(true);
    expect(collectCorrectionPassages(records()[0]!, draft()).map((p) => p.text)).toEqual([
      "first",
      "second third",
    ]);
  });

  it("rejects words that were edited and put back", async () => {
    const { draft, setDraft, records } = await setup();

    complete("hello there", "item-a");
    const [passage] = collectCorrectionPassages(records()[0]!, draft());
    setDraft("hello over there");
    setDraft("hello there");

    expect(locatePassage(records()[0]!, passage!, draft())).toBeNull();
  });

  it("rejects a passage whose text no longer matches, whatever its ranges say", () => {
    const record = {
      id: "record",
      sessionId: "session",
      panelId: PANEL,
      range: { from: 0, to: 5, edited: false },
      utterances: [
        {
          id: "u1",
          range: { from: 0, to: 5, edited: false },
          insertion: { from: 0, to: 5, edited: false },
        },
      ],
      breaks: [],
    };
    const [passage] = collectCorrectionPassages(record, "hello");

    expect(locatePassage(record, passage!, "hello")).toEqual({ from: 0, to: 5 });
    expect(locatePassage(record, passage!, "jello")).toBeNull();
  });
});

describe("VoiceRecordingService — spoken file references (#14616)", () => {
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

  it("lands a reference in the final utterance after the session has stopped", async () => {
    const { service, voiceStore, draft } = await setup("Fix the padding.");

    complete("Link to the input bar component.", "item-a", "t1");
    await service.stop("Dictation stopped.", { skipRemoteStop: true });
    expect(voiceStore.getState().activeTarget).toBeNull();

    fileReferences("t1", [{ description: "input bar component", path: "src/InputBar.tsx" }]);

    expect(draft()).toBe("Fix the padding. @src/InputBar.tsx.");
  });

  it("lands in the speaking session's panel while another panel is dictating", async () => {
    const { voiceStore, draft } = await setup();
    const { useTerminalInputStore } = await import("@/store/terminalInputStore");

    complete("Link to the router.", "item-a", "t1");
    voiceStore.getState().beginSession({ panelId: "panel-2", projectId: PROJECT }, "session-2");
    fileReferences("t1", [{ description: "router", path: "src/router.ts" }]);

    expect(draft()).toBe("@src/router.ts.");
    expect(useTerminalInputStore.getState().getDraftInput("panel-2", PROJECT)).toBe("");
  });

  it("swaps inside its own transcript, not text typed after it", async () => {
    const { draft, setDraft } = await setup();

    complete("Link to the router.", "item-a", "t1");
    setDraft(`${draft()} Then link to the router again.`);
    fileReferences("t1", [{ description: "router", path: "src/router.ts" }]);

    expect(draft()).toBe("@src/router.ts. Then link to the router again.");
  });

  it("leaves the spoken words when nothing resolved them", async () => {
    const { draft } = await setup();

    complete("Link to the old API.", "item-a", "t1");
    fileReferences("t1", [{ description: "something else", path: "src/other.ts" }]);

    expect(draft()).toBe("Link to the old API.");
    expect(draft()).not.toContain("@?");
  });

  it("ignores references from another session", async () => {
    const { draft } = await setup();

    complete("Link to the router.", "item-a", "t1");
    fileReferences("t1", [{ description: "router", path: "src/router.ts" }], "session-other");

    expect(draft()).toBe("Link to the router.");
  });

  it("leaves words the user edited before the reference arrived", async () => {
    const { draft, setDraft } = await setup();

    complete("Link to the router.", "item-a", "t1");
    setDraft("Link to the main router.");
    fileReferences("t1", [{ description: "router", path: "src/router.ts" }]);

    expect(draft()).toBe("Link to the main router.");
  });

  it("moves the next utterance's start past a swap that changed the draft's length", async () => {
    const { draft } = await setup();

    delta("Link to app.");
    complete("Link to app.", undefined, "t1");
    delta("Next");
    fileReferences("t1", [{ description: "app", path: "src/very/long/path/App.tsx" }]);
    complete("Next.");

    expect(draft()).toBe("@src/very/long/path/App.tsx. Next.");
  });

  it("drops references whose draft was sent", async () => {
    const { draft, setDraft } = await setup();

    complete("Link to the router.", "item-a", "t1");
    setDraft("");
    fileReferences("t1", [{ description: "router", path: "src/router.ts" }]);

    expect(draft()).toBe("");
  });
});

describe("VoiceRecordingService — a resolved file reference stays dictated text (#14806)", () => {
  const router = [{ description: "router", path: "src/router.ts" }];
  const sentTexts = () => correct.fn.mock.calls.map(([request]) => request.rawText);

  it("keeps the dictation and its utterances unedited, with their ranges on the token", async () => {
    const { draft, records, textOf } = await setup("Existing.");

    complete("Fix the padding.", "item-a");
    complete("Link to the router.", "item-b", "t1");
    complete("Thanks.", "item-c");
    fileReferences("t1", router);

    expect(draft()).toBe("Existing. Fix the padding. @src/router.ts. Thanks.");
    const [record] = records();
    expect(record!.range.edited).toBe(false);
    expect(textOf(record!.range)).toBe(" Fix the padding. @src/router.ts. Thanks.");
    expect(record!.utterances.map((u) => [textOf(u.range), u.range.edited])).toEqual([
      ["Fix the padding.", false],
      ["@src/router.ts.", false],
      ["Thanks.", false],
    ]);
    expect(record!.utterances.map((u) => [textOf(u.insertion), u.insertion.edited])).toEqual([
      [" Fix the padding.", false],
      [" @src/router.ts.", false],
      [" Thanks.", false],
    ]);
  });

  it("keeps a link at either end of its words unedited, and later text out of them", async () => {
    const { draft, setDraft, records, textOf } = await setup();

    complete("Link to the router", "item-a", "t1");
    complete("Then link to the readme", "item-b", "t2");
    fileReferences("t1", router);
    fileReferences("t2", [{ description: "readme", path: "README.md" }]);
    // Two writes: one diff over both ends would read as replacing the lot.
    setDraft(`Note: ${draft()}`);
    setDraft(`${draft()} Done.`);

    expect(draft()).toBe("Note: @src/router.ts Then @README.md Done.");
    const [record] = records();
    expect(record!.utterances.map((u) => [textOf(u.range), u.range.edited])).toEqual([
      ["@src/router.ts", false],
      ["Then @README.md", false],
    ]);
    expect(textOf(record!.range)).toBe("@src/router.ts Then @README.md");
    expect(record!.range.edited).toBe(false);
  });

  it("swaps several links in one transcript without editing any of its words", async () => {
    const { draft, records, textOf } = await setup();

    complete("Link to the router and link to the readme.", "item-a", "t1");
    fileReferences("t1", [...router, { description: "readme", path: "README.md" }]);

    expect(draft()).toBe("@src/router.ts and @README.md.");
    const [record] = records();
    expect(textOf(record!.utterances[0]!.range)).toBe("@src/router.ts and @README.md.");
    expect(record!.utterances[0]!.range.edited).toBe(false);
    expect(record!.range.edited).toBe(false);
  });

  it.each([
    ["inside the reference", "router.ts", "routers.ts"],
    ["in the words before it", "Open it", "Close it"],
    ["in the words after it", "please", "now"],
  ])("counts an edit %s as the user's", async (_where, from, to) => {
    const { draft, setDraft, records } = await setup();

    complete("Open it, link to the router, please.", "item-a", "t1");
    fileReferences("t1", router);
    expect(draft()).toBe("Open it, @src/router.ts, please.");
    expect(records()[0]!.utterances[0]!.range.edited).toBe(false);
    setDraft(draft().replace(from, to));

    expect(records()[0]!.utterances[0]!.range.edited).toBe(true);
    expect(records()[0]!.range.edited).toBe(true);
  });

  it("flags only the utterance whose link was edited", async () => {
    const { draft, setDraft, records } = await setup();

    complete("One.", "item-a");
    complete("Link to the router.", "item-b", "t1");
    complete("Three.", "item-c");
    fileReferences("t1", router);
    expect(records()[0]!.utterances.map((u) => u.range.edited)).toEqual([false, false, false]);
    setDraft(draft().replace("router.ts", "routers.ts"));

    expect(records()[0]!.utterances.map((u) => u.range.edited)).toEqual([false, true, false]);
  });

  it("cleans up the passage around a link as one", async () => {
    const { service, voiceStore, draft } = await setup();
    correct.fn.mockImplementation(async ({ rawText }: CorrectRequest) => ({
      action: "replace",
      correctedText: rawText.replace("padding", "Padding"),
    }));
    voiceStore.getState().setCorrectionEnabled(true);

    complete("Fix the padding.", "item-a");
    complete("Link to the router.", "item-b", "t1");
    complete("Thanks.", "item-c");
    fileReferences("t1", router);
    await service.stop("Dictation stopped.");

    expect(sentTexts()).toEqual(["Fix the padding. @src/router.ts. Thanks."]);
    await vi.waitFor(() => expect(draft()).toBe("Fix the Padding. @src/router.ts. Thanks."));
  });

  it("cleans up a one-utterance prompt whose link resolves while the stop drains", async () => {
    const { service, voiceStore, draft } = await setup();
    correct.fn.mockImplementation(async ({ rawText }: CorrectRequest) => ({
      action: "replace",
      correctedText: rawText.replace("check", "Check"),
    }));
    voiceStore.getState().setCorrectionEnabled(true);
    voiceStore.getState().setStatus("recording");
    Reflect.set(service, "sessionId", SESSION_ID);
    let finishDrain!: () => void;
    vi.mocked(window.electron.voiceInput.stop).mockReturnValue(
      new Promise((resolve) => {
        finishDrain = () => resolve({ rawText: null });
      })
    );

    const stopping = service.stop("Dictation stopped.");
    await vi.waitFor(() => expect(window.electron.voiceInput.stop).toHaveBeenCalled());
    complete("check link to the router please", "item-a", "t1");
    fileReferences("t1", router);
    expect(draft()).toBe("check @src/router.ts please");
    expect(sentTexts()).toEqual([]);
    finishDrain();
    await stopping;

    expect(sentTexts()).toEqual(["check @src/router.ts please"]);
    await vi.waitFor(() => expect(draft()).toBe("Check @src/router.ts please"));
  });

  it("cleans up a one-utterance prompt once its link resolved", async () => {
    const { service, voiceStore } = await setup();
    correct.fn.mockResolvedValue({ action: "no_change", correctedText: "" });
    voiceStore.getState().setCorrectionEnabled(true);

    complete("check link to the router please", "item-a", "t1");
    fileReferences("t1", router);
    await service.stop("Dictation stopped.");

    expect(sentTexts()).toEqual(["check @src/router.ts please"]);
  });
});

describe("VoiceRecordingService — dictating at the caret (#14634)", () => {
  /** What the composer showed when dictation began: its draft and selection. */
  async function showComposer(doc: string, anchor: number, head = anchor) {
    const { EditorState } = await import("@codemirror/state");
    const { recordComposerState } = await import("@/lib/composerCaret");
    recordComposerState(
      `${PROJECT}:${PANEL}`,
      {},
      EditorState.create({ doc, selection: { anchor, head } })
    );
  }
  const takeCaret = async (draft: string) =>
    (await import("@/lib/composerCaret")).takePendingComposerSelection(
      `${PROJECT}:${PANEL}`,
      draft
    );

  it("writes each utterance at the caret, one after another", async () => {
    const { draft, records, textOf } = await setup("Fix the bug. Then test.");
    await showComposer("Fix the bug. Then test.", 12);

    delta("hel");
    complete("Hello.");
    expect(await takeCaret(draft())).toEqual({ from: 19, to: 19 });
    delta("ag");
    complete("Again.");

    expect(draft()).toBe("Fix the bug. Hello. Again. Then test.");
    const [record] = records();
    expect(record!.utterances.map((u) => textOf(u.range))).toEqual(["Hello.", "Again."]);
    expect(textOf(record!.range)).toBe(" Hello. Again.");
    expect(record!.range.edited).toBe(false);
  });

  it("replaces the selection with what's said", async () => {
    const { draft, records, textOf } = await setup("open the zoo stand store");
    await showComposer("open the zoo stand store", 18, 9);

    complete("Zustand");

    expect(draft()).toBe("open the Zustand store");
    expect(textOf(records()[0]!.utterances[0]!.range)).toBe("Zustand");
  });

  it("keeps dictating at its own spot while the user types elsewhere", async () => {
    const { draft, setDraft, records, textOf } = await setup("A. B.");
    await showComposer("A. B.", 2);

    complete("one.");
    setDraft("> " + draft());
    complete("two.");

    expect(draft()).toBe("> A. one. two. B.");
    expect(records()[0]!.utterances.map((u) => textOf(u.range))).toEqual(["one.", "two."]);
  });

  it("leaves the caret alone when it was somewhere else", async () => {
    const { draft } = await setup("A. B.");
    await showComposer("A. B.", 2);
    complete("one.");
    await takeCaret(draft());
    await showComposer(draft(), 0);

    complete("two.");

    expect(await takeCaret(draft())).toBeNull();
  });

  it("appends when the composer shows another draft than the store's", async () => {
    const { draft } = await setup("hello world");
    await showComposer("hello", 2);

    complete("Bye.");

    expect(draft()).toBe("hello world Bye.");
  });

  it("lands an identified item at its spot, past text typed there while it streamed", async () => {
    const { draft, setDraft, records, textOf } = await setup("Intro. Outro.");
    await showComposer("Intro. Outro.", 7);

    delta("one", "item-a");
    setDraft("Intro. typed Outro.");
    complete("One.", "item-a");

    expect(draft()).toBe("Intro. typed One. Outro.");
    expect(textOf(records()[0]!.utterances[0]!.range)).toBe("One.");
  });

  it("flushes a stopped utterance at its spot mid-draft", async () => {
    const { service, draft, records, textOf } = await setup("Intro. Outro.");
    await showComposer("Intro. Outro.", 6);

    delta("half a");
    await service.stop("Dictation stopped.", { skipRemoteStop: true, preserveLiveText: true });

    expect(draft()).toBe("Intro. half a Outro.");
    expect(textOf(records()[0]!.utterances[0]!.range)).toBe("half a");
  });

  it("keeps the caret following the words through finals the composer hasn't shown yet", async () => {
    const { draft } = await setup("hello world");
    await showComposer("hello world", 5);

    complete("big");
    complete("red");

    expect(draft()).toBe("hello big red world");
    expect(await takeCaret(draft())).toEqual({ from: 13, to: 13 });
  });

  it("follows the words after a selection replaced by the same text", async () => {
    const { draft } = await setup("hello world");
    await showComposer("hello world", 6, 11);

    complete("world");
    complete("again");

    expect(draft()).toBe("hello world again");
    expect(await takeCaret(draft())).toEqual({ from: 17, to: 17 });
  });

  it("scratches words dictated mid-draft and puts the next ones in their place", async () => {
    const { draft, records, textOf } = await setup("A. B.");
    await showComposer("A. B.", 2);

    complete("one.");
    complete("scratch that");
    expect(draft()).toBe("A. B.");
    complete("two.");

    expect(draft()).toBe("A. two. B.");
    expect(records()[0]!.utterances.map((u) => textOf(u.range))).toContain("two.");
  });

  it("maps an earlier dictation onto its own copy of repeated text", async () => {
    const { draft, records, textOf } = await setup("foo");
    complete("foo");
    expect(draft()).toBe("foo foo");
    await showComposer("foo foo", 0);
    const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
    useVoiceRecordingStore
      .getState()
      .beginSession({ panelId: PANEL, projectId: PROJECT }, "session-2");

    callbacks.complete!({ sessionId: "session-2", text: "foo", willCorrect: false });

    expect(draft()).toBe("foo foo foo");
    const [first, second] = records();
    // The diff alone reads the write as an append and leaves the first range on 4-7.
    expect(first!.utterances[0]!.range).toEqual({ from: 8, to: 11, edited: false });
    expect(textOf(second!.utterances[0]!.range)).toBe("foo");
    expect(second!.utterances[0]!.range.from).toBe(0);
  });

  it("breaks the paragraph at the dictation's spot", async () => {
    const { draft, records, textOf } = await setup("Start. End.");
    await showComposer("Start. End.", 6);

    complete("One.");
    callbacks.boundary!({ sessionId: SESSION_ID, rawText: null });
    complete("Two.");

    expect(draft()).toBe("Start. One.\nTwo. End.");
    expect(records()[0]!.utterances.map((u) => textOf(u.range))).toEqual(["One.", "Two."]);
    expect(records()[0]!.range.edited).toBe(false);
  });

  it("drops the anchor when the session stops, keeping its record", async () => {
    const { service, records, sessionId } = await setup("abc");
    const { useDictationRangeStore } = await import("@/store/dictationRangeStore");
    const id = sessionId()!;

    complete("Done.");
    await service.stop("Dictation stopped.", { skipRemoteStop: true });

    expect(
      useDictationRangeStore
        .getState()
        .getAnchor({ sessionId: id, panelId: PANEL, projectId: PROJECT })
    ).toBeNull();
    expect(records()).toHaveLength(1);
  });
});

describe("VoiceRecordingService — correction and file links at the caret (#14634)", () => {
  async function showComposer(doc: string, anchor: number) {
    const { EditorState } = await import("@codemirror/state");
    const { recordComposerState } = await import("@/lib/composerCaret");
    recordComposerState(
      `${PROJECT}:${PANEL}`,
      {},
      EditorState.create({ doc, selection: { anchor } })
    );
  }

  it("corrects only the words dictated into the middle of the draft", async () => {
    const { service, voiceStore, draft } = await setup("Step one. Step three.");
    await showComposer("Step one. Step three.", 9);
    correct.fn.mockResolvedValue({ action: "replace", correctedText: "Step two." });
    voiceStore.getState().setCorrectionEnabled(true);

    complete("step two");
    await service.stop("Dictation stopped.");

    expect(correct.fn).toHaveBeenCalledWith({
      rawText: "step two",
      recentContext: ["Step one."],
      terminalId: "panel-1",
      sessionId: SESSION_ID,
      startsPrompt: false,
    });
    await vi.waitFor(() => expect(draft()).toBe("Step one. Step two. Step three."));
    expect(voiceStore.getState().panelBuffers[PANEL]!.sessionDraftStart).toBe(10);
  });

  it("links a file named in words dictated into the middle of the draft, and only there", async () => {
    const { draft } = await setup("Link to the readme file. Then");
    await showComposer("Link to the readme file. Then", 24);

    complete("link to the readme file", "item-a", "t1");
    fileReferences("t1", [{ description: "readme file", path: "README.md" }]);

    expect(draft()).toBe("Link to the readme file. @README.md Then");
  });
});
