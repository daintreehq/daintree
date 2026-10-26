import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentDictation } from "@shared/types";

// Drives the real voice, draft and history stores through stop() to prove a
// session's words are kept for recovery whatever happened to the draft (#14637).

// The service watches the panel list to stop a session whose panel goes.
type PanelListener = (state: { panelsById: Record<string, unknown> }) => void;
const panelListeners = vi.hoisted(() => [] as PanelListener[]);

vi.mock("@/store/panelStore", () => {
  const state = { panelsById: {}, panelIds: [], focusedId: null };
  const getState = () => state;
  const subscribe = vi.fn((listener: PanelListener) => {
    panelListeners.push(listener);
    return () => {};
  });
  return { usePanelStore: Object.assign(getState, { getState, subscribe }) };
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

const correct =
  vi.fn<(request: { rawText: string; recentContext?: string[] }) => Promise<CorrectResult>>();
const record = vi.fn<(dictation: RecentDictation) => Promise<void>>();
const setCorrectedText = vi.fn<(update: { id: string; correctedText: string }) => Promise<void>>();

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
      getSettings: vi.fn().mockResolvedValue({
        enabled: true,
        openaiApiKey: "sk-key",
        correctionEnabled: true,
      }),
      stop: vi.fn().mockResolvedValue(undefined),
      correct,
    },
    recentDictations: { record, setCorrectedText },
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
  const { voiceRecordingService: service } = await import("../VoiceRecordingService");
  unsubscribeRanges = subscribeDictationRangeTracking();
  service.initialize();
  await service.refreshConfiguration();

  let itemSeq = 0;
  const say = (text: string) => {
    const itemId = `item-${++itemSeq}`;
    callbacks.delta!({ text, itemId });
    callbacks.complete!({ text, willCorrect: false, itemId });
  };
  const begin = (panelId: string, panelTitle = "Claude") =>
    useVoiceRecordingStore.getState().beginSession({ panelId, panelTitle });
  // What main has been told, in order.
  const kept = () => record.mock.calls.map(([dictation]) => dictation);
  const cleanups = () => setCorrectedText.mock.calls.map(([update]) => update);
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  return {
    service,
    voiceStore: useVoiceRecordingStore,
    inputStore: useTerminalInputStore,
    say,
    begin,
    kept,
    cleanups,
    flush,
  };
}

let unsubscribeRanges: (() => void) | null = null;

