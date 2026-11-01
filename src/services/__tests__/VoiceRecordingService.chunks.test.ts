import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCorrectionPace } from "@shared/types/ipc/api";

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

type CorrectResult = {
  action: "no_change" | "replace";
  correctedText: string;
  failed?: true;
  verdict?: "unchanged" | "failed" | "timed_out";
  pace?: VoiceCorrectionPace;
};
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
const prefetchCorrections =
  vi.fn<(payload: { sessionId: string; requests: CorrectRequest[] }) => Promise<void>>();
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
        onCorrectionProgress: on("progress"),
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
        getSettings: vi.fn(async () => ({
          enabled: true,
          openaiApiKey: "sk-key",
          correctionEnabled: true,
          correctionModel: "claude-haiku-5-5",
          dictionary: [],
        })),
        stop: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined),
        correct,
        prefetchCorrections,
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
  prefetchCorrections.mockReset().mockResolvedValue(undefined);
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

  it("cleans the finished part in the typing its composer shows, not the store's copy behind it (#15873)", async () => {
    const { service, inputStore, say, pause, draft, words, flush } = await setup();
    const chunk = deferred<CorrectResult>();
    correct.mockReturnValueOnce(chunk.promise);
    const landing = await import("@/services/voiceCorrectionLanding");

    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    expect(correct).toHaveBeenCalledTimes(1);
    const shown = `/review ${draft()}`;
    landing.registerComposerDraftWriter(PANEL, undefined, () =>
      inputStore.getState().setDraftInput(PANEL, shown)
    );

    chunk.resolve({ action: "replace", correctedText: CLEANED_OPENING });
    await flush();

    expect(draft()).toBe(`/review ${CLEANED_OPENING} ${NEXT}`);
    expect(words()).toHaveLength(OPENING.length + 1);
    expect(words().every(([, edited]) => edited === false)).toBe(true);
    expect(words()[0]![0]).toBe(
      "The deploy pipeline has been unreliable all week because the integration tests time out whenever the staging database is busy."
    );
    expect(service.hasPendingCorrection(PANEL)).toBe(false);
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
    ["a list starting", "First, the retries need a cap."],
  ])("doesn't cut where %s reaches back over the pause", async (_case, after) => {
    const { say, pause } = await setup();
    for (const sentence of OPENING) say(sentence);
    pause();
    say(after);
    expect(correct).not.toHaveBeenCalled();
  });

  it("keeps a list's introduction with its first item when the introduction announces a count", async () => {
    const { say, pause } = await setup();
    correct.mockResolvedValue({ action: "no_change", correctedText: "" });
    const intro = "We need three things.";
    const first = "Better retries and a dashboard.";

    for (const sentence of OPENING) say(sentence);
    say(intro);
    pause();
    say(first);
    expect(correct).not.toHaveBeenCalled();

    pause();
    say(NEXT);
    expect(correct).toHaveBeenCalledTimes(1);
    expect(correct).toHaveBeenLastCalledWith(
      expect.objectContaining({ rawText: [OPENING_TEXT, intro, first].join(" ") })
    );
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

    // The first press asks for a second (#14927).
    expect(service.handleEscape(PANEL)).toBe(true);
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

  it("spans a send's progress from the first pass out to the last pass's landing", async () => {
    const { service, say, pause, flush } = await setup();
    const chunk = deferred<CorrectResult>();
    const tail = deferred<CorrectResult>();
    correct.mockReturnValueOnce(chunk.promise).mockReturnValueOnce(tail.promise);
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    const chunkStartedAt = clock;
    expect(correct).toHaveBeenCalledTimes(1);
    const chunkLanding = service.expectedCorrectionWindow(PANEL)!;
    expect(chunkLanding.startedAt).toBe(chunkStartedAt);

    clock += 700;
    await service.stop();
    const tailStartedAt = clock;
    const both = service.expectedCorrectionWindow(PANEL)!;
    expect(both.startedAt).toBe(chunkStartedAt);
    expect(both.landsAt).toBeGreaterThanOrEqual(chunkLanding.landsAt);
    expect(both.landsAt).toBeGreaterThan(tailStartedAt);
    expect(service.expectedCorrectionWindow("panel-2")).toBeNull();

    chunk.resolve({ action: "replace", correctedText: CLEANED_OPENING });
    await flush();
    const tailLanding = service.expectedCorrectionWindow(PANEL)!;
    expect(tailLanding.startedAt).toBe(tailStartedAt);
    expect(both.landsAt).toBe(Math.max(chunkLanding.landsAt, tailLanding.landsAt));
    tail.resolve({ action: "no_change", correctedText: NEXT });
    await flush();
    expect(service.expectedCorrectionWindow(PANEL)).toBeNull();
  });

  it("estimates each pass on the cleanup model, and learns only from a reply that came back", async () => {
    const estimateCorrectionMs = vi.fn(
      (_model: string, _effort: string, chars: number) => 3 * chars
    );
    const recordCorrectionPace = vi.fn();
    vi.doMock("../voiceCorrectionPace", () => ({ estimateCorrectionMs, recordCorrectionPace }));
    try {
      const { service, say, pause, flush } = await setup();
      const pace: VoiceCorrectionPace = {
        model: "claude-haiku-5-5",
        effort: "medium",
        firstTextMs: 1_800,
        outputMs: 300,
      };
      correct
        .mockResolvedValueOnce({ action: "replace", correctedText: CLEANED_OPENING, pace })
        .mockResolvedValueOnce({ action: "no_change", correctedText: NEXT, failed: true, pace });
      for (const sentence of OPENING) say(sentence);
      pause();
      say(NEXT);
      const chunk = service.expectedCorrectionWindow(PANEL)!;
      const chunkChars = correct.mock.calls[0]![0].rawText.length;
      expect(chunk.landsAt - chunk.startedAt).toBe(3 * chunkChars);
      await flush();
      await service.stop();
      const tail = service.expectedCorrectionWindow(PANEL)!;
      expect(tail.landsAt - tail.startedAt).toBe(3 * correct.mock.calls[1]![0].rawText.length);
      await flush();

      expect(estimateCorrectionMs).toHaveBeenCalledWith(
        "claude-haiku-5-5",
        "medium",
        correct.mock.calls[0]![0].rawText.length
      );
      expect(recordCorrectionPace).toHaveBeenCalledTimes(1);
      expect(recordCorrectionPace).toHaveBeenCalledWith(
        correct.mock.calls[0]![0].rawText.length,
        pace
      );
    } finally {
      vi.doUnmock("../voiceCorrectionPace");
    }
  });

  it("lets Restore on a chunk that landed while recording move it within the stop's baseline", async () => {
    const { service, voiceStore, say, pause, draft, flush, baseline } = await setup();
    const { takeLandedCorrection, rebaseCorrectionBaseline } =
      await import("../voiceCorrectionLanding");
    correct.mockResolvedValueOnce({ action: "replace", correctedText: CLEANED_OPENING });
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    await flush();
    const landed = takeLandedCorrection(PANEL, undefined, draft());
    expect(landed?.baseline).toMatchObject({ raw: OPENING_TEXT, corrected: CLEANED_OPENING });
    // The session still running, whose review its words carry (#14875).
    expect(landed?.sessionId).toBe(voiceStore.getState().panelBuffers[PANEL]?.dictationSessionId);

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

  it("lets a chunked dictation's cleanup go when its draft was cleared before the stop", async () => {
    const { service, inputStore, say, pause, flush } = await setup();
    correct.mockResolvedValueOnce({ action: "replace", correctedText: CLEANED_OPENING });
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    await flush();
    expect(service).toHaveProperty("cleanups.size", 1);

    inputStore.getState().setDraftInput(PANEL, "");
    await service.stop();
    await flush();
    expect(correct).toHaveBeenCalledTimes(1);
    expect(service).toHaveProperty("cleanups.size", 0);
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

  it("gives a chunk whose cleanup failed back to the stop-time pass", async () => {
    const { service, sessionId, say, pause, draft, flush, baseline } = await setup();
    // A send following this dictation from its start: the stop's pass cleaned
    // what the chunk couldn't.
    const observed = service.observeSendCorrections(PANEL, new Set([sessionId]));
    correct.mockResolvedValueOnce({
      action: "no_change",
      correctedText: OPENING_TEXT,
      failed: true,
      verdict: "failed",
    });
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    await flush();
    expect(correct).toHaveBeenCalledTimes(1);
    expect(draft()).toBe(`${OPENING_TEXT} ${NEXT}`);

    correct.mockResolvedValueOnce({
      action: "replace",
      correctedText: `${CLEANED_OPENING} ${NEXT}`,
    });
    await service.stop();
    await flush();
    expect(correct).toHaveBeenCalledTimes(2);
    expect(correct).toHaveBeenLastCalledWith(
      expect.objectContaining({ rawText: `${OPENING_TEXT} ${NEXT}`, startsPrompt: true })
    );
    expect(draft()).toBe(`${CLEANED_OPENING} ${NEXT}`);
    expect(baseline()).toBe(`${CLEANED_OPENING} ${NEXT}`);
    expect(setHistoryCorrection).toHaveBeenCalledWith({
      id: expect.any(String),
      correctedText: `${CLEANED_OPENING} ${NEXT}`,
    });
    expect(observed.failed()).toBe(false);
  });

  it("cleans a chunk whose cleanup failed after the stop began in a pass of its own, which a send waits for", async () => {
    const { service, sessionId, say, pause, draft, flush, baseline } = await setup();
    const chunk = deferred<CorrectResult>();
    const tail = deferred<CorrectResult>();
    const retry = deferred<CorrectResult>();
    correct
      .mockReturnValueOnce(chunk.promise)
      .mockReturnValueOnce(tail.promise)
      .mockReturnValueOnce(retry.promise);
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    const observed = service.observeSendCorrections(PANEL, new Set([sessionId]));
    await service.stop();
    expect(correct).toHaveBeenCalledTimes(2);

    let sent = false;
    void service.waitForPendingCorrections(PANEL).then(() => (sent = true));
    const cleanedNext = "The other thing is the login redirect.";
    tail.resolve({ action: "replace", correctedText: cleanedNext });
    chunk.resolve({
      action: "no_change",
      correctedText: OPENING_TEXT,
      failed: true,
      verdict: "failed",
    });
    await flush();
    expect(correct).toHaveBeenCalledTimes(3);
    expect(correct).toHaveBeenLastCalledWith(
      expect.objectContaining({ rawText: OPENING_TEXT, startsPrompt: true })
    );
    expect(sent).toBe(false);
    expect(setHistoryCorrection).not.toHaveBeenCalled();
    // The retry took the failed chunk's words over.
    expect(observed.failed()).toBe(false);

    retry.resolve({ action: "replace", correctedText: CLEANED_OPENING });
    await flush();
    expect(sent).toBe(true);
    expect(observed.failed()).toBe(false);
    expect(draft()).toBe(`${CLEANED_OPENING} ${cleanedNext}`);
    expect(baseline()).toBe(`${CLEANED_OPENING} ${cleanedNext}`);
    expect(setHistoryCorrection).toHaveBeenCalledWith({
      id: expect.any(String),
      correctedText: `${CLEANED_OPENING} ${cleanedNext}`,
    });
  });

  it.each([
    ["failed", { failed: true, verdict: "failed" }, 3],
    ["timed out", { failed: true, verdict: "timed_out" }, 3],
    ["left as it was", { verdict: "unchanged" }, 2],
  ] as const)(
    "cleans a chunk %s after the stop began again only when it didn't land",
    async (_name, reply, calls) => {
      const { service, say, pause, flush } = await setup();
      const chunk = deferred<CorrectResult>();
      correct.mockReturnValueOnce(chunk.promise).mockImplementation(async ({ rawText }) => ({
        action: "no_change",
        correctedText: rawText,
      }));
      for (const sentence of OPENING) say(sentence);
      pause();
      say(NEXT);
      await service.stop();
      chunk.resolve({ action: "no_change", correctedText: OPENING_TEXT, ...reply });
      await flush();

      expect(correct.mock.calls.map(([request]) => request.rawText)).toEqual(
        [OPENING_TEXT, NEXT, OPENING_TEXT].slice(0, calls)
      );
    }
  );

  it("gives a chunk the draft couldn't take back to the stop-time pass", async () => {
    const { service, say, pause, draft, flush } = await setup();
    const { useDictationRangeStore } = await import("@/store/dictationRangeStore");
    const rewriteUtterances = useDictationRangeStore.getState().rewriteUtterances;
    useDictationRangeStore.setState({ rewriteUtterances: () => null });
    correct.mockResolvedValueOnce({ action: "replace", correctedText: CLEANED_OPENING });
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    await flush();
    useDictationRangeStore.setState({ rewriteUtterances });
    expect(draft()).toBe(`${OPENING_TEXT} ${NEXT}`);

    correct.mockResolvedValueOnce({ action: "no_change", correctedText: "" });
    await service.stop();
    expect(correct).toHaveBeenLastCalledWith(
      expect.objectContaining({ rawText: `${OPENING_TEXT} ${NEXT}` })
    );
  });

  it("doesn't clean a chunk again after a stop with cleanup turned off", async () => {
    const { service, voiceStore, say, pause, flush } = await setup();
    const chunk = deferred<CorrectResult>();
    correct.mockReturnValueOnce(chunk.promise);
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    voiceStore.getState().setCorrectionEnabled(false);
    await service.stop();
    chunk.resolve({
      action: "no_change",
      correctedText: OPENING_TEXT,
      failed: true,
      verdict: "failed",
    });
    await flush();

    expect(correct).toHaveBeenCalledTimes(1);
    expect(service.hasPendingCorrection(PANEL)).toBe(false);
  });

  it("cleans a failed chunk once more after the stop, and no more than that", async () => {
    const { service, sessionId, say, pause, draft, flush } = await setup();
    const chunk = deferred<CorrectResult>();
    correct
      .mockReturnValueOnce(chunk.promise)
      .mockImplementation(async ({ rawText }) =>
        rawText === NEXT
          ? { action: "no_change", correctedText: NEXT }
          : { action: "no_change", correctedText: rawText, failed: true }
      );
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    const observed = service.observeSendCorrections(PANEL, new Set([sessionId]));
    await service.stop();
    chunk.resolve({
      action: "no_change",
      correctedText: OPENING_TEXT,
      failed: true,
      verdict: "failed",
    });
    await flush();
    await flush();

    expect(correct.mock.calls.map(([request]) => request.rawText)).toEqual([
      OPENING_TEXT,
      NEXT,
      OPENING_TEXT,
    ]);
    expect(service.hasPendingCorrection(PANEL)).toBe(false);
    expect(draft()).toBe(`${OPENING_TEXT} ${NEXT}`);
    expect(setHistoryCorrection).not.toHaveBeenCalled();
    // The retry failed too: those words went uncleaned.
    expect(observed.failed()).toBe(true);
  });

  it("doesn't clean again a chunk a send took the draft from", async () => {
    const { service, say, pause, flush } = await setup();
    const chunk = deferred<CorrectResult>();
    correct
      .mockReturnValueOnce(chunk.promise)
      .mockResolvedValue({ action: "no_change", correctedText: NEXT });
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    await service.stop();
    service.discardPendingCorrections(PANEL);
    chunk.resolve({
      action: "no_change",
      correctedText: OPENING_TEXT,
      failed: true,
      verdict: "failed",
    });
    await flush();

    expect(correct).toHaveBeenCalledTimes(2);
    expect(service.hasPendingCorrection(PANEL)).toBe(false);
  });

  it("keeps a chunk cleanup's paragraph breaks through more dictation, the stop and the send", async () => {
    const { service, sessionId, say, pause, draft, record, flush, baseline } = await setup();
    const { planVoiceDraftSend } = await import("../voiceDraftSend");
    const { useDictationRangeStore } = await import("@/store/dictationRangeStore");
    const paragraphs = [
      OPENING.slice(0, 2).join(" ").replace("the deploy", "The deploy"),
      OPENING.slice(2).join(" "),
    ];
    const cleaned = paragraphs.join("\n\n");
    correct.mockResolvedValueOnce({ action: "replace", correctedText: cleaned });
    for (const sentence of OPENING) say(sentence);
    pause();
    say(NEXT);
    await flush();
    expect(draft()).toBe(`${cleaned} ${NEXT}`);

    const after = "It sends people back to the home page instead of the page they asked for.";
    say(after);
    expect(draft()).toBe(`${cleaned} ${NEXT} ${after}`);
    expect(record().utterances.every((u) => !u.range.edited)).toBe(true);

    const tail = `${NEXT} ${after}`;
    const cleanedTail = tail.replace("sends people back", "sends users back");
    correct.mockResolvedValueOnce({ action: "replace", correctedText: cleanedTail });
    await service.stop();
    expect(correct).toHaveBeenLastCalledWith(expect.objectContaining({ rawText: tail }));
    expect(await service.waitForPendingCorrections(PANEL)).toBe(true);
    await flush();

    const final = `${cleaned} ${cleanedTail}`;
    expect(draft()).toBe(final);
    expect(baseline()).toBe(final);
    const records = useDictationRangeStore.getState().listDictations(PANEL);
    expect(
      planVoiceDraftSend(
        { panelId: PANEL, projectId: undefined },
        draft(),
        records,
        new Set([sessionId])
      ).text
    ).toBe(final);
  });
});

describe("VoiceRecordingService — prefetching the stop's cleanup at a pause", () => {
  // Past the settle a pause's prefetch waits before it goes out.
  const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 200));

  it("sends main the cleanup request the stop will send, once the words settle", async () => {
    const { service, sessionId, say } = await setup();
    correct.mockResolvedValue({ action: "no_change", correctedText: "" });

    say("Run the tests.");
    expect(prefetchCorrections).not.toHaveBeenCalled();
    await settled();
    expect(prefetchCorrections).toHaveBeenCalledTimes(1);
    const prefetched = prefetchCorrections.mock.calls[0]![0];
    expect(prefetched).toEqual({
      sessionId,
      requests: [expect.objectContaining({ rawText: "Run the tests.", sessionId })],
    });

    await service.stop();
    expect(correct).toHaveBeenCalledTimes(1);
    const { streamId, ...sent } = correct.mock.calls[0]![0] as CorrectRequest & {
      streamId?: string;
    };
    expect(streamId).toEqual(expect.any(String));
    expect(sent).toEqual(prefetched.requests[0]);
  });

  it("waits 150ms after the last words, starting over when more land", async () => {
    const { say } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      say("Run the");
      vi.advanceTimersByTime(100);
      say("tests now.");
      vi.advanceTimersByTime(149);
      expect(prefetchCorrections).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(prefetchCorrections).toHaveBeenCalledTimes(1);
      expect(prefetchCorrections.mock.calls[0]![0].requests).toEqual([
        expect.objectContaining({ rawText: "Run the tests now." }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  // A pause main reports after the words landed changes what the stop sends (#14897).
  it("prefetches again once a pause with no words marks the words already there", async () => {
    const { service, sessionId, say } = await setup();
    correct.mockResolvedValue({ action: "no_change", correctedText: "" });

    say("Run the tests");
    await settled();
    emit("complete", { sessionId, text: "", willCorrect: false, pauses: [0] });
    await settled();
    expect(prefetchCorrections).toHaveBeenCalledTimes(2);
    const prefetched = prefetchCorrections.mock.calls[1]![0];
    expect(prefetched.requests).toEqual([
      expect.objectContaining({ rawText: "Run the tests", pauses: [13] }),
    ]);

    await service.stop();
    const { streamId: _streamId, ...sent } = correct.mock.calls[0]![0] as CorrectRequest & {
      streamId?: string;
    };
    expect(sent).toEqual(prefetched.requests[0]);
  });

  it("prefetches nothing while the stop drains, after the service goes, or with cleanup off", async () => {
    const { service, voiceStore, say } = await setup();

    say("Run the tests.");
    voiceStore.getState().setStatus("finishing");
    await settled();
    expect(prefetchCorrections).not.toHaveBeenCalled();

    voiceStore.getState().setStatus("recording");
    say("Then commit.");
    service.destroy();
    await settled();
    expect(prefetchCorrections).not.toHaveBeenCalled();
  });

  it("prefetches nothing with cleanup off", async () => {
    const { voiceStore, say } = await setup();
    voiceStore.getState().setCorrectionEnabled(false);

    say("Run the tests.");
    await settled();
    expect(prefetchCorrections).not.toHaveBeenCalled();
  });
});
