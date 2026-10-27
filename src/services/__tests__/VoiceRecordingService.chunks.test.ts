import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drives the real voice, draft and dictation-range stores through the IPC
// callbacks to prove a long dictation is cleaned up in chunks while it runs
// (#14772): a chunk closes at a natural break, lands mid-session as the
// session's own words, and the stop-time pass covers only what came after.

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

type CorrectResult = { action: "no_change" | "replace"; correctedText: string; failed?: true };
type CorrectRequest = { rawText: string; recentContext?: string[]; sessionId?: string };
type Listener = (payload: never) => void;

const PANEL = "panel-1";

// Five finished sentences, past the length a dictation needs before a chunk
// of it is cleaned on its own.
const OPENING = [
  "the deploy pipeline has been flaky all week because the integration tests time out whenever the staging database is busy.",
  "Most of the failures come from the nightly import job, which locks the orders table for minutes while it rebuilds indexes.",
  "We could move the import to an earlier slot, or split it into batches so the lock never lasts long enough to matter.",
  "Either way the tests should retry a connection once before they give up, since one slow query shouldn't fail a whole build.",
  "I'd also like the dashboard to show how long each stage waited on the database so we can see it coming next time around.",
];
const OPENING_TEXT = OPENING.join(" ");
const CLEANED_OPENING = OPENING_TEXT.replace("the deploy", "The deploy").replace(
  "flaky",
  "unreliable"
);
const NEXT = "The other thing on my list is the login redirect.";

const callbacks = new Map<string, Listener>();
const correct = vi.fn<(request: CorrectRequest) => Promise<CorrectResult>>();
const recordHistory = vi.fn();
const setHistoryCorrection = vi.fn();
let clock = 1_000;

