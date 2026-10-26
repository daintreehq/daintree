import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drives the real voice and draft stores through stop() to prove a post-stop
// correction belongs to its own session and panel (#14611): another session
// starting doesn't discard it, and a draft that was sent or cleared never
// receives it.

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

type DeltaPayload = { text: string; itemId?: string };
type CompletePayload = { text: string; willCorrect: boolean; itemId?: string; heard?: string };
type CorrectResult = { action: "no_change" | "replace"; correctedText: string };

const callbacks: {
  delta: ((payload: DeltaPayload) => void) | null;
  complete: ((payload: CompletePayload) => void) | null;
  boundary: ((payload: { rawText: string | null }) => void) | null;
} = { delta: null, complete: null, boundary: null };

const correct =
  vi.fn<
    (request: {
      rawText: string;
      recentContext?: string[];
      terminalId?: string;
    }) => Promise<CorrectResult>
  >();

let dictionary: Array<{ term: string; heardAs: string[]; source: "manual"; addedAt: number }> = [];

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
      onParagraphBoundary: vi.fn((cb: (payload: { rawText: string | null }) => void) => {
        callbacks.boundary = cb;
        return () => {};
      }),
      onFileTokenResolved: vi.fn(() => () => {}),
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
        dictionary,
      })),
      stop: vi.fn().mockResolvedValue(undefined),
      correct,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function setup() {
  stubElectron();
  const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
  const { useTerminalInputStore } = await import("@/store/terminalInputStore");
  const { subscribeDictationRangeTracking } = await import("@/store/dictationRangeStore");
  const { voiceRecordingService } = await import("../VoiceRecordingService");
  // The store orchestrator keeps dictation ranges on their text in the app;
  // correction finds its passages through them.
  unsubscribeRanges = subscribeDictationRangeTracking();
  voiceRecordingService.initialize();
  await voiceRecordingService.refreshConfiguration();
  expect(useVoiceRecordingStore.getState().correctionEnabled).toBe(true);

  let itemSeq = 0;
  // One utterance through the real transcription handlers, the way a provider
  // delivers it: a delta, then its completion.
  const say = (text: string, heard?: string) => {
    const itemId = `item-${++itemSeq}`;
    callbacks.delta!({ text: heard ?? text, itemId });
    callbacks.complete!({ text, willCorrect: false, itemId, ...(heard ? { heard } : {}) });
  };
  const dictate = (panelId: string, text: string, heard?: string) => {
    useVoiceRecordingStore.getState().beginSession({ panelId });
    say(text, heard);
  };
  const draft = (panelId: string) => useTerminalInputStore.getState().getDraftInput(panelId);
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const baseline = (panelId: string) =>
    useVoiceRecordingStore.getState().panelBuffers[panelId]?.sessionCorrectedText;

  return {
    service: voiceRecordingService,
    voiceStore: useVoiceRecordingStore,
    baseline,
    inputStore: useTerminalInputStore,
    say,
    dictate,
    draft,
    flush,
  };
}

let unsubscribeRanges: (() => void) | null = null;

