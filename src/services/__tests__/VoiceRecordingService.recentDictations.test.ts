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

const notify = vi.hoisted(() => vi.fn((_payload: Record<string, unknown>) => "notice"));
vi.mock("@/lib/notify", () => ({ notify }));

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
type CompletePayload = {
  text: string;
  willCorrect: boolean;
  itemId?: string;
  heard?: string;
  commandText?: string;
  send?: boolean;
};
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
      onCorrectionProgress: vi.fn(() => () => {}),
      onFileTokenResolved: vi.fn(() => () => {}),
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
      cancel: vi.fn().mockResolvedValue(undefined),
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
    dictionary = [];
    notify.mockClear();
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

  it("leaves the hesitations of an unfinished preview out of the draft a stop commits", async () => {
    const { service, begin, say, kept, inputStore } = await setup();

    begin("panel-1");
    say("the connection dropped here");
    callbacks.delta!({ text: "Um, and this was mid", itemId: "late" });
    await service.stop("Dictation stopped because the connection failed.", {
      skipRemoteStop: true,
      nextStatus: "error",
      preserveLiveText: true,
    });

    expect(inputStore.getState().getDraftInput("panel-1")).toBe(
      "the connection dropped here And this was mid"
    );
    expect(kept().map((d) => d.rawText)).toEqual(["the connection dropped here And this was mid"]);
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

  it("keeps scratched words out of the session, so its cleanup still counts", async () => {
    const { service, begin, say, kept, cleanups, flush, inputStore } = await setup();
    correct.mockResolvedValueOnce({ action: "replace", correctedText: "Keep this." });

    begin("panel-1");
    say("keep this");
    say("not this");
    say("scratch that");
    expect(inputStore.getState().getDraftInput("panel-1")).toBe("keep this");
    await service.stop();
    await flush();

    expect(kept().map((d) => d.rawText)).toEqual(["keep this"]);
    expect(cleanups()).toEqual([{ id: kept()[0]!.id, correctedText: "Keep this." }]);
  });

  it("keeps nothing for a session scratched down to no words", async () => {
    const { service, begin, say, kept, voiceStore } = await setup();
    voiceStore.getState().setCorrectionEnabled(false);

    begin("panel-1");
    say("never mind");
    say("scratch that");
    await service.stop();

    expect(kept()).toEqual([]);
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

  describe("a Canopy reply off screen (#14778)", () => {
    const REPLY = {
      panelId: "isolated-composer:run-1",
      panelTitle: "Reply to Claude",
      surface: "canopy-reply" as const,
      canopyRow: { runId: "run-1", hostScope: null },
    };

    it("lands its words in the reply's draft and cleans them up, with Canopy closed", async () => {
      const { service, voiceStore, inputStore, say, kept, cleanups, flush } = await setup();
      const cleanup = deferred<CorrectResult>();
      correct.mockReturnValueOnce(cleanup.promise);
      const { useCanopyStore } = await import("@/store/canopyStore");
      expect(useCanopyStore.getState().isOpen).toBe(false);

      voiceStore.getState().beginSession(REPLY);
      say("fix the logn bug");
      await service.stop();
      await flush();

      expect(inputStore.getState().getDraftInput(REPLY.panelId)).toBe("fix the logn bug");
      expect(kept()[0]).toMatchObject({
        rawText: "fix the logn bug",
        target: { panelId: REPLY.panelId, panelTitle: "Reply to Claude" },
      });
      expect(correct).toHaveBeenCalledTimes(1);

      cleanup.resolve({ action: "replace", correctedText: "Fix the login bug." });
      await flush();
      expect(inputStore.getState().getDraftInput(REPLY.panelId)).toBe("Fix the login bug.");
      expect(cleanups()).toEqual([{ id: kept()[0]!.id, correctedText: "Fix the login bug." }]);
    });

    it("keeps every word said into a reply whose run went mid-session", async () => {
      const { service, voiceStore, inputStore, say, kept, flush } = await setup();
      voiceStore.getState().setCorrectionEnabled(false);

      voiceStore.getState().beginSession(REPLY);
      say("first the parser");
      // Its run's terminal is removed: its drafts go with it, the grid's
      // panels change, and the session doesn't stop.
      inputStore.getState().clearTerminalState("run-1");
      for (const listener of panelListeners) listener({ panelsById: {} });
      expect(inputStore.getState().getDraftInput(REPLY.panelId)).toBe("");
      expect(voiceStore.getState().activeTarget?.panelId).toBe(REPLY.panelId);
      expect(kept()).toEqual([]);

      say("then the tests");
      await service.stop();
      await flush();

      expect(kept()).toHaveLength(1);
      expect(kept()[0]?.rawText).toBe("first the parser then the tests");
    });
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

  it("keeps the text the stop-time heard-as rules wrote, and the cleanup of it", async () => {
    dictionary = [{ term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 0 }];
    const { service, begin, say, kept, cleanups, flush, inputStore } = await setup();
    const cleanup = deferred<CorrectResult>();
    correct.mockReturnValueOnce(cleanup.promise);

    begin("panel-1");
    say("first paragraph");
    callbacks.boundary!({ rawText: null });
    say("add zoo");
    say("stand to the store");
    await service.stop();

    expect(inputStore.getState().getDraftInput("panel-1")).toBe(
      "first paragraph\nadd Zustand to the store"
    );
    expect(kept().map((d) => d.rawText)).toEqual(["first paragraph\nadd Zustand to the store"]);

    cleanup.resolve({
      action: "replace",
      correctedText: "First paragraph.\nAdd Zustand to the store.",
    });
    await flush();
    expect(cleanups()).toEqual([
      { id: kept()[0]!.id, correctedText: "First paragraph.\nAdd Zustand to the store." },
    ]);
  });

  it("rewrites only the words still in the draft, not the same words already sent", async () => {
    dictionary = [{ term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 0 }];
    const { service, begin, say, kept, voiceStore, inputStore } = await setup();
    voiceStore.getState().setCorrectionEnabled(false);

    begin("panel-1");
    say("zoo");
    say("stand");
    inputStore.getState().clearDraftInput("panel-1");
    say("zoo");
    say("stand");
    await service.stop();

    expect(inputStore.getState().getDraftInput("panel-1")).toBe("Zustand");
    expect(kept().map((d) => d.rawText)).toEqual(["zoo stand Zustand"]);
  });

  it("keeps no entry for a dictation Escape cancelled, and lets its words go", async () => {
    const { service, begin, say, kept, voiceStore, inputStore, flush } = await setup();

    begin("panel-1");
    say("words I meant to throw away");
    // The first press asks for a second (#14927).
    expect(service.handleEscape("panel-1")).toBe(true);
    expect(service.handleEscape("panel-1")).toBe(true);
    await vi.waitFor(() => expect(voiceStore.getState().status).toBe("idle"));
    await flush();

    expect(inputStore.getState().getDraftInput("panel-1")).toBe("");
    expect(kept()).toEqual([]);
    expect(voiceStore.getState().panelBuffers["panel-1"]?.completedSegments).toEqual([]);
  });

  it("keeps the entry when Escape stops and keeps an edited dictation", async () => {
    const { service, begin, say, kept, voiceStore, inputStore, flush } = await setup();
    voiceStore.getState().setCorrectionEnabled(false);

    begin("panel-1");
    say("hello world");
    inputStore.getState().setDraftInput("panel-1", "hello there");
    expect(service.handleEscape("panel-1")).toBe(true);
    await vi.waitFor(() => expect(voiceStore.getState().status).toBe("idle"));
    await flush();

    expect(inputStore.getState().getDraftInput("panel-1")).toBe("hello there");
    expect(kept().map((d) => d.rawText)).toEqual(["hello world"]);
  });

  it("keeps a spoken command as the command it wrote, and scratches in step with the draft", async () => {
    const { service, begin, say, kept, voiceStore, inputStore } = await setup();
    voiceStore.getState().setCorrectionEnabled(false);

    begin("panel-1");
    callbacks.delta!({ text: "slash review", itemId: "item-cmd" });
    callbacks.complete!({
      text: "slash review",
      commandText: "/review",
      willCorrect: false,
      itemId: "item-cmd",
    });
    say("the parser");
    say("scratch that");
    expect(inputStore.getState().getDraftInput("panel-1")).toBe("/review");
    await service.stop();

    expect(kept().map((d) => d.rawText)).toEqual(["/review"]);
  });

  it("keeps a command's arguments as the stop-time heard-as rules rewrote them", async () => {
    dictionary = [{ term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 0 }];
    const { service, begin, kept, voiceStore, inputStore } = await setup();
    voiceStore.getState().setCorrectionEnabled(false);

    begin("panel-1");
    callbacks.delta!({ text: "slash review zoo stand", itemId: "item-cmd" });
    callbacks.complete!({
      text: "slash review Zustand",
      heard: "slash review zoo stand",
      commandText: "/review zoo stand",
      willCorrect: false,
      itemId: "item-cmd",
    });
    await service.stop();

    expect(inputStore.getState().getDraftInput("panel-1")).toBe("/review Zustand");
    expect(kept().map((d) => d.rawText)).toEqual(["/review Zustand"]);
  });

  describe("another screen taking control (#15919)", () => {
    const PROJECT = "project-1";
    const DRIVEN = { kind: "driven-elsewhere" as const, driverName: "Studio Mac" };
    const gate = () => import("@/services/terminal/inputGate");
    const notices = () => notify.mock.calls.map(([payload]) => payload);

    afterEach(async () => {
      (await gate())._resetTerminalInputGateForTesting();
    });

    it("stops writing into the draft, keeps every word for recovery, and says why", async () => {
      const { voiceStore, inputStore, say, kept, flush } = await setup();
      const { setLeaseInputBlock } = await gate();
      voiceStore.getState().setCorrectionEnabled(false);
      const draft = () => inputStore.getState().getDraftInput("panel-1", PROJECT);

      const { useDictationRangeStore } = await import("@/store/dictationRangeStore");

      voiceStore.getState().beginSession({ panelId: "panel-1", projectId: PROJECT });
      const sessionId = voiceStore.getState().panelBuffers["panel-1"]!.dictationSessionId!;
      say("words before the takeover");
      callbacks.delta!({ text: "half a", itemId: "item-open" });
      expect(draft()).toBe("words before the takeover");

      setLeaseInputBlock(DRIVEN);
      // The new driver's drafts replace this view's.
      inputStore.getState().setDraftInput("panel-1", "the driver's draft", PROJECT);
      // Words still draining, a paragraph break, a scratch and a spoken send.
      callbacks.delta!({ text: "half a sentence", itemId: "item-open" });
      callbacks.complete!({
        text: "half a sentence",
        willCorrect: false,
        itemId: "item-open",
        send: true,
      });
      callbacks.boundary!({ rawText: null });
      say("scratch that");
      callbacks.delta!({ text: "an unfinished", itemId: "item-last" });
      // Its next words would have taken a place in the driver's draft. Read
      // before the stop's own release of it can run.
      expect(
        useDictationRangeStore
          .getState()
          .getAnchor({ sessionId, panelId: "panel-1", projectId: PROJECT })
      ).toBeNull();
      await vi.waitFor(() => expect(voiceStore.getState().status).toBe("idle"));
      await flush();

      expect(draft()).toBe("the driver's draft");
      expect(kept().map((d) => d.rawText)).toEqual([
        "words before the takeover half a sentence an unfinished",
      ]);
      expect(notices()).toEqual([
        expect.objectContaining({
          title: "Dictation stopped",
          message: "Studio Mac has control of this project. What you said is in Recent dictations.",
          action: expect.objectContaining({ actionId: "voiceInput.openRecentDictations" }),
        }),
      ]);
      expect(voiceStore.getState().announcement?.text).toMatch(/Studio Mac has control/);
      const { logInfo } = await import("@/utils/logger");
      expect(vi.mocked(logInfo)).toHaveBeenCalledWith(
        "[VoiceSend] Request refused",
        expect.objectContaining({ asker: "spoken_send", reason: "composer_disabled" })
      );

      // The driver going away changes the gate, not the stopped session.
      setLeaseInputBlock({ ...DRIVEN, driverAway: true });
      expect(notices()).toHaveLength(1);
    });

    it("names the host's own screen when that is what took control", async () => {
      const { voiceStore, say } = await setup();
      const { setLeaseInputBlock } = await gate();

      voiceStore.getState().beginSession({ panelId: "panel-1", projectId: PROJECT });
      say("words");
      setLeaseInputBlock({ ...DRIVEN, driverName: "Office iMac", driverIsHostScreen: true });

      expect(notices()[0]?.message).toMatch(/^Office iMac's own screen has control/);
    });

    it("lands no cleanup in a draft the driver took over, and still keeps it for recovery", async () => {
      const { service, voiceStore, inputStore, say, kept, cleanups, flush } = await setup();
      const { setLeaseInputBlock } = await gate();
      const cleanup = deferred<CorrectResult>();
      correct.mockReturnValueOnce(cleanup.promise);

      voiceStore.getState().beginSession({ panelId: "panel-1", projectId: PROJECT });
      say("fix the parsr");
      await service.stop();
      // The host held these words when the driver took over, so they stay.
      setLeaseInputBlock(DRIVEN);
      cleanup.resolve({ action: "replace", correctedText: "Fix the parser." });
      await flush();

      expect(inputStore.getState().getDraftInput("panel-1", PROJECT)).toBe("fix the parsr");
      expect(cleanups()).toEqual([{ id: kept()[0]!.id, correctedText: "Fix the parser." }]);
    });

    const refusedStart = expect.objectContaining({
      title: "Dictation didn't start",
      message: "Studio Mac has control of this project.",
    });

    it("refuses a dictation key press in a draft another screen drives, before arming", async () => {
      const { service, voiceStore } = await setup();
      const { setLeaseInputBlock } = await gate();
      setLeaseInputBlock({ ...DRIVEN, projectId: PROJECT });

      await service.toggle({ panelId: "panel-1", panelTitle: "Claude", projectId: PROJECT });

      expect(voiceStore.getState().status).toBe("idle");
      expect(voiceStore.getState().activeTarget).toBeNull();
      // Turned away before it counted as a place dictation went.
      expect(voiceStore.getState().recentTargets).toEqual([]);
      expect(notices()).toEqual([refusedStart]);
    });

    it("refuses a start made directly, as a retry or restart makes it", async () => {
      const { service, voiceStore } = await setup();
      const { setLeaseInputBlock } = await gate();
      setLeaseInputBlock(DRIVEN);
      voiceStore.getState().setArming({ panelId: "panel-1", projectId: PROJECT });

      await service.start({ panelId: "panel-1", projectId: PROJECT });

      expect(voiceStore.getState().status).toBe("idle");
      expect(voiceStore.getState().pendingTarget).toBeNull();
      expect(notices()).toEqual([refusedStart]);
    });

    it("cancels a start still arming when control moves", async () => {
      const { voiceStore } = await setup();
      const { setLeaseInputBlock } = await gate();
      voiceStore.getState().setArming({ panelId: "panel-1", projectId: PROJECT });

      setLeaseInputBlock(DRIVEN);

      expect(voiceStore.getState().status).toBe("idle");
      expect(voiceStore.getState().activeTarget).toBeNull();
      expect(notices()).toEqual([refusedStart]);
    });

    it("leaves dictation into another project's draft, or a Canopy reply, running", async () => {
      const { voiceStore, inputStore, say } = await setup();
      const { setLeaseInputBlock } = await gate();

      voiceStore.getState().beginSession({ panelId: "panel-1", projectId: "project-2" });
      setLeaseInputBlock({ ...DRIVEN, projectId: PROJECT });
      say("still mine");

      expect(voiceStore.getState().status).toBe("connecting");
      expect(inputStore.getState().getDraftInput("panel-1", "project-2")).toBe("still mine");

      voiceStore.getState().beginSession({
        panelId: "isolated-composer:run-1",
        surface: "canopy-reply",
        canopyRow: { runId: "run-1", hostScope: null },
      });
      setLeaseInputBlock(DRIVEN);
      say("a reply");

      expect(voiceStore.getState().status).toBe("connecting");
      expect(inputStore.getState().getDraftInput("isolated-composer:run-1")).toBe("a reply");
      expect(notices()).toEqual([]);
    });
  });

  it("keeps no entry for a spoken rewrite instruction", async () => {
    const { service, say, kept, voiceStore } = await setup();
    const release = vi.fn();
    voiceStore.getState().beginSession({
      panelId: "panel-1",
      rewrite: {
        selection: {
          text: "the selected text",
          range: () => null,
          onLost: () => {},
          apply: () => false,
          release,
        },
        instruction: [],
        cancelled: false,
      },
    });
    say("make this more formal");
    await service.stop("Dictation stopped because the connection failed.", {
      skipRemoteStop: true,
      nextStatus: "error",
      preserveLiveText: true,
    });

    expect(release).toHaveBeenCalled();
    expect(kept()).toEqual([]);
  });
});