function stubElectron() {
  const on = (name: string) =>
    vi.fn((cb: Listener) => {
      callbacks.set(name, cb);
      return () => {};
    });
  vi.stubGlobal("window", {
    electron: {
      voiceInput: {
        onTranscriptionDelta: on("delta"),
        onTranscriptionComplete: on("complete"),
        onParagraphBoundary: on("boundary"),
        onFileTokenResolved: on("fileToken"),
        onError: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
        onSessionEnded: vi.fn(() => () => {}),
        onLiveSession: vi.fn(() => () => {}),
        onStopRequested: vi.fn(() => () => {}),
        onRevealRequested: vi.fn(() => () => {}),
        getLiveSession: vi.fn().mockResolvedValue({ revision: 0, session: null }),
        getSettings: vi.fn(async () => ({
          enabled: true,
          openaiApiKey: "sk-key",
          correctionEnabled: true,
          dictionary: [],
        })),
        stop: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined),
        correct,
      },
      recentDictations: { record: recordHistory, setCorrectedText: setHistoryCorrection },
      systemSleep: { onSuspend: vi.fn(() => () => {}), onWake: vi.fn(() => () => {}) },
    },
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const emit = (name: string, payload: unknown) =>
  (callbacks.get(name) as ((payload: unknown) => void) | undefined)!(payload);

let unsubscribeRanges: (() => void) | null = null;

async function setup() {
  stubElectron();
  const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
  const { useTerminalInputStore } = await import("@/store/terminalInputStore");
  const { useDictationRangeStore, subscribeDictationRangeTracking } =
    await import("@/store/dictationRangeStore");
  const { voiceRecordingService } = await import("../VoiceRecordingService");
  unsubscribeRanges = subscribeDictationRangeTracking();
  voiceRecordingService.initialize();
  await voiceRecordingService.refreshConfiguration();

  useVoiceRecordingStore.getState().beginSession({ panelId: PANEL });
  useVoiceRecordingStore.getState().setStatus("recording");
  const sessionId = useVoiceRecordingStore.getState().panelBuffers[PANEL]!.dictationSessionId!;

  let itemSeq = 0;
  /** One utterance the way a provider delivers it: a delta, then its completion. */
  const say = (text: string, transcriptId?: string) => {
    const itemId = `item-${++itemSeq}`;
    emit("delta", { sessionId, text, itemId });
    emit("complete", {
      sessionId,
      text,
      willCorrect: false,
      itemId,
      ...(transcriptId ? { transcriptId } : {}),
    });
  };
  /** Quiet long enough to read as a pause. */
  const pause = (ms = 2_000) => {
    clock += ms;
  };
  const draft = () => useTerminalInputStore.getState().getDraftInput(PANEL);
  const record = () => useDictationRangeStore.getState().listDictations(PANEL)[0]!;
  const words = () =>
    record().utterances.map((u) => [draft().slice(u.range.from, u.range.to), u.range.edited]);
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const baseline = () =>
    useVoiceRecordingStore.getState().panelBuffers[PANEL]?.sessionCorrectedText;
  return {
    service: voiceRecordingService,
    voiceStore: useVoiceRecordingStore,
    inputStore: useTerminalInputStore,
    sessionId,
    say,
    pause,
    draft,
    record,
    words,
    flush,
    baseline,
  };
}

beforeEach(() => {
  vi.resetModules();
  callbacks.clear();
  correct.mockReset();
  recordHistory.mockReset();
  setHistoryCorrection.mockReset();
  clock = 1_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(() => {
  unsubscribeRanges?.();
  unsubscribeRanges = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("VoiceRecordingService — cleaning up a long dictation in chunks (#14772)", () => {
  it("cleans the finished part while recording and leaves only the rest for stop", async () => {
    expect(OPENING_TEXT.length).toBeGreaterThanOrEqual(600);
    const { service, voiceStore, sessionId, say, pause, draft, words, flush } = await setup();
    const chunk = deferred<CorrectResult>();
    correct.mockReturnValueOnce(chunk.promise);

    for (const sentence of OPENING) say(sentence);
    expect(correct).not.toHaveBeenCalled();
    pause();
    say(NEXT);

    expect(correct).toHaveBeenCalledTimes(1);
    expect(correct).toHaveBeenLastCalledWith(
      expect.objectContaining({ rawText: OPENING_TEXT, sessionId, startsPrompt: true })
    );
    expect(service.hasPendingCorrection(PANEL)).toBe(true);

    chunk.resolve({ action: "replace", correctedText: CLEANED_OPENING });
    await flush();

    expect(voiceStore.getState().status).toBe("recording");
    expect(draft()).toBe(`${CLEANED_OPENING} ${NEXT}`);
    // Still the session's own words, each utterance on its own.
    expect(words()).toHaveLength(OPENING.length + 1);
    expect(words().every(([, edited]) => edited === false)).toBe(true);
    expect(words()[0]![0]).toBe(
      "The deploy pipeline has been unreliable all week because the integration tests time out whenever the staging database is busy."
    );

    correct.mockResolvedValueOnce({ action: "no_change", correctedText: NEXT });
    await service.stop();
    expect(correct).toHaveBeenCalledTimes(2);
    expect(correct).toHaveBeenLastCalledWith(
      expect.objectContaining({ rawText: NEXT, startsPrompt: false })
    );
  });

  it("keeps a short dictation to the one pass at stop", async () => {
    const { service, say, pause } = await setup();
    correct.mockResolvedValue({ action: "no_change", correctedText: "" });

    say(OPENING[0]!);
    pause();
    say(OPENING[1]!);
    pause();
    say(NEXT);
    expect(correct).not.toHaveBeenCalled();

    await service.stop();
    expect(correct).toHaveBeenCalledTimes(1);
    expect(correct).toHaveBeenLastCalledWith(
      expect.objectContaining({ rawText: [OPENING[0], OPENING[1], NEXT].join(" ") })
    );
  });

  it("never cuts between segments that came without a pause", async () => {
    const { say } = await setup();
    for (const sentence of [...OPENING, NEXT]) say(sentence);
    expect(correct).not.toHaveBeenCalled();
  });

  it.each([
    ["a self-correction", "No wait, it's the reporting database that's busy."],
    ["a correction of what was meant", "I meant the reporting database."],
    ["a list going on", "Second, the retries need a cap."],
  ])("doesn't cut where %s reaches back over the pause", async (_case, after) => {
    const { say, pause } = await setup();
    for (const sentence of OPENING) say(sentence);
    pause();
    say(after);
    expect(correct).not.toHaveBeenCalled();
  });

  it("doesn't cut on too little said after a break, even once a newer pause replaces it", async () => {
    const { say, pause } = await setup();
    for (const sentence of OPENING) say(sentence);
    pause();
    say("I");
    pause();
    say("mean the reporting database is the busy one.");
    expect(correct).not.toHaveBeenCalled();
  });

  it("cuts at a spoken paragraph break", async () => {
    const { sessionId, say } = await setup();
    correct.mockReturnValue(new Promise(() => {}));
    for (const sentence of OPENING) say(sentence);
    emit("boundary", { sessionId, rawText: null });
    say(NEXT);
    expect(correct).toHaveBeenCalledTimes(1);
    expect(correct).toHaveBeenLastCalledWith(expect.objectContaining({ rawText: OPENING_TEXT }));
  });

  it("waits for a transcript's file links before cutting a chunk that holds it", async () => {
    const { sessionId, say, pause } = await setup();
    correct.mockReturnValue(new Promise(() => {}));
    for (const sentence of OPENING.slice(0, -1)) say(sentence);
    say(OPENING[OPENING.length - 1]!, "transcript-1");
    pause();
    say(NEXT);
    expect(correct).not.toHaveBeenCalled();

    emit("fileToken", {
      sessionId,
      transcriptId: "transcript-1",
      references: [{ description: "the readme", path: null }],
    });
    expect(correct).toHaveBeenCalledTimes(1);
  });

  it("scratches just the last cleaned utterance, and its segment from the history", async () => {
    const { voiceStore, say, pause, draft, flush } = await setup();
    correct.mockResolvedValueOnce({ action: "replace", correctedText: CLEANED_OPENING });
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    await flush();
    expect(draft()).toBe(`${CLEANED_OPENING} ${NEXT}`);

    say("Scratch that.");
    say("Scratch that.");
    expect(draft()).toBe(CLEANED_OPENING.slice(0, -OPENING[4]!.length - 1));
    expect(voiceStore.getState().panelBuffers[PANEL]!.completedSegments).toEqual(
      OPENING.slice(0, 4)
    );
  });

  it("scratches every segment a cleanup ran together", async () => {
    const { voiceStore, say, pause, draft, flush } = await setup();
    // The cleanup rewrites the words either side of the last cut, so the last
    // two utterances can no longer be told apart.
    const joined = CLEANED_OPENING.replace("whole build. I'd", "whole build, and I'd");
    correct.mockResolvedValueOnce({ action: "replace", correctedText: joined });
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    await flush();
    expect(draft()).toBe(`${joined} ${NEXT}`);

    say("Scratch that.");
    say("Scratch that.");
    expect(draft()).toBe(joined.slice(0, joined.indexOf(" Either way")));
    expect(voiceStore.getState().panelBuffers[PANEL]!.completedSegments).toEqual(
      OPENING.slice(0, 3)
    );
  });

  it("takes every word back out on Escape after a chunk landed", async () => {
    const { service, say, pause, draft, flush } = await setup();
    correct.mockResolvedValueOnce({ action: "replace", correctedText: CLEANED_OPENING });
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    await flush();

    expect(service.handleEscape(PANEL)).toBe(true);
    expect(draft()).toBe("");
  });

  it("gives a chunk an edit reached back to the stop-time pass, minus the edited words", async () => {
    const { service, inputStore, say, pause, draft, flush } = await setup();
    const chunk = deferred<CorrectResult>();
    correct.mockReturnValueOnce(chunk.promise);
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    expect(correct).toHaveBeenCalledTimes(1);

    inputStore.getState().setDraftInput(PANEL, draft().replace("nightly", "weekly"));
    chunk.resolve({ action: "replace", correctedText: CLEANED_OPENING });
    await flush();
    expect(draft()).not.toContain("unreliable");

    correct.mockResolvedValue({ action: "no_change", correctedText: "" });
    await service.stop();
    expect(correct.mock.calls.slice(1).map(([request]) => request.rawText)).toEqual([
      OPENING[0],
      [...OPENING.slice(2), NEXT].join(" "),
    ]);
  });

  it("waits a send for a chunk still on its way as well as the stop-time pass", async () => {
    const { service, say, pause, flush } = await setup();
    const chunk = deferred<CorrectResult>();
    const tail = deferred<CorrectResult>();
    correct.mockReturnValueOnce(chunk.promise).mockReturnValueOnce(tail.promise);
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    await service.stop();

    let landed = false;
    void service.waitForPendingCorrections(PANEL).then(() => (landed = true));
    tail.resolve({ action: "no_change", correctedText: NEXT });
    await flush();
    expect(landed).toBe(false);
    chunk.resolve({ action: "replace", correctedText: CLEANED_OPENING });
    await flush();
    expect(landed).toBe(true);
  });

  it("lets Restore on a chunk that landed while recording move it within the stop's baseline", async () => {
    const { service, say, pause, draft, flush, baseline } = await setup();
    const { takeLandedCorrection, rebaseCorrectionBaseline } =
      await import("../voiceCorrectionLanding");
    correct.mockResolvedValueOnce({ action: "replace", correctedText: CLEANED_OPENING });
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    await flush();
    const landed = takeLandedCorrection(PANEL, undefined, draft());
    expect(landed?.baseline).toMatchObject({ raw: OPENING_TEXT, corrected: CLEANED_OPENING });

    correct.mockResolvedValueOnce({ action: "no_change", correctedText: NEXT });
    await service.stop();
    await flush();
    expect(baseline()).toBe(`${CLEANED_OPENING} ${NEXT}`);

    rebaseCorrectionBaseline(PANEL, landed!, "raw");
    expect(baseline()).toBe(`${OPENING_TEXT} ${NEXT}`);
  });

  it("still folds the stop-time pass in after a Restore moved a chunk meanwhile", async () => {
    const { service, say, pause, draft, flush, baseline } = await setup();
    const { takeLandedCorrection, rebaseCorrectionBaseline } =
      await import("../voiceCorrectionLanding");
    const tail = deferred<CorrectResult>();
    correct
      .mockResolvedValueOnce({ action: "replace", correctedText: CLEANED_OPENING })
      .mockReturnValueOnce(tail.promise);
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    await flush();
    const landed = takeLandedCorrection(PANEL, undefined, draft());
    await service.stop();

    rebaseCorrectionBaseline(PANEL, landed!, "raw");
    expect(baseline()).toBe(`${OPENING_TEXT} ${NEXT}`);
    tail.resolve({ action: "replace", correctedText: "The other thing is the login redirect." });
    await flush();
    expect(baseline()).toBe(`${OPENING_TEXT} The other thing is the login redirect.`);
  });

  it("gives a chunk of several passages one baseline stretch, unchanged ones included", async () => {
    const { service, inputStore, say, pause, draft, record, flush, baseline } = await setup();
    const { takeLandedCorrection, rebaseCorrectionBaseline } =
      await import("../voiceCorrectionLanding");
    for (const sentence of OPENING) say(sentence);
    // Typed after the second and third sentences, so the chunk reads as three passages.
    for (const index of [2, 1]) {
      const at = record().utterances[index]!.range.to;
      inputStore
        .getState()
        .setDraftInput(PANEL, `${draft().slice(0, at)} (typed)${draft().slice(at)}`);
    }
    const first = `${OPENING[0]} ${OPENING[1]}`;
    const second = OPENING[2]!;
    const third = `${OPENING[3]} ${OPENING[4]}`;
    const cleaned = new Map([
      [first, first.replace("flaky", "unreliable")],
      [third, third.replace("whole build", "full build")],
    ]);
    correct.mockImplementation(async ({ rawText }) =>
      cleaned.has(rawText)
        ? { action: "replace", correctedText: cleaned.get(rawText)! }
        : { action: "no_change", correctedText: rawText }
    );
    pause();
    say(NEXT);
    expect(correct.mock.calls.map(([request]) => request.rawText)).toEqual([first, second, third]);
    await flush();
    const landed = takeLandedCorrection(PANEL, undefined, draft());
    expect(landed?.baseline).toMatchObject({
      raw: [first, second, third].join(" "),
      corrected: [cleaned.get(first), second, cleaned.get(third)].join(" "),
    });

    await service.stop();
    await flush();
    rebaseCorrectionBaseline(PANEL, landed!, "raw");
    expect(baseline()).toBe([first, second, third, NEXT].join(" "));
  });

  it("keeps no cleaned text in the history when a pass failed", async () => {
    const { service, say, pause, flush } = await setup();
    correct
      .mockResolvedValueOnce({ action: "replace", correctedText: CLEANED_OPENING })
      .mockResolvedValueOnce({ action: "no_change", correctedText: NEXT, failed: true });
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    await flush();
    await service.stop();
    await flush();

    expect(recordHistory).toHaveBeenCalledTimes(1);
    expect(setHistoryCorrection).not.toHaveBeenCalled();
  });

  it("folds passes into the baseline whichever lands first after the stop", async () => {
    const { service, say, pause, flush, baseline } = await setup();
    const chunk = deferred<CorrectResult>();
    const tail = deferred<CorrectResult>();
    correct.mockReturnValueOnce(chunk.promise).mockReturnValueOnce(tail.promise);
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    await service.stop();

    chunk.resolve({ action: "replace", correctedText: CLEANED_OPENING });
    await flush();
    expect(baseline()).toBe(`${CLEANED_OPENING} ${NEXT}`);
    tail.resolve({ action: "replace", correctedText: "The other thing is the login redirect." });
    await flush();
    expect(baseline()).toBe(`${CLEANED_OPENING} The other thing is the login redirect.`);
  });

  it("keeps the whole dictation's cleaned text in the history and the learning baseline", async () => {
    const { service, say, pause, flush, baseline } = await setup();
    const chunk = deferred<CorrectResult>();
    const tail = deferred<CorrectResult>();
    correct.mockReturnValueOnce(chunk.promise).mockReturnValueOnce(tail.promise);
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    await service.stop();
    await flush();

    expect(recordHistory).toHaveBeenCalledWith(
      expect.objectContaining({ rawText: `${OPENING_TEXT} ${NEXT}`, correctedText: null })
    );
    expect(baseline()).toBe(`${OPENING_TEXT} ${NEXT}`);

    tail.resolve({ action: "replace", correctedText: "The other thing is the login redirect." });
    await flush();
    expect(baseline()).toBe(`${OPENING_TEXT} The other thing is the login redirect.`);
    expect(setHistoryCorrection).not.toHaveBeenCalled();

    chunk.resolve({ action: "replace", correctedText: CLEANED_OPENING });
    await flush();
    expect(baseline()).toBe(`${CLEANED_OPENING} The other thing is the login redirect.`);
    expect(setHistoryCorrection).toHaveBeenCalledWith({
      id: expect.any(String),
      correctedText: `${CLEANED_OPENING} The other thing is the login redirect.`,
    });
  });
});