describe("VoiceRecordingService — post-stop correction ownership (#14611)", () => {
  beforeEach(() => {
    vi.resetModules();
    callbacks.delta = null;
    callbacks.complete = null;
    callbacks.boundary = null;
    correct.mockReset();
    dictionary = [];
  });

  afterEach(() => {
    unsubscribeRanges?.();
    unsubscribeRanges = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lands a correction after a session on another panel starts and stops", async () => {
    const { service, dictate, draft, flush } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);
    correct.mockResolvedValueOnce({ action: "no_change", correctedText: "second thought" });

    dictate("panel-1", "fix the bug in the parsr");
    await service.stop();
    expect(correct).toHaveBeenLastCalledWith({
      rawText: "fix the bug in the parsr",
      terminalId: "panel-1",
    });

    dictate("panel-2", "second thought");
    await service.stop();
    expect(correct).toHaveBeenLastCalledWith({ rawText: "second thought", terminalId: "panel-2" });

    first.resolve({ action: "replace", correctedText: "Fix the bug in the parser." });
    await flush();

    expect(draft("panel-1")).toBe("Fix the bug in the parser.");
    expect(draft("panel-2")).toBe("second thought");
  });

  it("lands the finished passage's correction while dictation restarts on the same panel", async () => {
    const { service, dictate, say, draft, flush, baseline } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);
    correct.mockResolvedValueOnce({ action: "no_change", correctedText: "and the lexer" });

    dictate("panel-1", "um so the parser is brken");
    await service.stop();

    dictate("panel-1", "and the");
    first.resolve({ action: "replace", correctedText: "So the parser is broken." });
    await flush();
    expect(draft("panel-1")).toBe("So the parser is broken. and the");
    // The restarted session owns the panel's learning baseline now.
    expect(baseline("panel-1")).toBeNull();

    // The restarted session's own text still lines up after the earlier
    // passage changed length under it.
    say("lexer");
    expect(draft("panel-1")).toBe("So the parser is broken. and the lexer");
    await service.stop();
    expect(correct).toHaveBeenLastCalledWith({
      rawText: "and the lexer",
      recentContext: ["So the parser is broken."],
      terminalId: "panel-1",
    });
    await flush();
    expect(baseline("panel-1")).toBe("and the lexer");
  });

  it("lands both passages when a same-panel restart stops before the first correction returns", async () => {
    const { service, dictate, draft, flush, baseline } = await setup();
    const first = deferred<CorrectResult>();
    const second = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);
    correct.mockReturnValueOnce(second.promise);

    dictate("panel-1", "um so the parser is brken");
    await service.stop();
    dictate("panel-1", "and the lexr too");
    await service.stop();
    expect(correct).toHaveBeenLastCalledWith({
      rawText: "and the lexr too",
      recentContext: ["um so the parser is brken"],
      terminalId: "panel-1",
    });

    first.resolve({ action: "replace", correctedText: "So the parser is broken." });
    await flush();
    expect(baseline("panel-1")).toBe("and the lexr too");
    second.resolve({ action: "replace", correctedText: "And the lexer too." });
    await flush();
    expect(baseline("panel-1")).toBe("And the lexer too.");

    expect(draft("panel-1")).toBe("So the parser is broken. And the lexer too.");
    expect(service.hasPendingCorrection("panel-1")).toBe(false);
  });

  it("never applies a correction to a draft that was cleared, even with the same words", async () => {
    const { service, dictate, draft, flush, inputStore } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    dictate("panel-1", "hello wrld");
    await service.stop();

    inputStore.getState().clearDraftInput("panel-1");
    inputStore.getState().setDraftInput("panel-1", "hello wrld");

    first.resolve({ action: "replace", correctedText: "Hello world." });
    await flush();

    expect(draft("panel-1")).toBe("hello wrld");
  });

  it("lands the second passage first when its correction returns sooner", async () => {
    const { service, dictate, draft, flush } = await setup();
    const first = deferred<CorrectResult>();
    const second = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);
    correct.mockReturnValueOnce(second.promise);

    dictate("panel-1", "the parsr");
    await service.stop();
    dictate("panel-1", "and the lexr");
    await service.stop();

    second.resolve({ action: "replace", correctedText: "and the lexer" });
    await flush();
    first.resolve({ action: "replace", correctedText: "The parser" });
    await flush();

    expect(draft("panel-1")).toBe("The parser and the lexer");
  });

  it("keeps an unfinished provider utterance aligned when the earlier passage lands", async () => {
    const { service, dictate, draft, flush, voiceStore } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    dictate("panel-1", "the parsr");
    await service.stop();

    // Deepgram-style unidentified deltas anchor the utterance by offset, and a
    // correction that lengthens the passage would otherwise cut into it.
    voiceStore.getState().beginSession({ panelId: "panel-1" });
    callbacks.delta!({ text: "and the" });
    first.resolve({ action: "replace", correctedText: "The parser." });
    await flush();
    callbacks.complete!({ text: "and the lexer", willCorrect: false });

    expect(draft("panel-1")).toBe("The parser. and the lexer");
    correct.mockResolvedValueOnce({ action: "no_change", correctedText: "and the lexer" });
    await service.stop();
    expect(correct).toHaveBeenLastCalledWith({
      rawText: "and the lexer",
      recentContext: ["The parser."],
      terminalId: "panel-1",
    });
  });

  it("keeps a passage's trailing break out of its correction, so a restart stays aligned", async () => {
    const { service, dictate, draft, flush, voiceStore } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    dictate("panel-1", "the parsr");
    callbacks.boundary!({ rawText: null });
    await service.stop();
    expect(correct).toHaveBeenLastCalledWith({ rawText: "the parsr", terminalId: "panel-1" });

    voiceStore.getState().beginSession({ panelId: "panel-1" });
    callbacks.delta!({ text: "and the" });
    first.resolve({ action: "replace", correctedText: "The parser." });
    await flush();
    callbacks.complete!({ text: "and the lexer", willCorrect: false });
    expect(draft("panel-1")).toBe("The parser.\nand the lexer");

    correct.mockResolvedValueOnce({ action: "no_change", correctedText: "and the lexer" });
    await service.stop();
    expect(correct).toHaveBeenLastCalledWith({
      rawText: "and the lexer",
      recentContext: ["The parser.\n"],
      terminalId: "panel-1",
    });
  });

  it("moves the passage with typing before it and still lands the correction", async () => {
    const { service, dictate, draft, flush, inputStore } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    inputStore.getState().setDraftInput("panel-1", "note:");
    dictate("panel-1", "the parsr");
    await service.stop();

    inputStore.getState().setDraftInput("panel-1", "my note: the parsr");
    first.resolve({ action: "replace", correctedText: "the parser" });
    await flush();

    expect(draft("panel-1")).toBe("my note: the parser");
  });

  it("drops a correction whose passage was edited, even when a copy survives elsewhere", async () => {
    const { service, dictate, draft, flush, inputStore } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    inputStore.getState().setDraftInput("panel-1", "the parsr");
    dictate("panel-1", "the parsr");
    await service.stop();

    inputStore.getState().setDraftInput("panel-1", "the parsr the parser");
    expect(service.hasPendingCorrection("panel-1")).toBe(false);

    // Undoing the edit doesn't bring the dropped correction back.
    inputStore.getState().setDraftInput("panel-1", "the parsr the parsr");
    first.resolve({ action: "replace", correctedText: "the parser" });
    await flush();

    expect(draft("panel-1")).toBe("the parsr the parsr");
  });

  it("releases a waiter as soon as the draft is cleared", async () => {
    const { service, dictate, inputStore } = await setup();
    correct.mockReturnValueOnce(new Promise<CorrectResult>(() => {}));

    dictate("panel-1", "hello wrld");
    await service.stop();

    const waited = service.waitForPendingCorrections("panel-1", 60_000);
    inputStore.getState().clearDraftInput("panel-1");
    await expect(waited).resolves.toBe(true);
    expect(service.hasPendingCorrection("panel-1")).toBe(false);
  });

  it("waits for a pending correction and reports when it lands", async () => {
    const { service, dictate, draft, flush } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    dictate("panel-1", "hello wrld");
    await service.stop();
    expect(service.hasPendingCorrection("panel-1")).toBe(true);
    expect(service.hasPendingCorrection("panel-2")).toBe(false);

    let settled = false;
    const waited = service.waitForPendingCorrections("panel-1", 2000);
    void waited.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    first.resolve({ action: "replace", correctedText: "Hello world." });
    await expect(waited).resolves.toBe(true);

    expect(draft("panel-1")).toBe("Hello world.");
    expect(service.hasPendingCorrection("panel-1")).toBe(false);
  });

  it("stops waiting at the cap and drops a correction discarded by the send", async () => {
    const { service, dictate, draft, flush } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    dictate("panel-1", "hello wrld");
    await service.stop();

    vi.useFakeTimers();
    let settled = false;
    const waited = service.waitForPendingCorrections("panel-1", 2000);
    void waited.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waited).resolves.toBe(false);
    vi.useRealTimers();

    service.discardPendingCorrections("panel-1");
    expect(service.hasPendingCorrection("panel-1")).toBe(false);

    first.resolve({ action: "replace", correctedText: "Hello world." });
    await flush();
    expect(draft("panel-1")).toBe("hello wrld");
  });

  it("keeps waiting for a correction registered on the panel while it waits", async () => {
    const { service, dictate } = await setup();
    const first = deferred<CorrectResult>();
    const second = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);
    correct.mockReturnValueOnce(second.promise);

    dictate("panel-1", "the parsr");
    await service.stop();
    let settled = false;
    const waited = service.waitForPendingCorrections("panel-1", 2000);
    void waited.then(() => {
      settled = true;
    });

    dictate("panel-1", "and the lexr");
    await service.stop();
    first.resolve({ action: "replace", correctedText: "The parser" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    second.resolve({ action: "replace", correctedText: "and the lexer" });
    await expect(waited).resolves.toBe(true);
  });

  it("keeps the learning baseline with its own passage when two say the same words", async () => {
    const { service, dictate, flush, baseline } = await setup();
    const first = deferred<CorrectResult>();
    const second = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);
    correct.mockReturnValueOnce(second.promise);

    dictate("panel-1", "zoo stand");
    await service.stop();
    dictate("panel-1", "zoo stand");
    await service.stop();

    first.resolve({ action: "replace", correctedText: "Zustand" });
    await flush();
    expect(baseline("panel-1")).toBe("zoo stand");

    second.resolve({ action: "no_change", correctedText: "zoo stand" });
    await flush();
    expect(baseline("panel-1")).toBe("zoo stand");
  });

  it("leaves a baseline seeded without correction to its own passage", async () => {
    const { service, dictate, flush, baseline, voiceStore } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    dictate("panel-1", "versel");
    await service.stop();
    voiceStore.getState().setCorrectionEnabled(false);
    dictate("panel-1", "versel");
    await service.stop();
    expect(baseline("panel-1")).toBe("versel");

    first.resolve({ action: "replace", correctedText: "Vercel" });
    await flush();
    expect(baseline("panel-1")).toBe("versel");
  });

  it("clears the underline and drops pending corrections when the service is torn down", async () => {
    const { service, dictate, draft, flush, voiceStore } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    dictate("panel-1", "hello wrld");
    await service.stop();
    expect(voiceStore.getState().panelBuffers["panel-1"]?.correctionRanges).toEqual([
      { from: 0, to: 10 },
    ]);

    service.destroy();
    expect(voiceStore.getState().panelBuffers["panel-1"]?.correctionRanges).toEqual([]);

    first.resolve({ action: "replace", correctedText: "Hello world." });
    await flush();
    expect(draft("panel-1")).toBe("hello wrld");
  });

  describe("heard-as rules at stop", () => {
    const rule = (term: string, ...heardAs: string[]) => ({
      term,
      heardAs,
      source: "manual" as const,
      addedAt: 0,
    });

    it("catches a phrase split across utterances before correction sees the passage", async () => {
      dictionary = [rule("Zustand", "zoo stand")];
      const { service, dictate, say, draft, flush } = await setup();
      const result = deferred<CorrectResult>();
      correct.mockReturnValueOnce(result.promise);

      dictate("panel-1", "add zoo");
      say("stand to the store");
      await service.stop();

      expect(draft("panel-1")).toBe("add Zustand to the store");
      expect(correct).toHaveBeenLastCalledWith({
        rawText: "add Zustand to the store",
        terminalId: "panel-1",
      });
      result.resolve({ action: "replace", correctedText: "Add Zustand to the store." });
      await flush();
      expect(draft("panel-1")).toBe("Add Zustand to the store.");
    });

    it("applies them with correction off and learns from the rewritten text", async () => {
      dictionary = [rule("Zustand", "zoo stand")];
      const { service, dictate, say, draft, baseline, voiceStore } = await setup();
      voiceStore.getState().setCorrectionEnabled(false);

      dictate("panel-1", "add zoo");
      say("stand");
      await service.stop();

      expect(draft("panel-1")).toBe("add Zustand");
      expect(baseline("panel-1")).toBe("add Zustand");
      expect(correct).not.toHaveBeenCalled();
    });

    it("applies them on a stop that skips correction", async () => {
      dictionary = [rule("Zustand", "zoo stand")];
      const { service, dictate, say, draft } = await setup();

      dictate("panel-1", "add zoo");
      say("stand");
      await service.stop(undefined, { skipCorrection: true });

      expect(draft("panel-1")).toBe("add Zustand");
      expect(correct).not.toHaveBeenCalled();
    });

    it("never rewrites a term the rules already wrote", async () => {
      dictionary = [rule("bee", "ay"), rule("sea", "bee")];
      const { service, dictate, say, draft } = await setup();
      correct.mockResolvedValue({ action: "no_change", correctedText: "" });

      dictate("panel-1", "bee", "ay");
      say("and sea", "and bee");
      await service.stop();

      expect(draft("panel-1")).toBe("bee and sea");
    });

    it("finds a longer phrase a shorter one took when it was split", async () => {
      dictionary = [rule("ZooThing", "zoo"), rule("Zustand", "zoo stand")];
      const { service, dictate, say, draft } = await setup();
      correct.mockResolvedValue({ action: "no_change", correctedText: "" });

      dictate("panel-1", "add ZooThing", "add zoo");
      say("stand");
      await service.stop();

      expect(draft("panel-1")).toBe("add Zustand");
    });

    it("judges a split phrase by text typed against it", async () => {
      dictionary = [rule("Zustand", "zoo stand")];
      const { service, dictate, say, draft, inputStore } = await setup();
      correct.mockResolvedValue({ action: "no_change", correctedText: "" });

      dictate("panel-1", "open zoo");
      say("stand");
      inputStore.getState().setDraftInput("panel-1", draft("panel-1") + ".ts");
      await service.stop();

      expect(draft("panel-1")).toBe("open zoo stand.ts");
    });

    it("leaves typed text between utterances alone", async () => {
      dictionary = [rule("Zustand", "zoo stand")];
      const { service, dictate, say, draft, inputStore } = await setup();
      correct.mockResolvedValue({ action: "no_change", correctedText: "" });

      dictate("panel-1", "add zoo");
      inputStore.getState().setDraftInput("panel-1", draft("panel-1") + " stand");
      say("now");
      await service.stop();

      expect(draft("panel-1")).toBe("add zoo stand now");
    });
  });
});

