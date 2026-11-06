import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCleanupFailure, VoiceDictionaryEntry } from "@shared/types";
import { acceptSuggestion } from "@shared/utils/voiceDictionary";

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

const notify = vi.hoisted(() =>
  vi.fn<
    (payload: {
      type: string;
      title: string;
      message: string;
      action?: { actionId?: string; actionArgs?: unknown };
    }) => void
  >()
);
vi.mock("@/lib/notify", () => ({ notify }));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: vi.fn(),
    getEffectiveCombos: vi.fn(() => []),
    matchesEvent: vi.fn(),
  },
}));

type DeltaPayload = { text: string; itemId?: string };
type CompletePayload = {
  text: string;
  willCorrect: boolean;
  itemId?: string;
  transcriptId?: string;
  heard?: string;
  commandText?: string;
  uncertain?: Span[];
  heardUncertain?: Span[];
  commandUncertain?: Span[];
  pauses?: number[];
  heardPauses?: number[];
  commandPauses?: number[];
};
type Span = { from: number; to: number };
type CorrectResult = {
  action: "no_change" | "replace";
  correctedText: string;
  failed?: true;
  verdict?: "replaced" | "unchanged" | "failed" | "timed_out";
  cleanupFailure?: VoiceCleanupFailure;
};

type FileTokenPayload = {
  sessionId: string;
  transcriptId: string;
  references: Array<{ description: string; path: string | null }>;
};

const callbacks: {
  delta: ((payload: DeltaPayload) => void) | null;
  complete: ((payload: CompletePayload) => void) | null;
  boundary: ((payload: { rawText: string | null }) => void) | null;
  fileToken: ((payload: FileTokenPayload) => void) | null;
  progress: ((payload: { streamId: string; text: string }) => void) | null;
} = { delta: null, complete: null, boundary: null, fileToken: null, progress: null };

const correct =
  vi.fn<
    (request: {
      rawText: string;
      recentContext?: string[];
      recentPrompts?: string[];
      terminalId?: string;
      sessionId?: string;
      uncertain?: Span[];
      pauses?: number[];
      streamId?: string;
    }) => Promise<CorrectResult>
  >();