describe("VoiceRecordingService — recent dictations (#14637)", () => {
  beforeEach(() => {
    vi.resetModules();
    callbacks.delta = null;
    callbacks.complete = null;
    callbacks.boundary = null;
    panelListeners.length = 0;
    correct.mockReset();
    record.mockReset().mockResolvedValue(undefined);
    setCorrectedText.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    unsubscribeRanges?.();
    unsubscribeRanges = null;
    vi.unstubAllGlobals();
  });

  it("hands main a stopped session's words and target, then its cleanup", async () => {
    const { service, begin, say, kept, cleanups, flush } = await setup();
    const cleanup = deferred<CorrectResult>();
    correct.mockReturnValueOnce(cleanup.promise);

    begin("panel-1", "Fix parser");
    say("fix the bug in the parsr");
    await service.stop();
    await flush();

    expect(kept()).toHaveLength(1);
    expect(kept()[0]).toMatchObject({
      rawText: "fix the bug in the parsr",
      correctedText: null,
      target: { panelId: "panel-1", panelTitle: "Fix parser" },
    });
    expect(cleanups()).toEqual([]);

    cleanup.resolve({ action: "replace", correctedText: "Fix the bug in the parser." });
    await flush();
    expect(cleanups()).toEqual([
      { id: kept()[0]!.id, correctedText: "Fix the bug in the parser." },
    ]);
  });

  it("keeps the cleanup even when the draft was sent before it returned", async () => {
    const { service, begin, say, kept, cleanups, flush, inputStore } = await setup();
    const cleanup = deferred<CorrectResult>();
    correct.mockReturnValueOnce(cleanup.promise);

    begin("panel-1");
    say("hello wrld");
    await service.stop();
    inputStore.getState().clearDraftInput("panel-1");

    cleanup.resolve({ action: "replace", correctedText: "Hello world." });
    await flush();
    expect(inputStore.getState().getDraftInput("panel-1")).toBe("");
    expect(cleanups()).toEqual([{ id: kept()[0]!.id, correctedText: "Hello world." }]);
  });

  it("sends nothing more when the cleanup changed nothing", async () => {
    const { service, begin, say, cleanups, flush } = await setup();
    correct.mockResolvedValueOnce({ action: "no_change", correctedText: "all good" });

    begin("panel-1");
    say("all good");
    await service.stop();
    await flush();

    expect(cleanups()).toEqual([]);
  });

  it("keeps every paragraph of a session, one entry per session", async () => {
    const { service, begin, say, kept, voiceStore } = await setup();
    voiceStore.getState().setCorrectionEnabled(false);

    begin("panel-1");
    say("first paragraph");
    callbacks.boundary!({ rawText: null });
    say("second one");
    say("continues");
    await service.stop();

    begin("panel-2");
    say("another session");
    await service.stop();

    expect(kept().map((d) => d.rawText)).toEqual([
      "first paragraph\nsecond one continues",
      "another session",
    ]);
    expect(new Set(kept().map((d) => d.id)).size).toBe(2);
  });

  it("keeps the words of a session that ended on an error", async () => {
    const { service, begin, say, kept } = await setup();

    begin("panel-1");
    say("the connection dropped here");
    callbacks.delta!({ text: "and this was mid", itemId: "late" });
    await service.stop("Dictation stopped because the connection failed.", {
      skipRemoteStop: true,
      nextStatus: "error",
      preserveLiveText: true,
    });

    expect(correct).not.toHaveBeenCalled();
    expect(kept().map((d) => d.rawText)).toEqual(["the connection dropped here and this was mid"]);
  });

  it("never lets a cleanup of part of the session stand in for all of it", async () => {
    const { service, begin, say, kept, cleanups, flush, inputStore } = await setup();
    correct.mockResolvedValueOnce({ action: "replace", correctedText: "Second part." });

    begin("panel-1");
    say("first part");
    // Sent mid-session: the first words leave the draft before the stop.
    inputStore.getState().clearDraftInput("panel-1");
    say("second part");
    await service.stop();
    await flush();

    expect(correct).toHaveBeenCalledWith(expect.objectContaining({ rawText: "second part" }));
    expect(kept().map((d) => d.rawText)).toEqual(["first part second part"]);
    expect(cleanups()).toEqual([]);
  });

  it("keeps nothing for a session that heard no words", async () => {
    const { service, begin, kept } = await setup();

    begin("panel-1");
    await service.stop();

    expect(kept()).toEqual([]);
  });

  it("still stops cleanly when main can't take the dictation", async () => {
    const { service, begin, say, kept, voiceStore, flush } = await setup();
    record.mockRejectedValueOnce(new Error("handler gone"));
    voiceStore.getState().setCorrectionEnabled(false);

    begin("panel-1");
    say("words");
    await expect(service.stop()).resolves.toBeUndefined();
    await flush();
    expect(kept().map((d) => d.rawText)).toEqual(["words"]);
    expect(voiceStore.getState().status).toBe("idle");
  });

  it("keeps the stopped session's words when a new start takes the target mid-teardown", async () => {
    const { service, begin, say, kept, voiceStore } = await setup();

    begin("panel-1");
    say("words from the first panel");
    const stopping = service.stop("Dictation stopped because the connection failed.", {
      skipRemoteStop: true,
      nextStatus: "error",
      preserveLiveText: true,
    });
    // A press after the error arms the next panel before the teardown ends.
    voiceStore.setState({ activeTarget: { panelId: "panel-2" }, status: "arming" });
    await stopping;

    expect(kept().map((d) => [d.rawText, d.target.panelId])).toEqual([
      ["words from the first panel", "panel-1"],
    ]);
  });

  it("keeps the words of a session whose panel was closed mid-dictation", async () => {
    const { begin, say, kept, voiceStore, flush } = await setup();
    voiceStore.getState().setCorrectionEnabled(false);

    begin("panel-1");
    say("words in a pane about to close");
    for (const listener of panelListeners) listener({ panelsById: {} });
    await vi.waitFor(() => expect(kept()).toHaveLength(1));
    await flush();

    expect(kept()[0]?.rawText).toBe("words in a pane about to close");
    // Read for the history first, then dropped with the panel.
    expect(voiceStore.getState().panelBuffers["panel-1"]).toBeUndefined();
  });

  it("drops the buffer of a panel closed while still arming", async () => {
    const { kept, voiceStore } = await setup();
    voiceStore.getState().setArming({ panelId: "panel-1" });
    voiceStore.getState().setSessionDraftStart("panel-1", 0);

    for (const listener of panelListeners) listener({ panelsById: {} });

    expect(voiceStore.getState().status).toBe("idle");
    expect(voiceStore.getState().panelBuffers["panel-1"]).toBeUndefined();
    expect(kept()).toEqual([]);
  });
});
