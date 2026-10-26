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
type CompletePayload = { text: string; willCorrect: boolean; itemId?: string };
type CorrectResult = { action: "no_change" | "replace"; correctedText: string };

const callbacks: {
  delta: ((payload: DeltaPayload) => void) | null;
  complete: ((payload: CompletePayload) => void) | null;
  boundary: ((payload: { rawText: string | null }) => void) | null;
} = { delta: null, complete: null, boundary: null };

const correct = vi.fn<(request: { rawText: string }) => Promise<CorrectResult>>();

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
  const { voiceRecordingService } = await import("../VoiceRecordingService");
  voiceRecordingService.initialize();
  await voiceRecordingService.refreshConfiguration();
  expect(useVoiceRecordingStore.getState().correctionEnabled).toBe(true);

  let itemSeq = 0;
  // One utterance through the real transcription handlers, the way a provider
  // delivers it: a delta, then its completion.
  const say = (text: string) => {
    const itemId = `item-${++itemSeq}`;
    callbacks.delta!({ text, itemId });
    callbacks.complete!({ text, willCorrect: false, itemId });
  };
  const dictate = (panelId: string, text: string) => {
    useVoiceRecordingStore.getState().beginSession({ panelId });
    say(text);
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

describe("VoiceRecordingService — post-stop correction ownership (#14611)", () => {
  beforeEach(() => {
    vi.resetModules();
    callbacks.delta = null;
    callbacks.complete = null;
    callbacks.boundary = null;
    correct.mockReset();
  });

  afterEach(() => {
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
    expect(correct).toHaveBeenLastCalledWith({ rawText: "fix the bug in the parsr" });

    dictate("panel-2", "second thought");
    await service.stop();

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
    expect(correct).toHaveBeenLastCalledWith({ rawText: "and the lexer" });
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
    expect(correct).toHaveBeenLastCalledWith({ rawText: "and the lexr too" });

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
    expect(correct).toHaveBeenLastCalledWith({ rawText: "and the lexer" });
  });

  it("keeps a passage's trailing break when its correction drops it, so a restart stays aligned", async () => {
    const { service, dictate, draft, flush, voiceStore } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    dictate("panel-1", "the parsr");
    callbacks.boundary!({ rawText: null });
    await service.stop();
    expect(correct).toHaveBeenLastCalledWith({ rawText: "the parsr\n" });

    voiceStore.getState().beginSession({ panelId: "panel-1" });
    callbacks.delta!({ text: "and the" });
    first.resolve({ action: "replace", correctedText: "The parser." });
    await flush();
    callbacks.complete!({ text: "and the lexer", willCorrect: false });
    expect(draft("panel-1")).toBe("The parser.\nand the lexer");

    correct.mockResolvedValueOnce({ action: "no_change", correctedText: "and the lexer" });
    await service.stop();
    expect(correct).toHaveBeenLastCalledWith({ rawText: "and the lexer" });
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

  it("clears the underline and drops pending corrections when the service is torn down", async () => {
    const { service, dictate, draft, flush, voiceStore } = await setup();
    const first = deferred<CorrectResult>();
    correct.mockReturnValueOnce(first.promise);

    dictate("panel-1", "hello wrld");
    await service.stop();
    expect(voiceStore.getState().panelBuffers["panel-1"]?.correctionRange).toEqual({
      from: 0,
      to: 10,
    });

    service.destroy();
    expect(voiceStore.getState().panelBuffers["panel-1"]?.correctionRange).toBeNull();

    first.resolve({ action: "replace", correctedText: "Hello world." });
    await flush();
    expect(draft("panel-1")).toBe("hello wrld");
  });
});