let dictionary: VoiceDictionaryEntry[] = [];

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
      onCorrectionProgress: vi.fn((cb: (payload: { streamId: string; text: string }) => void) => {
        callbacks.progress = cb;
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
      onLiveLevel: vi.fn(() => () => {}),
      onPauseRequested: vi.fn(() => () => {}),
      publishDetails: vi.fn().mockResolvedValue(undefined),
      setPausedLive: vi.fn().mockResolvedValue(true),
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
  const say = (text: string, heard?: string, transcriptId?: string) => {
    const itemId = `item-${++itemSeq}`;
    callbacks.delta!({ text: heard ?? text, itemId });
    callbacks.complete!({
      text,
      willCorrect: false,
      itemId,
      ...(heard ? { heard } : {}),
      ...(transcriptId ? { transcriptId } : {}),
    });
  };
  const dictate = (panelId: string, text: string, heard?: string, transcriptId?: string) => {
    useVoiceRecordingStore.getState().beginSession({ panelId });
    say(text, heard, transcriptId);
  };
  // Main's file links for a transcript, which name the session that spoke it.
  const resolveFiles = (
    panelId: string,
    transcriptId: string,
    ...references: Array<{ description: string; path: string | null }>
  ) =>
    callbacks.fileToken!({
      sessionId: useVoiceRecordingStore.getState().panelBuffers[panelId]!.dictationSessionId!,
      transcriptId,
      references,
    });
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
    resolveFiles,
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
    callbacks.progress = null;
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
      sessionId: expect.any(String),
      rawText: "fix the bug in the parsr",
      startsPrompt: true,
      terminalId: "panel-1",
      streamId: expect.any(String),
    });

    dictate("panel-2", "second thought");
    await service.stop();
    expect(correct).toHaveBeenLastCalledWith({
      sessionId: expect.any(String),
      rawText: "second thought",
      startsPrompt: true,
      terminalId: "panel-2",
      streamId: expect.any(String),
    });

    // Each passage names the dictation it came from, for the context main read during it.
    expect(correct.mock.calls[0]![0].sessionId).not.toBe(correct.mock.calls[1]![0].sessionId);

    first.resolve({ action: "replace", correctedText: "Fix the bug in the parser." });
    await flush();

    expect(draft("panel-1")).toBe("Fix the bug in the parser.");
    expect(draft("panel-2")).toBe("second thought");
  });

  // #14855: a send empties the draft, so what was sent is the conversation the
  // next dictation into that terminal continues.
  it("sends the prompts last sent to the dictated terminal, read as the request goes", async () => {
    const { service, dictate, inputStore } = await setup();
    correct.mockResolvedValue({ action: "no_change", correctedText: "" });
    inputStore.getState().recordSentPrompt("panel-1", "Measure gpt-6.1-terra against Luna");
    inputStore.getState().recordSentPrompt("panel-2", "Somewhere else entirely");

    dictate("panel-1", "run the tara benchmark");
    inputStore.getState().recordSentPrompt("panel-1", "Then compare Wispr Flow");
    await service.stop();
    expect(correct).toHaveBeenLastCalledWith({
      sessionId: expect.any(String),
      rawText: "run the tara benchmark",
      recentPrompts: ["Measure gpt-6.1-terra against Luna", "Then compare Wispr Flow"],
      startsPrompt: true,
      terminalId: "panel-1",
      streamId: expect.any(String),
    });

    dictate("panel-3", "a terminal with nothing sent");
    await service.stop();
    expect(correct.mock.calls.at(-1)![0]).not.toHaveProperty("recentPrompts");
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
      sessionId: expect.any(String),
      rawText: "and the lexer",
      recentContext: ["So the parser is broken."],
      startsPrompt: false,
      terminalId: "panel-1",
      streamId: expect.any(String),
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
      sessionId: expect.any(String),
      rawText: "and the lexr too",
      recentContext: ["um so the parser is brken"],
      startsPrompt: false,
      terminalId: "panel-1",
      streamId: expect.any(String),
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
      sessionId: expect.any(String),
      rawText: "and the lexer",
      recentContext: ["The parser."],
      startsPrompt: false,
      terminalId: "panel-1",
      streamId: expect.any(String),
    });
  });

  it("keeps a passage's trailing break out of its correction, so a restart stays aligned", async () => {
    const { service, dictate, draft, flush, voiceStore } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    dictate("panel-1", "the parsr");
    callbacks.boundary!({ rawText: null });
    await service.stop();
    expect(correct).toHaveBeenLastCalledWith({
      sessionId: expect.any(String),
      rawText: "the parsr",
      startsPrompt: true,
      terminalId: "panel-1",
      streamId: expect.any(String),
    });

    voiceStore.getState().beginSession({ panelId: "panel-1" });
    callbacks.delta!({ text: "and the" });
    first.resolve({ action: "replace", correctedText: "The parser." });
    await flush();
    callbacks.complete!({ text: "and the lexer", willCorrect: false });
    expect(draft("panel-1")).toBe("The parser.\nand the lexer");

    correct.mockResolvedValueOnce({ action: "no_change", correctedText: "and the lexer" });
    await service.stop();
    expect(correct).toHaveBeenLastCalledWith({
      sessionId: expect.any(String),
      rawText: "and the lexer",
      recentContext: ["The parser.\n"],
      startsPrompt: false,
      terminalId: "panel-1",
      streamId: expect.any(String),
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

  // #15873: a composer writes its text to the store a render after each
  // keystroke, so a reply can arrive with the store a keystroke behind it.
  it("places a correction in the typing its composer shows, not the store's copy behind it", async () => {
    const { service, dictate, draft, flush, inputStore } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);
    const landing = await import("@/services/voiceCorrectionLanding");

    dictate("panel-1", "fix the parsr");
    await service.stop();
    landing.registerComposerDraftWriter("panel-1", undefined, () =>
      inputStore.getState().setDraftInput("panel-1", "/review fix the parsr")
    );
    const { externalDraftRevision, caretMovingDraftRevision } = inputStore.getState();

    first.resolve({ action: "replace", correctedText: "Fix the parser." });
    await flush();

    expect(draft("panel-1")).toBe("/review Fix the parser.");
    const landed = landing.takeLandedCorrection("panel-1", undefined, draft("panel-1"));
    expect(landed?.from).toBe("/review ".length);
    expect(landed?.write?.before).toBe("/review fix the parsr");
    // The composer is told, and the caret it shows in the typing is left there.
    expect(inputStore.getState().externalDraftRevision).toBeGreaterThan(externalDraftRevision);
    expect(inputStore.getState().caretMovingDraftRevision).toBe(caretMovingDraftRevision);
  });

  it("lands every passage around typing written through between them", async () => {
    const { service, dictate, say, draft, flush, inputStore } = await setup();
    correct.mockImplementation(async ({ rawText }) => ({
      action: "replace",
      correctedText: rawText.replace("parsr", "parser").replace("lexr", "lexer"),
    }));
    const landing = await import("@/services/voiceCorrectionLanding");

    dictate("panel-1", "the parsr");
    inputStore.getState().setDraftInput("panel-1", draft("panel-1") + "\n");
    say("the lexr");
    expect(draft("panel-1")).toBe("the parsr\nthe lexr");
    landing.registerComposerDraftWriter("panel-1", undefined, () =>
      inputStore.getState().setDraftInput("panel-1", "the parsr\nnote: the lexr")
    );
    await service.stop();
    await flush();

    expect(draft("panel-1")).toBe("the parser\nnote: the lexer");
  });

  it("drops a correction whose passage the composer's typing reached before the store did", async () => {
    const { service, dictate, draft, flush, inputStore } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);
    const landing = await import("@/services/voiceCorrectionLanding");

    dictate("panel-1", "fix the parsr");
    await service.stop();
    landing.registerComposerDraftWriter("panel-1", undefined, () =>
      inputStore.getState().setDraftInput("panel-1", "fix the parser")
    );

    first.resolve({ action: "replace", correctedText: "Fix the parser." });
    await flush();

    expect(draft("panel-1")).toBe("fix the parser");
    expect(service.hasPendingCorrection("panel-1")).toBe(false);
    expect(landing.takeLandedCorrection("panel-1", undefined, draft("panel-1"))).toBeNull();
  });

  it("asks only the composers showing the corrected draft to write their typing through", async () => {
    const { service, dictate, draft, flush } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);
    const landing = await import("@/services/voiceCorrectionLanding");

    dictate("panel-1", "fix the parsr");
    await service.stop();
    const own = vi.fn();
    const otherPanel = vi.fn();
    const otherProject = vi.fn();
    const gone = vi.fn();
    landing.registerComposerDraftWriter("panel-1", undefined, own);
    landing.registerComposerDraftWriter("panel-2", undefined, otherPanel);
    landing.registerComposerDraftWriter("panel-1", "project-2", otherProject);
    landing.registerComposerDraftWriter("panel-1", undefined, gone)();

    first.resolve({ action: "replace", correctedText: "Fix the parser." });
    await flush();

    expect(draft("panel-1")).toBe("Fix the parser.");
    expect(own).toHaveBeenCalledTimes(1);
    expect(otherPanel).not.toHaveBeenCalled();
    expect(otherProject).not.toHaveBeenCalled();
    expect(gone).not.toHaveBeenCalled();
  });

  it("lands a pending correction when text is typed before it while a restart dictates", async () => {
    const { service, dictate, draft, flush, inputStore } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    dictate("panel-1", "the parsr");
    await service.stop();
    dictate("panel-1", "and the lexer");
    inputStore.getState().setDraftInput("panel-1", "note: " + draft("panel-1"));
    expect(service.hasPendingCorrection("panel-1")).toBe(true);

    first.resolve({ action: "replace", correctedText: "the parser" });
    await flush();
    expect(draft("panel-1")).toBe("note: the parser and the lexer");
  });

  it("lands a pending correction when a restart dictates a lead-in ahead of it", async () => {
    const { service, dictate, draft, flush } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    dictate("panel-1", "the parsr");
    await service.stop();
    const caret = await import("@/lib/composerCaret");
    const text = draft("panel-1");
    caret.recordComposerState(
      "panel-1",
      {},
      {
        doc: { length: text.length, toString: () => text },
        selection: { main: { from: 0, to: 0 } },
      }
    );
    dictate("panel-1", "fix");
    expect(draft("panel-1")).toBe("fix the parsr");

    first.resolve({ action: "replace", correctedText: "the parser" });
    await flush();
    expect(draft("panel-1")).toBe("fix the parser");
  });

  it("cleans each passage of a dictation split by a paste and a newline mid-session", async () => {
    const { service, dictate, say, draft, flush, inputStore } = await setup();
    correct.mockResolvedValueOnce({ action: "replace", correctedText: "Look at the parser in" });
    correct.mockResolvedValueOnce({ action: "replace", correctedText: "and fix the lexer too." });

    dictate("panel-1", "look at the parsr in");
    inputStore.getState().setDraftInput("panel-1", draft("panel-1") + " /src/parser.ts\n");
    say("and fix the lexr too");
    await service.stop();
    expect(correct).toHaveBeenLastCalledWith({
      sessionId: expect.any(String),
      rawText: "and fix the lexr too",
      recentContext: ["look at the parsr in /src/parser.ts\n"],
      startsPrompt: false,
      terminalId: "panel-1",
      streamId: expect.any(String),
    });
    await flush();

    expect(draft("panel-1")).toBe("Look at the parser in /src/parser.ts\nand fix the lexer too.");
  });

  it("cleans every stretch around pasted paths, blank lines and an image, leaving them as they were", async () => {
    const { service, dictate, say, draft, flush, inputStore } = await setup();
    const cleaned: Record<string, string> = {
      "look at the parsr": "Look at the parser",
      "and the lexr": "and the lexer",
      "then the tokenizr": "then the tokenizer.",
    };
    correct.mockImplementation(async ({ rawText }) => ({
      action: "replace",
      correctedText: cleaned[rawText] ?? rawText,
    }));
    const paste = (text: string) =>
      inputStore.getState().setDraftInput("panel-1", draft("panel-1") + text);

    dictate("panel-1", "look at the parsr");
    paste(" /src/parser.ts\n\n");
    say("and the lexr");
    paste(" /tmp/screenshot.png ");
    say("then the tokenizr");
    await service.stop();
    await flush();

    expect(correct.mock.calls.map(([request]) => request.rawText)).toEqual(Object.keys(cleaned));
    expect(draft("panel-1")).toBe(
      "Look at the parser /src/parser.ts\n\nand the lexer /tmp/screenshot.png then the tokenizer."
    );
  });

  it("hands the composer only what cleanup changed in each passage", async () => {
    const { service, dictate, say, draft, flush, inputStore } = await setup();
    correct.mockImplementation(async ({ rawText }) => ({
      action: "replace",
      correctedText: rawText.replace("parsr", "parser").replace("lexr", "lexer"),
    }));

    dictate("panel-1", "the parsr");
    inputStore.getState().setDraftInput("panel-1", draft("panel-1") + " /tmp/screenshot.png ");
    say("the lexr");
    await service.stop();
    await flush();

    expect(draft("panel-1")).toBe("the parser /tmp/screenshot.png the lexer");
    const { takeLandedCorrection } = await import("@/services/voiceCorrectionLanding");
    expect(takeLandedCorrection("panel-1", undefined, draft("panel-1"))?.write?.changes).toEqual([
      { from: 8, to: 8, insert: "e" },
      { from: 37, to: 37, insert: "e" },
    ]);
  });

  it("leaves only the passage edited while its cleanup was out raw", async () => {
    const { service, dictate, say, draft, flush, inputStore } = await setup();
    const pending = new Map<string, ReturnType<typeof deferred<CorrectResult>>>();
    correct.mockImplementation(({ rawText }) => {
      const result = deferred<CorrectResult>();
      pending.set(rawText, result);
      return result.promise;
    });
    const paste = (text: string) =>
      inputStore.getState().setDraftInput("panel-1", draft("panel-1") + text);

    dictate("panel-1", "the parsr");
    paste("\n");
    say("the lexr");
    paste("\n");
    say("the tokenizr");
    await service.stop();
    expect([...pending.keys()]).toEqual(["the parsr", "the lexr", "the tokenizr"]);

    inputStore.getState().setDraftInput("panel-1", draft("panel-1").replace("lexr", "lexer!"));
    pending.get("the parsr")!.resolve({ action: "replace", correctedText: "The parser" });
    pending.get("the lexr")!.resolve({ action: "replace", correctedText: "The lexer" });
    pending.get("the tokenizr")!.resolve({ action: "replace", correctedText: "The tokenizer" });
    await flush();

    expect(draft("panel-1")).toBe("The parser\nthe lexer!\nThe tokenizer");
  });

  it("keeps a restart dictating between a pending correction's passages on its own text", async () => {
    const { service, dictate, say, draft, flush, inputStore } = await setup();
    const first = deferred<CorrectResult>();
    const second = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);
    correct.mockReturnValueOnce(second.promise);

    dictate("panel-1", "look at the parsr");
    inputStore.getState().setDraftInput("panel-1", draft("panel-1") + "\n");
    say("and fix the lexr");
    await service.stop();
    expect(correct).toHaveBeenCalledTimes(2);

    const caret = await import("@/lib/composerCaret");
    const text = draft("panel-1");
    const at = text.indexOf("\n");
    caret.recordComposerState(
      "panel-1",
      {},
      {
        doc: { length: text.length, toString: () => text },
        selection: { main: { from: at, to: at } },
      }
    );
    dictate("panel-1", "in src");
    expect(draft("panel-1")).toBe("look at the parsr in src\nand fix the lexr");

    first.resolve({ action: "replace", correctedText: "Look at the parser" });
    second.resolve({ action: "replace", correctedText: "and fix the lexer." });
    await flush();
    expect(draft("panel-1")).toBe("Look at the parser in src\nand fix the lexer.");

    say("now");
    expect(draft("panel-1")).toBe("Look at the parser in src now\nand fix the lexer.");
    correct.mockResolvedValueOnce({ action: "replace", correctedText: "in src/ now" });
    await service.stop();
    expect(correct).toHaveBeenLastCalledWith(
      expect.objectContaining({ rawText: "in src now", terminalId: "panel-1" })
    );
    await flush();
    expect(draft("panel-1")).toBe("Look at the parser in src/ now\nand fix the lexer.");
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

    const waited = service.waitForPendingCorrections("panel-1");
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
    const waited = service.waitForPendingCorrections("panel-1");
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

  it("waits with no deadline of its own until a slow correction lands", async () => {
    const { service, dictate, draft } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    dictate("panel-1", "hello wrld");
    await service.stop();

    vi.useFakeTimers();
    let settled = false;
    const waited = service.waitForPendingCorrections("panel-1");
    void waited.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    vi.useRealTimers();

    first.resolve({ action: "replace", correctedText: "Hello world." });
    await expect(waited).resolves.toBe(true);
    expect(draft("panel-1")).toBe("Hello world.");
  });

  it("takes its abort listener off a signal that outlives the wait", async () => {
    const { service, dictate } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);
    dictate("panel-1", "hello wrld");
    await service.stop();

    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const waited = service.waitForPendingCorrections("panel-1", controller.signal);
    first.resolve({ action: "replace", correctedText: "Hello world." });
    await expect(waited).resolves.toBe(true);

    const [type, listener] = add.mock.calls[0]!;
    expect(type).toBe("abort");
    expect(remove).toHaveBeenCalledWith("abort", listener);
  });

  it("stops waiting when its signal aborts and drops a correction discarded by the send", async () => {
    const { service, dictate, draft, flush } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    dictate("panel-1", "hello wrld");
    await service.stop();

    const controller = new AbortController();
    let settled = false;
    const waited = service.waitForPendingCorrections("panel-1", controller.signal);
    void waited.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    controller.abort();
    await expect(waited).resolves.toBe(false);
    // Already aborted: it doesn't start waiting at all.
    await expect(service.waitForPendingCorrections("panel-1", controller.signal)).resolves.toBe(
      false
    );

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
    const waited = service.waitForPendingCorrections("panel-1");
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

  it("tells a send its own cleanup failed, and nothing of another panel's, a newer session's, or after it lets go", async () => {
    const { service, voiceStore, dictate, flush } = await setup();
    const own = deferred<CorrectResult>();
    const elsewhere = deferred<CorrectResult>();
    const newer = deferred<CorrectResult>();
    correct
      .mockReturnValueOnce(own.promise)
      .mockReturnValueOnce(elsewhere.promise)
      .mockReturnValueOnce(newer.promise);

    dictate("panel-1", "hello wrld");
    const session = voiceStore.getState().panelBuffers["panel-1"]!.dictationSessionId!;
    const sessions = new Set([session]);
    const observed = service.observeSendCorrections("panel-1", sessions);
    // Let go before the stop registers the pass: it never hears of it.
    const released = service.observeSendCorrections("panel-1", new Set([session]));
    released.release();
    await service.stop();
    dictate("panel-2", "elsewhere");
    // Named among the send's sessions, so only the panel keeps it out.
    sessions.add(voiceStore.getState().panelBuffers["panel-2"]!.dictationSessionId!);
    await service.stop();
    dictate("panel-1", "and more");
    await service.stop();

    elsewhere.resolve({ action: "no_change", correctedText: "elsewhere", failed: true });
    newer.resolve({ action: "no_change", correctedText: "and more", failed: true });
    await flush();
    expect(observed.failed()).toBe(false);

    own.resolve({
      action: "no_change",
      correctedText: "hello wrld",
      failed: true,
      verdict: "timed_out",
    });
    await flush();
    expect(observed.failed()).toBe(true);
    expect(released.failed()).toBe(false);

    observed.release();
    expect(observed.failed()).toBe(false);
  });

  it("tells a send of a pass already on its way when it started", async () => {
    const { service, voiceStore, dictate, flush } = await setup();
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);

    dictate("panel-1", "hello wrld");
    const session = voiceStore.getState().panelBuffers["panel-1"]!.dictationSessionId!;
    await service.stop();
    const observed = service.observeSendCorrections("panel-1", new Set([session]));
    pending.resolve({ action: "no_change", correctedText: "hello wrld", failed: true });
    await flush();

    expect(observed.failed()).toBe(true);
  });

  it("doesn't tell a send a passage an edit reached failed its cleanup", async () => {
    const { service, voiceStore, inputStore, dictate, flush } = await setup();
    const pending = deferred<CorrectResult>();
    correct.mockReturnValueOnce(pending.promise);

    dictate("panel-1", "hello wrld");
    const session = voiceStore.getState().panelBuffers["panel-1"]!.dictationSessionId!;
    await service.stop();
    const observed = service.observeSendCorrections("panel-1", new Set([session]));
    inputStore.getState().setDraftInput("panel-1", "hello world, edited");
    pending.resolve({ action: "no_change", correctedText: "hello wrld", failed: true });
    await flush();

    expect(observed.failed()).toBe(false);
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
      { from: 0, to: 10, session: correct.mock.calls[0]![0].sessionId },
    ]);

    service.destroy();
    expect(voiceStore.getState().panelBuffers["panel-1"]?.correctionRanges).toEqual([]);

    first.resolve({ action: "replace", correctedText: "Hello world." });
    await flush();
    expect(draft("panel-1")).toBe("hello wrld");
  });

  describe("the recogniser's unsure words", () => {
    const complete = (payload: Omit<CompletePayload, "willCorrect">) => {
      callbacks.delta!({ text: payload.text, itemId: payload.itemId });
      callbacks.complete!({ willCorrect: false, ...payload });
    };

    it("sends correction each utterance's unsure words at their place in the passage", async () => {
      const { service, voiceStore } = await setup();
      correct.mockResolvedValue({ action: "no_change", correctedText: "" });

      voiceStore.getState().beginSession({ panelId: "panel-1" });
      complete({ text: "test foo test", itemId: "a", uncertain: [{ from: 9, to: 13 }] });
      complete({ text: "then racked native", itemId: "b", uncertain: [{ from: 5, to: 11 }] });
      await service.stop();

      expect(correct).toHaveBeenLastCalledWith({
        rawText: "test foo test then racked native",
        terminalId: "panel-1",
        startsPrompt: true,
        sessionId: expect.any(String),
        uncertain: [
          { from: 9, to: 13 },
          { from: 19, to: 25 },
        ],
        streamId: expect.any(String),
      });
    });

    it("takes the command's own unsure words when the command opens the prompt", async () => {
      const { service, voiceStore, draft } = await setup();
      correct.mockResolvedValue({ action: "no_change", correctedText: "" });

      voiceStore.getState().beginSession({ panelId: "panel-1" });
      complete({
        text: "Slash review the last commit.",
        itemId: "cmd",
        commandText: "/review the last commit.",
        uncertain: [
          { from: 6, to: 12 },
          { from: 17, to: 21 },
        ],
        commandUncertain: [{ from: 12, to: 16 }],
      });
      expect(draft("panel-1")).toBe("/review the last commit.");
      await service.stop();

      expect(correct.mock.lastCall?.[0]).toMatchObject({
        rawText: "/review the last commit.",
        uncertain: [{ from: 12, to: 16 }],
      });
    });

    it("follows the stop-time heard-as rules through the words as heard", async () => {
      dictionary = [{ term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 0 }];
      const { service, voiceStore, draft } = await setup();
      correct.mockResolvedValue({ action: "no_change", correctedText: "" });

      voiceStore.getState().beginSession({ panelId: "panel-1" });
      // Main already rewrote the first "zoo stand"; "stor" sits at a different
      // place in the words as heard than in the words written.
      complete({
        text: "add Zustand stor zoo",
        heard: "add zoo stand stor zoo",
        itemId: "a",
        uncertain: [{ from: 12, to: 16 }],
        heardUncertain: [{ from: 14, to: 18 }],
      });
      complete({ text: "stand", itemId: "b" });
      await service.stop();

      expect(draft("panel-1")).toBe("add Zustand stor Zustand");
      expect(correct.mock.lastCall?.[0]).toMatchObject({
        rawText: "add Zustand stor Zustand",
        uncertain: [{ from: 12, to: 16 }],
      });
    });
  });

  // Where the speaker paused (#14897), as main sends it on each completion.
  describe("the speaker's pauses", () => {
    const complete = (payload: Omit<CompletePayload, "willCorrect">) => {
      if (payload.text)
        callbacks.delta!({ text: payload.heard ?? payload.text, itemId: payload.itemId });
      callbacks.complete!({ willCorrect: false, ...payload });
    };

    it("sends correction each pause at its place in a passage of several utterances, a stripped break's included", async () => {
      dictionary = [{ term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 0 }];
      const { service, voiceStore, draft } = await setup();
      correct.mockResolvedValue({ action: "no_change", correctedText: "" });

      voiceStore.getState().beginSession({ panelId: "panel-1" });
      // "add zoo stand" + pause, "and fix the bug" cut mid-speech, "new line." +
      // pause (main strips the command: its item retires with the pause after
      // the words before it), "then run tests" cut at the cap, "and lint" + pause.
      complete({
        text: "add Zustand",
        heard: "add zoo stand",
        itemId: "a",
        pauses: [11],
        heardPauses: [13],
      });
      complete({ text: "and fix the bug", itemId: "b" });
      complete({ text: "", itemId: "c", pauses: [0] });
      callbacks.boundary!({ rawText: null });
      complete({ text: "then run tests", itemId: "d" });
      complete({ text: "and lint", itemId: "e", pauses: [8] });
      await service.stop();

      expect(draft("panel-1")).toBe("add Zustand and fix the bug\nthen run tests and lint");
      expect(correct).toHaveBeenLastCalledWith({
        rawText: "add Zustand and fix the bug\nthen run tests and lint",
        terminalId: "panel-1",
        startsPrompt: true,
        sessionId: expect.any(String),
        pauses: [11, 27, 51],
        streamId: expect.any(String),
      });
    });

    it("takes the command's own pauses when the command opens the prompt", async () => {
      const { service, voiceStore, draft } = await setup();
      correct.mockResolvedValue({ action: "no_change", correctedText: "" });

      voiceStore.getState().beginSession({ panelId: "panel-1" });
      complete({
        text: "Slash. review the parser.",
        itemId: "cmd",
        commandText: "/review the parser.",
        pauses: [6, 25],
        commandPauses: [7, 19],
      });
      expect(draft("panel-1")).toBe("/review the parser.");
      await service.stop();

      expect(correct.mock.lastCall?.[0]).toMatchObject({
        rawText: "/review the parser.",
        pauses: [7, 19],
      });
    });

    it("keeps a pause the stop-time heard-as rules wrote a term over at the term's end", async () => {
      dictionary = [{ term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 0 }];
      const { service, voiceStore, draft } = await setup();
      correct.mockResolvedValue({ action: "no_change", correctedText: "" });

      voiceStore.getState().beginSession({ panelId: "panel-1" });
      complete({ text: "fix it and add zoo", itemId: "a", pauses: [6, 18] });
      complete({ text: "stand to the store", itemId: "b", pauses: [18] });
      await service.stop();

      expect(draft("panel-1")).toBe("fix it and add Zustand to the store");
      expect(correct.mock.lastCall?.[0]).toMatchObject({
        rawText: "fix it and add Zustand to the store",
        pauses: [6, 22, 35],
      });
    });

    it("reruns the heard-as rules from the pauses in the words as heard", async () => {
      dictionary = [
        { term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 0 },
        { term: "nowPlease", heardAs: ["now please"], source: "manual", addedAt: 0 },
      ];
      const { service, voiceStore, draft } = await setup();
      correct.mockResolvedValue({ action: "no_change", correctedText: "" });

      voiceStore.getState().beginSession({ panelId: "panel-1" });
      // The pause after "and" sits at 15 in the words written and 17 as heard;
      // the rerun reads the heard ones, since "now please" spans both utterances.
      complete({
        text: "add Zustand and now",
        heard: "add zoo stand and now",
        itemId: "a",
        pauses: [15],
        heardPauses: [17],
      });
      complete({ text: "please", itemId: "b" });
      await service.stop();

      expect(draft("panel-1")).toBe("add Zustand and nowPlease");
      expect(correct.mock.lastCall?.[0]).toMatchObject({
        rawText: "add Zustand and nowPlease",
        pauses: [15],
      });
    });

    it("marks a pause with no words on the words before it, leaving the live preview alone", async () => {
      const { service, voiceStore, draft } = await setup();
      correct.mockResolvedValue({ action: "no_change", correctedText: "" });

      voiceStore.getState().beginSession({ panelId: "panel-1" });
      complete({ text: "fix the bug", itemId: "a" });
      callbacks.delta!({ text: "and the", itemId: "b" });
      complete({ text: "", pauses: [0] });
      expect(voiceStore.getState().panelBuffers["panel-1"]?.liveText).toBe("and the");
      expect(voiceStore.getState().panelBuffers["panel-1"]?.completedSegments).toEqual([
        "fix the bug",
      ]);
      complete({ text: "and the parser", itemId: "b" });
      await service.stop();

      expect(draft("panel-1")).toBe("fix the bug and the parser");
      expect(correct.mock.lastCall?.[0]).toMatchObject({ pauses: [11] });
    });

    it("sends no pauses for a dictation the speaker never paused in", async () => {
      const { service, voiceStore } = await setup();
      correct.mockResolvedValue({ action: "no_change", correctedText: "" });

      voiceStore.getState().beginSession({ panelId: "panel-1" });
      complete({ text: "fix the bug", itemId: "a" });
      await service.stop();

      expect(correct.mock.lastCall?.[0]).not.toHaveProperty("pauses");
    });
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
        sessionId: expect.any(String),
        rawText: "add Zustand to the store",
        terminalId: "panel-1",
        startsPrompt: true,
        streamId: expect.any(String),
      });
      result.resolve({ action: "replace", correctedText: "Add Zustand to the store." });
      await flush();
      expect(draft("panel-1")).toBe("Add Zustand to the store.");
    });

    // Main reads the command from the words as heard and writes its arguments
    // as heard too, so the command is what the rules rerun over, never the
    // spoken words it replaced.
    it("rewrites a spoken command's arguments and keeps the command", async () => {
      dictionary = [rule("Zustand", "zoo stand")];
      const { service, voiceStore, draft } = await setup();
      correct.mockResolvedValue({ action: "no_change", correctedText: "" });

      voiceStore.getState().beginSession({ panelId: "panel-1" });
      callbacks.delta!({ text: "slash review zoo stand", itemId: "item-cmd" });
      callbacks.complete!({
        text: "slash review Zustand",
        heard: "slash review zoo stand",
        commandText: "/review zoo stand",
        willCorrect: false,
        itemId: "item-cmd",
      });
      expect(draft("panel-1")).toBe("/review zoo stand");
      await service.stop();

      expect(draft("panel-1")).toBe("/review Zustand");
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

    it.each([
      { cleanup: "on", correctionEnabled: true },
      { cleanup: "off", correctionEnabled: false },
    ])(
      "leaves an everyday word a correction taught as it was said, cleanup $cleanup",
      async ({ correctionEnabled }) => {
        ({ dictionary } = acceptSuggestion(
          {
            dictionary: [{ ...rule("Zustand", "zoo stand"), source: "learned" }],
            suggestedDictionary: [
              { word: "Jest", utterance: "just", suggestedAt: 0, frequency: 1 },
            ],
          },
          "Jest",
          0
        ));
        const { service, dictate, say, draft, voiceStore } = await setup();
        voiceStore.getState().setCorrectionEnabled(correctionEnabled);
        correct.mockResolvedValue({ action: "no_change", correctedText: "" });

        dictate("panel-1", "I just want to check zoo");
        say("stand");
        await service.stop();

        expect(draft("panel-1")).toBe("I just want to check Zustand");
        if (correctionEnabled) {
          expect(correct.mock.lastCall?.[0]).toMatchObject({
            rawText: "I just want to check Zustand",
          });
        } else {
          expect(correct).not.toHaveBeenCalled();
        }
      }
    );

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

    describe("with a resolved file link", () => {
      const router = { description: "router", path: "src/router.ts" };
      const cleanups = () => correct.mock.calls.map(([request]) => request.rawText);

      it("keeps the link and still catches a phrase split around it", async () => {
        dictionary = [rule("Zustand", "zoo stand")];
        const { service, dictate, say, resolveFiles, draft } = await setup();
        correct.mockResolvedValue({ action: "no_change", correctedText: "" });

        dictate("panel-1", "Zustand: link to the router", "zoo stand: link to the router", "t1");
        say("and zoo");
        say("stand now");
        resolveFiles("panel-1", "t1", router);
        expect(draft("panel-1")).toBe("Zustand: @src/router.ts and zoo stand now");
        await service.stop();

        expect(draft("panel-1")).toBe("Zustand: @src/router.ts and Zustand now");
        expect(cleanups()).toEqual(["Zustand: @src/router.ts and Zustand now"]);
      });

      it("never rewrites a term the rules already wrote in the same utterance", async () => {
        dictionary = [rule("bee", "ay"), rule("sea", "bee")];
        const { service, dictate, resolveFiles, draft } = await setup();
        correct.mockResolvedValue({ action: "no_change", correctedText: "" });

        dictate("panel-1", "bee link to the router", "ay link to the router", "t1");
        resolveFiles("panel-1", "t1", router);
        await service.stop();

        expect(draft("panel-1")).toBe("bee @src/router.ts");
        expect(cleanups()).toEqual(["bee @src/router.ts"]);
      });

      it("keeps the link when a rule rewrote words inside the command", async () => {
        dictionary = [rule("router", "rooter")];
        const { service, dictate, resolveFiles, draft } = await setup();
        correct.mockResolvedValue({ action: "no_change", correctedText: "" });

        dictate("panel-1", "link to the router", "link to the rooter", "t1");
        resolveFiles("panel-1", "t1", router);
        await service.stop();

        expect(draft("panel-1")).toBe("@src/router.ts");
        expect(cleanups()).toEqual(["@src/router.ts"]);
      });

      it("never writes a term twice when a rule wrote the words of the command", async () => {
        dictionary = [rule("React Native", "react")];
        const { service, dictate, resolveFiles, draft } = await setup();
        correct.mockResolvedValue({ action: "no_change", correctedText: "" });

        dictate(
          "panel-1",
          "fix React Native and link to React Native",
          "fix react and link to react",
          "t1"
        );
        resolveFiles("panel-1", "t1", { description: "React Native", path: "src/native.ts" });
        await service.stop();

        expect(draft("panel-1")).toBe("fix React Native and @src/native.ts");
        expect(cleanups()).toEqual(["fix React Native and @src/native.ts"]);
      });

      it("swaps the command it resolved, not another that was heard alike", async () => {
        dictionary = [rule("route handler", "router"), rule("router", "rooter")];
        const { service, dictate, resolveFiles, draft } = await setup();
        correct.mockResolvedValue({ action: "no_change", correctedText: "" });

        dictate(
          "panel-1",
          "link to route handler and link to router",
          "link to router and link to rooter",
          "t1"
        );
        resolveFiles(
          "panel-1",
          "t1",
          { description: "route handler", path: null },
          { description: "router", path: "src/router.ts" }
        );
        await service.stop();

        expect(draft("panel-1")).toBe("link to route handler and @src/router.ts");
        expect(cleanups()).toEqual(["link to route handler and @src/router.ts"]);
      });

      it("keeps a link in each of two utterances heard differently", async () => {
        dictionary = [rule("router", "rooter"), rule("readme file", "read me file")];
        const { service, dictate, say, resolveFiles, draft } = await setup();
        correct.mockResolvedValue({ action: "no_change", correctedText: "" });

        dictate("panel-1", "link to the router", "link to the rooter", "t1");
        say("then link to the readme file", "then link to the read me file", "t1");
        resolveFiles("panel-1", "t1", router, { description: "readme file", path: "README.md" });
        expect(draft("panel-1")).toBe("@src/router.ts then @README.md");
        await service.stop();

        expect(draft("panel-1")).toBe("@src/router.ts then @README.md");
        expect(cleanups()).toEqual(["@src/router.ts then @README.md"]);
      });

      it("keeps a quoted path whose spaces hold a word a rule would rewrite", async () => {
        dictionary = [rule("Zustand", "zoo stand")];
        const { service, dictate, resolveFiles, draft } = await setup();
        correct.mockResolvedValue({ action: "no_change", correctedText: "" });

        dictate("panel-1", "Zustand link to the notes", "zoo stand link to the notes", "t1");
        resolveFiles("panel-1", "t1", {
          description: "notes",
          path: "docs/my zoo stand notes.md",
        });
        await service.stop();

        expect(draft("panel-1")).toBe('Zustand @"docs/my zoo stand notes.md"');
        expect(cleanups()).toEqual(['Zustand @"docs/my zoo stand notes.md"']);
      });

      it("leaves the swap an edit when no swap fits the words as heard", async () => {
        // The command ends inside "router tests", which the rule wrote for "rooter".
        dictionary = [rule("router tests", "rooter")];
        const { service, dictate, resolveFiles, draft } = await setup();
        correct.mockResolvedValue({ action: "no_change", correctedText: "" });

        dictate("panel-1", "link to the router tests", "link to the rooter", "t1");
        resolveFiles("panel-1", "t1", router);
        await service.stop();

        expect(draft("panel-1")).toBe("@src/router.ts tests");
        expect(correct).not.toHaveBeenCalled();
      });
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

    it("rewrites a split phrase dictated mid-draft in place, with the typed text around it intact", async () => {
      dictionary = [rule("Zustand", "zoo stand")];
      const { service, dictate, say, draft, inputStore, voiceStore, baseline } = await setup();
      voiceStore.getState().setCorrectionEnabled(false);
      const typed = "Please then test it.";
      inputStore.getState().setDraftInput("panel-1", typed);
      const caret = await import("@/lib/composerCaret");
      caret.recordComposerState(
        "panel-1",
        {},
        {
          doc: { length: typed.length, toString: () => typed },
          selection: { main: { from: 7, to: 7 } },
        }
      );

      dictate("panel-1", "use zoo");
      say("stand");
      expect(draft("panel-1")).toBe("Please use zoo stand then test it.");
      await service.stop();

      expect(draft("panel-1")).toBe("Please use Zustand then test it.");
      const { useDictationRangeStore } = await import("@/store/dictationRangeStore");
      const [record] = useDictationRangeStore.getState().listDictations("panel-1");
      const { from, to } = record!.learningSpan!;
      expect(draft("panel-1").slice(from, to)).toBe("use Zustand");
      expect(record!.utterances).toHaveLength(1);
      expect(record!.utterances[0]!.separatorAfter).toEqual({ from: 18, to: 19, edited: false });
      expect(baseline("panel-1")).toBe("use Zustand");
      // The caret that followed the words is still right after them.
      expect(caret.takePendingComposerSelection("panel-1", draft("panel-1"))).toEqual({
        from: 18,
        to: 18,
      });
    });
  });
});