describe("VoiceRecordingService — learning baseline follows its draft (#14645)", () => {
  beforeEach(() => {
    vi.resetModules();
    callbacks.delta = null;
    callbacks.complete = null;
    callbacks.boundary = null;
    correct.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const passage = (
    voiceStore: Awaited<ReturnType<typeof setup>>["voiceStore"],
    draft: string,
    panelId = "panel-1"
  ) => draft.slice(voiceStore.getState().panelBuffers[panelId]!.sessionDraftStart);

  it("takes the corrected text as the baseline once the correction lands", async () => {
    const { service, dictate, flush, baseline } = await setup();
    correct.mockResolvedValueOnce({ action: "replace", correctedText: "migrate to React" });

    dictate("panel-1", "migrate to racked");
    await service.stop();
    await flush();

    expect(baseline("panel-1")).toBe("migrate to React");
  });

  it("keeps the dictated text as the baseline when the user edits during the correction", async () => {
    const { service, dictate, draft, flush, baseline, inputStore } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    dictate("panel-1", "migrate to racked");
    await service.stop();
    inputStore.getState().setDraftInput("panel-1", "migrate to rackets");
    first.resolve({ action: "replace", correctedText: "migrate to React" });
    await flush();

    expect(draft("panel-1")).toBe("migrate to rackets");
    expect(baseline("panel-1")).toBe("migrate to racked");
  });

  it("drops the baseline when its draft is cleared without a send", async () => {
    const { service, dictate, flush, baseline, inputStore, voiceStore } = await setup();
    correct.mockResolvedValueOnce({ action: "no_change", correctedText: "the parser" });

    dictate("panel-1", "the parser");
    await service.stop();
    await flush();
    expect(baseline("panel-1")).toBe("the parser");

    inputStore.getState().clearDraftInput("panel-1");
    expect(baseline("panel-1")).toBeNull();

    voiceStore.getState().setCorrectionEnabled(false);
    dictate("panel-1", "the lexer");
    await service.stop();
    expect(baseline("panel-1")).toBe("the lexer");

    inputStore.getState().setDraftInput("panel-1", "");
    expect(baseline("panel-1")).toBeNull();
  });

  it("drops a pending correction's seeded baseline when the draft is cleared", async () => {
    const { service, dictate, flush, baseline, inputStore } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    dictate("panel-1", "the parsr");
    await service.stop();
    expect(baseline("panel-1")).toBe("the parsr");

    inputStore.getState().clearDraftInput("panel-1");
    first.resolve({ action: "replace", correctedText: "the parser" });
    await flush();

    expect(baseline("panel-1")).toBeNull();
  });

  it("learns without correction from the passage as it stood in the draft", async () => {
    const { service, dictate, baseline, inputStore, voiceStore } = await setup();
    voiceStore.getState().setCorrectionEnabled(false);

    inputStore.getState().setDraftInput("panel-1", "note:");
    dictate("panel-1", "the parsr");
    await service.stop();
    expect(correct).not.toHaveBeenCalled();
    expect(baseline("panel-1")).toBe("the parsr");

    // Typing before the passage moves where it starts; editing it doesn't.
    inputStore.getState().setDraftInput("panel-1", "my note: the parsr");
    inputStore.getState().setDraftInput("panel-1", "my note: the parser");
    expect(passage(voiceStore, inputStore.getState().getDraftInput("panel-1"))).toBe("the parser");
    expect(baseline("panel-1")).toBe("the parsr");
  });

  it("moves a newer baseline once when an older correction lands before it", async () => {
    const { service, dictate, flush, baseline, inputStore, voiceStore } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    dictate("panel-1", "the parsr");
    await service.stop();
    voiceStore.getState().setCorrectionEnabled(false);
    dictate("panel-1", "and the lexer");
    await service.stop();
    expect(baseline("panel-1")).toBe("and the lexer");

    first.resolve({ action: "replace", correctedText: "the parser" });
    await flush();

    const draft = inputStore.getState().getDraftInput("panel-1");
    expect(draft).toContain("the parser");
    expect(passage(voiceStore, draft).trim()).toBe("and the lexer");
  });

  it("follows baselines again after the service is torn down and brought back", async () => {
    const { service, dictate, baseline, inputStore, voiceStore } = await setup();
    voiceStore.getState().setCorrectionEnabled(false);
    dictate("panel-1", "the parsr");
    await service.stop();

    service.destroy();
    service.initialize();
    inputStore.getState().clearDraftInput("panel-1");

    expect(baseline("panel-1")).toBeNull();
  });
});