describe("VoiceRecordingService — learning baseline follows its draft (#14645)", () => {
  beforeEach(() => {
    vi.resetModules();
    callbacks.delta = null;
    callbacks.complete = null;
    callbacks.boundary = null;
    callbacks.progress = null;
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

describe("VoiceRecordingService — streamed cleanup (#14779)", () => {
  beforeEach(() => {
    vi.resetModules();
    callbacks.delta = null;
    callbacks.complete = null;
    callbacks.boundary = null;
    callbacks.progress = null;
    correct.mockReset();
    dictionary = [];
  });

  afterEach(() => {
    unsubscribeRanges?.();
    unsubscribeRanges = null;
    vi.unstubAllGlobals();
  });

  async function streamingSetup() {
    const harness = await setup();
    const pending = new Map<string, ReturnType<typeof deferred<CorrectResult>>>();
    correct.mockImplementation(({ rawText }) => {
      const result = deferred<CorrectResult>();
      pending.set(rawText, result);
      return result.promise;
    });
    // The text so far, as main reports it for the passage sent as `rawText`.
    const progress = (rawText: string, text: string) => {
      const request = correct.mock.calls.find(([r]) => r.rawText === rawText)?.[0];
      callbacks.progress!({ streamId: request!.streamId!, text });
    };
    const ranges = (panelId: string) =>
      harness.voiceStore.getState().panelBuffers[panelId]?.correctionRanges ?? [];
    // The session the passage sent as `rawText` was dictated in.
    const sessionOf = (rawText: string) =>
      correct.mock.calls.find(([r]) => r.rawText === rawText)?.[0].sessionId;
    // Every draft the composer held for the panel, in order.
    const drafts: string[] = [];
    unwatchers.push(
      harness.inputStore.subscribe(() => {
        const next = harness.draft("panel-1");
        if (next !== drafts.at(-1)) drafts.push(next);
      })
    );
    return { ...harness, pending, progress, ranges, sessionOf, drafts };
  }

  const unwatchers: Array<() => void> = [];
  afterEach(() => {
    for (const unwatch of unwatchers.splice(0)) unwatch();
  });

  const DICTATED = "um so fix the bug in the parser";
  const CORRECTED = "So fix the bug in the parser.";

  it("draws the cleanup over its passage as it streams, and lands it whole", async () => {
    const { service, dictate, draft, flush, pending, progress, ranges, sessionOf } =
      await streamingSetup();
    dictate("panel-1", DICTATED);
    await service.stop();
    const session = sessionOf(DICTATED);
    expect(session).toEqual(expect.any(String));
    expect(ranges("panel-1")).toEqual([{ from: 0, to: DICTATED.length, session }]);

    progress(DICTATED, "So fix the bug in");
    // The newest word waits for the next; the draft keeps what was dictated.
    expect(ranges("panel-1")).toEqual([
      {
        from: 0,
        to: DICTATED.length,
        session,
        rewrite: { to: "um so fix the bug".length, text: "So fix the bug" },
      },
    ]);
    expect(draft("panel-1")).toBe(DICTATED);

    progress(DICTATED, "So fix the bug in the");
    expect(ranges("panel-1")[0]!.rewrite).toEqual({
      to: "um so fix the bug in".length,
      text: "So fix the bug in",
    });

    pending.get(DICTATED)!.resolve({ action: "replace", correctedText: CORRECTED });
    await flush();
    expect(draft("panel-1")).toBe(CORRECTED);
    expect(ranges("panel-1")).toEqual([]);
  });

  it("puts a passage its cleanup left alone back exactly as dictated, at once", async () => {
    const {
      service,
      dictate,
      say,
      draft,
      flush,
      inputStore,
      pending,
      progress,
      ranges,
      sessionOf,
    } = await streamingSetup();
    dictate("panel-1", DICTATED);
    inputStore.getState().setDraftInput("panel-1", draft("panel-1") + "\n");
    say("and the lexr too");
    await service.stop();
    progress(DICTATED, "So fix the bug in the");
    expect(ranges("panel-1")[0]!.rewrite).toBeDefined();

    // A reply that keeps the passage comes back as no change; the other
    // passage is still out, so only this one's own reply can clear it.
    pending.get(DICTATED)!.resolve({ action: "no_change", correctedText: DICTATED });
    await flush();
    expect(service.hasPendingCorrection("panel-1")).toBe(true);
    const session = sessionOf(DICTATED);
    expect(session).toEqual(expect.any(String));
    expect(ranges("panel-1")[0]).toEqual({ from: 0, to: DICTATED.length, session });

    // Its stream has replied, so anything still in flight for it is ignored.
    progress(DICTATED, "So fix the bug in the parser");
    expect(ranges("panel-1")[0]).toEqual({ from: 0, to: DICTATED.length, session });

    pending.get("and the lexr too")!.resolve({ action: "no_change", correctedText: "" });
    await flush();
    expect(draft("panel-1")).toBe(`${DICTATED}\nand the lexr too`);
    expect(ranges("panel-1")).toEqual([]);
  });

  it("lands a command cleanup even once text was typed ahead of the passage", async () => {
    const { service, dictate, say, draft, flush, inputStore, pending, ranges, sessionOf } =
      await streamingSetup();
    dictate("panel-1", "run the review skill on auth");
    inputStore.getState().setDraftInput("panel-1", draft("panel-1") + "\n");
    say("and the lexr too");
    await service.stop();

    inputStore.getState().setDraftInput("panel-1", `Note: ${draft("panel-1")}`);
    pending.get("run the review skill on auth")!.resolve({
      action: "replace",
      correctedText: "/review on auth",
    });
    await flush();
    const session = sessionOf("run the review skill on auth");
    expect(session).toEqual(expect.any(String));
    const to = 6 + "run the review skill on auth".length;
    expect(ranges("panel-1")[0]).toEqual({
      from: 6,
      to,
      session,
      rewrite: { to, text: "/review on auth" },
    });

    pending.get("and the lexr too")!.resolve({ action: "no_change", correctedText: "" });
    await flush();
    expect(draft("panel-1")).toBe("Note: /review on auth\nand the lexr too");
  });

  it("stops the rewrite at an edit mid-stream and leaves the passage as dictated", async () => {
    const { service, dictate, draft, flush, inputStore, pending, progress, ranges } =
      await streamingSetup();
    dictate("panel-1", DICTATED);
    await service.stop();
    progress(DICTATED, "So fix the bug in");
    expect(ranges("panel-1")[0]!.rewrite).toBeDefined();

    inputStore.getState().setDraftInput("panel-1", DICTATED.replace("bug", "bugs"));
    expect(ranges("panel-1")).toEqual([]);
    expect(service.hasPendingCorrection("panel-1")).toBe(false);

    progress(DICTATED, "So fix the bug in the");
    expect(ranges("panel-1")).toEqual([]);
    pending.get(DICTATED)!.resolve({ action: "replace", correctedText: CORRECTED });
    await flush();
    expect(draft("panel-1")).toBe("um so fix the bugs in the parser");
  });

  it("leaves a passage as dictated for a send that stops waiting mid-stream", async () => {
    const { service, dictate, draft, flush, pending, progress, ranges } = await streamingSetup();
    dictate("panel-1", DICTATED);
    await service.stop();
    progress(DICTATED, "So fix the bug in");

    service.discardPendingCorrections("panel-1");
    expect(ranges("panel-1")).toEqual([]);
    expect(draft("panel-1")).toBe(DICTATED);

    progress(DICTATED, "So fix the bug in the");
    pending.get(DICTATED)!.resolve({ action: "replace", correctedText: CORRECTED });
    await flush();
    expect(ranges("panel-1")).toEqual([]);
    expect(draft("panel-1")).toBe(DICTATED);
  });

  it("shows a passage's whole cleanup once it's back, while another still streams", async () => {
    const {
      service,
      dictate,
      say,
      draft,
      flush,
      inputStore,
      pending,
      progress,
      ranges,
      sessionOf,
    } = await streamingSetup();
    dictate("panel-1", "the parsr is brokn");
    inputStore.getState().setDraftInput("panel-1", draft("panel-1") + "\n");
    say("um and the lexr too");
    await service.stop();

    pending.get("the parsr is brokn")!.resolve({
      action: "replace",
      correctedText: "The parser is broken.",
    });
    await flush();
    progress("um and the lexr too", "And the lexer");
    const session = sessionOf("the parsr is brokn");
    expect(session).toEqual(expect.any(String));
    expect(sessionOf("um and the lexr too")).toBe(session);
    expect(ranges("panel-1")).toEqual([
      { from: 0, to: 18, session, rewrite: { to: 18, text: "The parser is broken." } },
      {
        from: 19,
        to: 38,
        session,
        rewrite: { to: 19 + "um and the".length, text: "And the" },
      },
    ]);
    expect(draft("panel-1")).toBe("the parsr is brokn\num and the lexr too");

    pending.get("um and the lexr too")!.resolve({
      action: "replace",
      correctedText: "And the lexer too.",
    });
    await flush();
    expect(draft("panel-1")).toBe("The parser is broken.\nAnd the lexer too.");
    expect(ranges("panel-1")).toEqual([]);
  });

  // #14901: a reply lands only once it's whole, so what streams in before
  // that is only ever drawn over the passage (tentatively, by the composer),
  // and one that doesn't land never reaches the draft.
  it.each([
    {
      check: "fails before its end",
      dictated: DICTATED,
      streamed: "So fix the bug in the",
      verdict: "failed" as const,
    },
    {
      check: "keeps the passage after all",
      dictated: "run the review skill on auth and the parser",
      streamed: "/review on auth and the",
      verdict: "unchanged" as const,
    },
  ])(
    "only ever draws a reply that $check, then takes it away",
    async ({ dictated, streamed, verdict }) => {
      const {
        service,
        dictate,
        say,
        draft,
        flush,
        inputStore,
        pending,
        progress,
        ranges,
        sessionOf,
        drafts,
      } = await streamingSetup();
      dictate("panel-1", dictated);
      inputStore.getState().setDraftInput("panel-1", draft("panel-1") + "\n");
      say("and the lexr too");
      await service.stop();
      const before = draft("panel-1");

      progress(dictated, streamed);
      const shown = ranges("panel-1")[0]!.rewrite!.text;
      expect(shown).toBeTruthy();

      // The other passage is still out, so the pass hasn't landed: this reply
      // alone takes its rewrite away.
      pending.get(dictated)!.resolve({ action: "no_change", correctedText: dictated, verdict });
      await flush();
      expect(ranges("panel-1")[0]).toEqual({
        from: 0,
        to: dictated.length,
        session: sessionOf(dictated),
      });
      expect(draft("panel-1")).toBe(before);

      pending.get("and the lexr too")!.resolve({
        action: "replace",
        correctedText: "And the lexer too.",
      });
      await flush();
      expect(draft("panel-1")).toBe(`${dictated}\nAnd the lexer too.`);
      expect(drafts.filter((text) => text.includes(shown))).toEqual([]);
    }
  );
});

describe("VoiceRecordingService — a cleanup failure that will recur (#14963)", () => {
  beforeEach(() => {
    vi.resetModules();
    callbacks.delta = null;
    callbacks.complete = null;
    correct.mockReset();
    notify.mockReset();
    dictionary = [];
  });

  afterEach(() => {
    unsubscribeRanges?.();
    unsubscribeRanges = null;
    vi.unstubAllGlobals();
  });

  // Any error toast at all: a failure that may pass shows none.
  const told = () => notify.mock.calls.map(([toast]) => toast).filter((t) => t.type === "error");

  it("says so once, naming the account's provider, and keeps the words as dictated", async () => {
    const { service, dictate, draft, flush, voiceStore } = await setup();
    correct.mockResolvedValueOnce({
      action: "no_change",
      correctedText: "fix the parsr",
      failed: true,
      verdict: "failed",
      cleanupFailure: { reason: "billing_required", provider: "anthropic" },
    });

    dictate("panel-1", "fix the parsr");
    await service.stop();
    await flush();

    expect(draft("panel-1")).toBe("fix the parsr");
    expect(told()).toHaveLength(1);
    const [toast] = told();
    expect(toast).toMatchObject({
      type: "error",
      action: { actionId: "app.settings.openTab", actionArgs: { tab: "voice" } },
    });
    // The account that failed, not the provider the settings default to.
    expect(toast!.message).toContain("Anthropic");
    expect(voiceStore.getState().announcement?.text).toBe(toast!.message);
  });

  it("gives each reason its own fix", async () => {
    const { service, dictate, flush } = await setup();
    const reasons = [
      "key_rejected",
      "billing_required",
      "region_refused",
      "access_denied",
    ] as const;
    for (const reason of reasons) {
      correct.mockResolvedValueOnce({
        action: "no_change",
        correctedText: reason,
        failed: true,
        verdict: "failed",
        cleanupFailure: { reason, provider: "openai" },
      });
      dictate(`panel-${reason}`, reason);
      await service.stop();
      await flush();
    }

    const messages = told().map((toast) => toast.message);
    expect(messages).toHaveLength(reasons.length);
    expect(new Set(messages).size).toBe(reasons.length);
  });

  it("stays quiet for a failure main didn't hand the notice", async () => {
    const { service, dictate, draft, flush } = await setup();
    const untold: Array<() => Promise<CorrectResult>> = [
      async () => ({
        action: "no_change",
        correctedText: "timed out",
        failed: true,
        verdict: "timed_out",
      }),
      // The same outage, already told on an earlier reply.
      async () => ({
        action: "no_change",
        correctedText: "told before",
        failed: true,
        verdict: "failed",
      }),
      () => Promise.reject(new Error("IPC gone")),
    ];
    for (const [index, reply] of untold.entries()) {
      correct.mockImplementationOnce(reply);
      dictate(`panel-${index}`, `passage ${index}`);
      await service.stop();
      await flush();
      expect(draft(`panel-${index}`)).toBe(`passage ${index}`);
    }

    expect(told()).toEqual([]);
  });

  it("tells every reply main hands the notice, keeping no count of its own", async () => {
    const { service, dictate, flush } = await setup();
    const refused: CorrectResult = {
      action: "no_change",
      correctedText: "",
      failed: true,
      verdict: "failed",
      cleanupFailure: { reason: "key_rejected", provider: "openai" },
    };
    correct.mockResolvedValue(refused);

    dictate("panel-1", "first outage");
    await service.stop();
    await flush();
    dictate("panel-1", "second outage");
    await service.stop();
    await flush();

    expect(told()).toHaveLength(2);
  });
});
