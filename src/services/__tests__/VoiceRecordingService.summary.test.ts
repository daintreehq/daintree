import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_SESSION_SUMMARY_MESSAGE } from "@shared/utils/voiceLogFields";
import { VoiceSessionSummarySchema } from "@shared/types/voiceSessionSummary";
import { VOICE_REPORT_WAIT_MS } from "../voiceSessionTimeline";
import type { VoiceRecordingTarget } from "@/store/voiceRecordingStore";

// Drives real sessions through the service and reads the one summary line
// each leaves (#14617).

const draftState = vi.hoisted(() => ({ draft: "", onWrite: null as (() => void) | null }));

vi.mock("@/store/terminalInputStore", () => {
  const fns = {
    getDraftInput: vi.fn(() => draftState.draft),
    setDraftInput: vi.fn((_panelId: string, value: string) => {
      draftState.draft = value;
      draftState.onWrite?.();
    }),
    bumpExternalDraftRevision: vi.fn(),
    getSentPrompts: vi.fn(() => []),
  };
  const getState = () => fns;
  return {
    useTerminalInputStore: Object.assign(getState, { getState, subscribe: vi.fn(() => () => {}) }),
  };
});

// Its DOM reads need a real document, which this suite stubs in part; the
// suite that runs it for real is voiceComposerFocus.test.tsx.
vi.mock("@/services/voiceComposerFocus", () => ({
  beginDictationReturn: vi.fn(() => null),
  focusDictationComposer: vi.fn(),
  revealDictationComposer: vi.fn(),
}));

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

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: vi.fn(),
    getEffectiveCombos: vi.fn((actionId: string) =>
      actionId === "voiceInput.toggle" ? ["Cmd+D"] : []
    ),
    matchesEvent: vi.fn((event: { code: string }) => event.code === "KeyD"),
  },
}));

type Listener = (...args: unknown[]) => void;

interface WorkletNode {
  port: {
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage: (message: unknown) => void;
  };
  connect: () => void;
  disconnect: () => void;
}

// User content that must never reach the summary line.
const PANEL_TITLE = "Payments rewrite — Claude";
const DICTATED = "deploy the canopy branch to staging";
const KEYTERM = "zebrafish-migration";

const TARGET = { panelId: "panel-1", panelTitle: PANEL_TITLE, projectName: "Acme secret project" };
const OTHER_TARGET = { panelId: "panel-2", panelTitle: "Codex" };

const NO_PASSAGES = {
  sent: 0,
  applied: 0,
  unchanged: 0,
  skipped: 0,
  failed: 0,
  timedOut: 0,
  dropped: 0,
  unlanded: 0,
};

const REPORT = {
  provider: "openai",
  delayTier: "low",
  biasTermCount: 3,
  droppedPreStart: 0,
  droppedConnect: 0,
  droppedReplay: 0,
  reconnects: 1,
  completedSegments: 1,
  emptyCompletions: 0,
  prefetchesStarted: 1,
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setupGlobals(
  options: {
    correctionEnabled?: boolean;
    reportOnStop?: boolean;
    recordingMode?: "toggle" | "push-to-talk" | "tap-or-hold";
    dictionary?: Array<{ term: string; heardAs: string[]; source: "manual"; addedAt: number }>;
  } = {}
) {
  const callbacks = new Map<string, Listener>();
  const windowListeners = new Map<string, Listener[]>();
  const workletNodes: WorkletNode[] = [];
  const frames: Array<() => void> = [];
  const reportOnStop = options.reportOnStop ?? true;
  const on = (name: string) =>
    vi.fn((cb: Listener) => {
      callbacks.set(name, cb);
      return () => {};
    });

  const voiceInput = {
    onTranscriptionDelta: on("delta"),
    onTranscriptionComplete: on("complete"),
    onParagraphBoundary: on("paragraph"),
    onCorrectionProgress: on("correctionProgress"),
    onFileTokenResolved: on("fileToken"),
    onError: on("error"),
    onStatus: on("status"),
    onSessionEnded: on("ended"),
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
      transcriptionProvider: "openai",
      correctionEnabled: options.correctionEnabled ?? false,
      recordingMode: options.recordingMode ?? "toggle",
      deviceId: "",
      dictionary: options.dictionary ?? [],
    })),
    setSettings: vi.fn(),
    checkMicPermission: vi.fn().mockResolvedValue("granted"),
    requestMicPermission: vi.fn().mockResolvedValue(true),
    openMicSettings: vi.fn().mockResolvedValue(undefined),
    sendAudioChunk: vi.fn(),
    start: vi.fn().mockResolvedValue({ status: "started" }),
    // Main sends the ended notice, report and all, before the stop resolves.
    stop: vi.fn(async (sessionId: string) => {
      if (reportOnStop) {
        callbacks.get("ended")?.({ sessionId, reason: "stopped", report: REPORT });
      }
      return { rawText: null };
    }),
    // Main ends a cancelled session at once, sending its notice before the invoke resolves.
    cancel: vi.fn(async (sessionId: string) => {
      callbacks.get("ended")?.({ sessionId, reason: "cancelled", report: REPORT });
    }),
    correct: vi.fn(),
    rewrite: vi.fn().mockResolvedValue({ status: "replace", text: "Shorter." }),
  };

  vi.stubGlobal("window", {
    electron: {
      voiceInput,
      systemSleep: { onSuspend: vi.fn(() => () => {}), onWake: vi.fn(() => () => {}) },
    },
    addEventListener: vi.fn((type: string, cb: Listener) => {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), cb]);
    }),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((cb: () => void) => frames.push(cb))
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("AudioContext", function () {
    return {
      state: "running",
      destination: {},
      sampleRate: 24000,
      baseLatency: 0,
      addEventListener: vi.fn(),
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
      createOscillator: vi.fn(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      })),
      createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
      audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    };
  });
  vi.stubGlobal("AudioWorkletNode", function () {
    const node: WorkletNode = {
      port: {
        onmessage: null,
        postMessage: vi.fn((message: unknown) => {
          if ((message as { type?: string } | null)?.type !== "flush") return;
          void Promise.resolve().then(() => node.port.onmessage?.({ data: { type: "flushed" } }));
        }),
      },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    workletNodes.push(node);
    return node;
  });
  const getUserMedia = vi.fn(async () => {
    const track = {
      label: "MacBook Pro Microphone",
      readyState: "live",
      muted: false,
      enabled: true,
      stop: vi.fn(),
      getSettings: () => ({ deviceId: "builtin" }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia,
      enumerateDevices: vi.fn(async () => []),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });

  return {
    voiceInput,
    workletNodes,
    getUserMedia,
    emit: (name: string, payload: Record<string, unknown>) => callbacks.get(name)?.(payload),
    pressShortcut: (timeStamp: number) => {
      for (const cb of windowListeners.get("keydown") ?? []) {
        cb({ code: "KeyD", repeat: false, timeStamp });
      }
    },
    releaseShortcut: () => {
      for (const cb of windowListeners.get("keyup") ?? []) cb({ code: "KeyD" });
    },
    blurWindow: () => {
      for (const cb of windowListeners.get("blur") ?? []) cb();
    },
    paintFrames: () => {
      for (const frame of frames.splice(0)) frame();
    },
  };
}

type Harness = ReturnType<typeof setupGlobals>;

function sendChunk(node: WorkletNode, amplitude: number): void {
  node.port.onmessage?.({ data: new Int16Array(2400).fill(amplitude).buffer });
}

const flushPromises = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

let loadedService: { destroy: () => void } | null = null;

async function load() {
  const { logInfo, logWarn } = await import("@/utils/logger");
  const { voiceRecordingService } = await import("../VoiceRecordingService");
  loadedService = voiceRecordingService;
  voiceRecordingService.initialize();
  await flushPromises();
  const summaries = () =>
    vi
      .mocked(logInfo)
      .mock.calls.filter(([message]) => message === VOICE_SESSION_SUMMARY_MESSAGE)
      .map(([, context]) => context as Record<string, unknown>);
  return { service: voiceRecordingService, summaries, logWarn: vi.mocked(logWarn) };
}

/** Starts a session on `target` and brings its socket up with live audio. */
async function startLive(
  harness: Harness,
  service: Awaited<ReturnType<typeof load>>["service"],
  target: VoiceRecordingTarget = TARGET
) {
  await service.toggle(target);
  const sessionId = harness.voiceInput.start.mock.calls.at(-1)![0] as string;
  harness.paintFrames();
  sendChunk(harness.workletNodes.at(-1)!, 2_000);
  harness.emit("status", { sessionId, status: "recording" });
  return sessionId;
}

const SUMMARY_FIELDS = Object.keys(VoiceSessionSummarySchema.shape);

describe("VoiceRecordingService — session summary (#14617)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    draftState.draft = "";
    draftState.onWrite = null;
  });

  afterEach(() => {
    loadedService?.destroy();
    loadedService = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("logs one line per session, from the key press, with main's report and none of the text", async () => {
    const harness = setupGlobals();
    const { service, summaries } = await load();

    harness.pressShortcut(performance.now() - 25);
    const sessionId = await startLive(harness, service);
    harness.emit("delta", { sessionId, text: "deploy the" });
    harness.emit("complete", { sessionId, text: DICTATED, itemId: "item-1" });
    harness.paintFrames();
    await service.stop("Dictation stopped.", { preserveLiveText: true, reason: "user" });

    expect(draftState.draft).toBe(DICTATED);
    expect(summaries()).toHaveLength(1);
    const [line] = summaries();
    expect(line).toMatchObject({
      sessionId,
      origin: "key",
      stopReason: "user",
      backendEnd: "stopped",
      charsCommitted: DICTATED.length,
      audioNoText: false,
      correction: "none",
      ...REPORT,
    });
    for (const field of [
      "cueMs",
      "micLiveMs",
      "socketReadyMs",
      "firstTextMs",
      "stopTailMs",
      "stopSettledMs",
    ]) {
      expect([field, typeof line![field]]).toEqual([field, "number"]);
    }
    expect(Object.keys(line!).sort()).toEqual(["sessionId", ...SUMMARY_FIELDS].sort());
    const serialized = JSON.stringify(line);
    for (const secret of [PANEL_TITLE, "Acme", "canopy", "staging", KEYTERM]) {
      expect(serialized).not.toContain(secret);
    }
  });

  describe("another screen taking control (#15919)", () => {
    const DRIVEN_TARGET = { ...TARGET, projectId: "project-1" };
    const takeControl = async () =>
      (await import("@/services/terminal/inputGate")).setLeaseInputBlock({
        kind: "driven-elsewhere",
        driverName: "Studio Mac",
      });
    /** Holds main's graceful drain open until `drain.resolve()`. */
    const holdDrain = (harness: Harness) => {
      const drain = deferred();
      harness.voiceInput.stop.mockImplementationOnce(async (id: string) => {
        await drain.promise;
        harness.emit("ended", { sessionId: id, reason: "stopped", report: REPORT });
        return { rawText: null };
      });
      return drain;
    };

    it("logs the session as lease_lost, counting none of the words its drain still brought", async () => {
      const harness = setupGlobals();
      const { service, summaries } = await load();

      const sessionId = await startLive(harness, service, DRIVEN_TARGET);
      harness.emit("complete", { sessionId, text: DICTATED, itemId: "item-1" });
      harness.paintFrames();
      const drain = holdDrain(harness);
      await takeControl();
      await vi.waitFor(() => expect(harness.voiceInput.stop).toHaveBeenCalledWith(sessionId));
      harness.emit("complete", { sessionId, text: "words for nobody", itemId: "item-2" });
      drain.resolve();
      await vi.waitFor(() => expect(summaries()).toHaveLength(1));

      expect(draftState.draft).toBe(DICTATED);
      expect(summaries()[0]).toMatchObject({
        sessionId,
        stopReason: "lease_lost",
        backendEnd: "stopped",
        charsCommitted: DICTATED.length,
      });
    });

    it("never begins a restart queued behind the stop", async () => {
      const harness = setupGlobals();
      const { service } = await load();
      const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");

      await startLive(harness, service, DRIVEN_TARGET);
      const drain = holdDrain(harness);
      const stopping = service.stop("Dictation stopped.", { preserveLiveText: true });
      await vi.waitFor(() => expect(harness.voiceInput.stop).toHaveBeenCalled());
      const restarting = service.toggle(DRIVEN_TARGET);
      expect(useVoiceRecordingStore.getState().pendingTarget?.panelId).toBe("panel-1");
      await takeControl();
      // Cancelled at once, not left for the drain to hand the mic to.
      expect(useVoiceRecordingStore.getState().pendingTarget).toBeNull();
      drain.resolve();
      await Promise.all([stopping, restarting]);

      expect(harness.voiceInput.start).toHaveBeenCalledTimes(1);
      expect(useVoiceRecordingStore.getState().status).toBe("idle");
    });

    it("never begins a start that was on its way when control moved, armed or not", async () => {
      const harness = setupGlobals();
      const { service } = await load();
      const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");

      await startLive(harness, service, DRIVEN_TARGET);
      const drain = holdDrain(harness);
      const stopping = service.stop("Dictation stopped.", { preserveLiveText: true });
      await vi.waitFor(() => expect(harness.voiceInput.stop).toHaveBeenCalled());
      // A retry or a restart calls start() itself, with nothing left pending.
      const starting = service.start(DRIVEN_TARGET);
      expect(useVoiceRecordingStore.getState().pendingTarget).toBeNull();
      await takeControl();
      drain.resolve();
      await Promise.all([stopping, starting]);

      expect(harness.voiceInput.start).toHaveBeenCalledTimes(1);
      expect(useVoiceRecordingStore.getState().status).toBe("idle");
    });

    it("gives back the selection of a rewrite start it turned away", async () => {
      const harness = setupGlobals();
      const { service } = await load();
      const release = vi.fn();
      const rewriteTarget: VoiceRecordingTarget = {
        ...DRIVEN_TARGET,
        rewrite: {
          selection: {
            text: "the selected text",
            range: () => ({ from: 0, to: 17 }),
            onLost: () => {},
            apply: () => false,
            release,
          },
          instruction: [],
          cancelled: false,
        },
      };

      await startLive(harness, service, DRIVEN_TARGET);
      const drain = holdDrain(harness);
      const stopping = service.stop("Dictation stopped.", { preserveLiveText: true });
      await vi.waitFor(() => expect(harness.voiceInput.stop).toHaveBeenCalled());
      const starting = service.start(rewriteTarget);
      await takeControl();
      drain.resolve();
      await Promise.all([stopping, starting]);

      expect(harness.voiceInput.start).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalled();
    });
  });

  it("drops a report that smuggles text, still logging the session once", async () => {
    const harness = setupGlobals({ reportOnStop: false });
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    harness.voiceInput.stop.mockImplementationOnce(async () => {
      harness.emit("ended", {
        sessionId,
        reason: "stopped",
        report: { ...REPORT, provider: KEYTERM, keyterms: [KEYTERM] },
      });
      return { rawText: null };
    });
    await service.stop("Dictation stopped.", { reason: "user" });

    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toMatchObject({ backendEnd: "stopped", provider: "openai" });
    expect(JSON.stringify(summaries()[0])).not.toContain(KEYTERM);
  });

  it("leaves no summary for a rewrite session, and still logs the dictation after it", async () => {
    const harness = setupGlobals();
    const { service, summaries, logWarn } = await load();
    const selection = {
      text: "make me shorter",
      range: vi.fn(() => ({ from: 0, to: 15 })),
      onLost: vi.fn(),
      apply: vi.fn(() => true),
      release: vi.fn(),
    };

    harness.pressShortcut(performance.now() - 25);
    await service.start({ ...TARGET, rewrite: { selection, instruction: [], cancelled: false } });
    const rewriteId = String(harness.voiceInput.start.mock.calls.at(-1)![0]);
    harness.paintFrames();
    sendChunk(harness.workletNodes.at(-1)!, 2_000);
    harness.emit("status", { sessionId: rewriteId, status: "recording" });
    harness.emit("delta", { sessionId: rewriteId, text: "make it" });
    harness.emit("complete", { sessionId: rewriteId, text: "make it shorter", itemId: "item-1" });
    harness.paintFrames();
    await service.stop("Dictation stopped.", { preserveLiveText: true, reason: "user" });
    await flushPromises();
    harness.paintFrames();

    expect(harness.voiceInput.rewrite).toHaveBeenCalledTimes(1);
    expect(draftState.draft).toBe("");
    expect(summaries()).toHaveLength(0);

    const sessionId = await startLive(harness, service);
    await service.stop("Dictation stopped.", { reason: "user" });

    expect(summaries()).toMatchObject([{ sessionId, stopReason: "user" }]);
    expect(logWarn).not.toHaveBeenCalledWith("[VoiceSession] Summary rejected", expect.anything());
  });

  it("marks the session whose start reopened a waiting send, and no other (#15704)", async () => {
    const harness = setupGlobals();
    const { service, summaries } = await load();

    // The dictation key arms its target before a session, or its timeline, exists.
    const armed = { ...TARGET };
    service.noteSendReopened({ target: armed });
    const first = await startLive(harness, service, armed);
    await service.stop("Dictation stopped.", { reason: "user" });

    // The same object starts again, as a microphone switch or a locked dictation
    // does: the note went with the start it was made for.
    const second = await startLive(harness, service, armed);
    await service.stop("Dictation stopped.", { reason: "user" });

    // A session that began without a press is named by its id.
    const third = await startLive(harness, service, { ...TARGET });
    service.noteSendReopened({ sessionId: third });
    service.noteSendReopened({ sessionId: "session-already-logged" });
    await service.stop("Dictation stopped.", { reason: "user" });

    expect(summaries()).toMatchObject([
      { sessionId: first, reopenedSend: true },
      { sessionId: second, reopenedSend: false },
      { sessionId: third, reopenedSend: true },
    ]);
  });

  it("falls back to start() entry without a shortcut press", async () => {
    const harness = setupGlobals();
    const { service, summaries } = await load();
    await startLive(harness, service);
    await service.stop("Dictation stopped.", { reason: "user" });

    expect(summaries()).toMatchObject([{ origin: "call" }]);
  });

  it("counts what the utterances committed, not the stop-time heard-as rewrite", async () => {
    const harness = setupGlobals({
      dictionary: [{ term: "Zustand", heardAs: ["zoo stand"], source: "manual", addedAt: 1 }],
    });
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    harness.emit("complete", { sessionId, text: "use zoo", itemId: "item-1" });
    harness.emit("complete", { sessionId, text: "stand now", itemId: "item-2" });
    harness.paintFrames();
    await service.stop("Dictation stopped.", { preserveLiveText: true, reason: "user" });

    expect(draftState.draft).toBe("use Zustand now");
    expect(summaries()).toMatchObject([{ charsCommitted: "use zoo".length + "stand now".length }]);
  });

  it("measures the stop from the last speech-level chunk, past the quieter ones after it", async () => {
    const harness = setupGlobals();
    const { service, summaries } = await load();
    let clock = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    await startLive(harness, service);
    clock += 400;
    sendChunk(harness.workletNodes.at(-1)!, 2_000);
    clock += 100;
    // Room noise: over the signal floor, under speech level.
    sendChunk(harness.workletNodes.at(-1)!, 100);
    clock += 900;
    await service.stop("Dictation stopped.", { reason: "user" });

    expect(summaries()).toMatchObject([{ stopTailMs: 1_000, audioNoText: true }]);
  });

  it("reads speech the stop's flush handed over as speech up to the stop", async () => {
    const harness = setupGlobals();
    const { service, summaries } = await load();
    let clock = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    await startLive(harness, service);
    const node = harness.workletNodes.at(-1)!;
    // The worklet's partial chunk, said before the stop, lands after it.
    vi.mocked(node.port.postMessage).mockImplementation((message: unknown) => {
      if ((message as { type?: string } | null)?.type !== "flush") return;
      // Posted back from the audio thread, after the stop is under way.
      void Promise.resolve().then(() => {
        clock += 30;
        sendChunk(node, 2_000);
        node.port.onmessage?.({ data: { type: "flushed" } });
      });
    });
    clock += 800;
    await service.stop("Dictation stopped.", { reason: "user" });

    expect(summaries()).toMatchObject([{ stopTailMs: 0 }]);
  });

  it("has no stop tail for a session that heard nothing at speech level", async () => {
    const harness = setupGlobals();
    const { service, summaries } = await load();
    await service.toggle(TARGET);
    const sessionId = harness.voiceInput.start.mock.calls.at(-1)![0] as string;
    harness.paintFrames();
    sendChunk(harness.workletNodes.at(-1)!, 100);
    harness.emit("status", { sessionId, status: "recording" });
    await service.stop("Dictation stopped.", { reason: "user" });

    expect(summaries()).toMatchObject([{ stopTailMs: null, audioNoText: true }]);
  });

  it("flags a session that heard speech-level audio and committed nothing", async () => {
    const harness = setupGlobals();
    const { service, summaries } = await load();
    await startLive(harness, service);
    await service.stop("Dictation stopped.", { reason: "user" });

    expect(summaries()).toMatchObject([
      { audioNoText: true, charsCommitted: 0, firstTextMs: null },
    ]);
  });

  it("closes a start cancelled while the permission prompt is open, without waiting on it", async () => {
    const harness = setupGlobals();
    harness.voiceInput.checkMicPermission.mockResolvedValue("not-determined");
    harness.voiceInput.requestMicPermission.mockReturnValue(new Promise(() => {}));
    const { service, summaries } = await load();

    void service.toggle(TARGET);
    await flushPromises();
    await service.toggle(TARGET);
    harness.paintFrames();

    expect(harness.voiceInput.start).not.toHaveBeenCalled();
    expect(summaries()).toMatchObject([
      { stopReason: "user", backendEnd: "none", micLiveMs: null, provider: "openai" },
    ]);
  });

  it("logs a start that failed on its own as start_failed", async () => {
    const harness = setupGlobals();
    harness.getUserMedia.mockRejectedValueOnce(new DOMException("busy", "NotReadableError"));
    const { service, summaries } = await load();

    await service.toggle(TARGET);
    harness.paintFrames();

    expect(summaries()).toMatchObject([{ stopReason: "start_failed", backendEnd: "none" }]);
  });

  it("closes a session a newer start made stale before its socket came up", async () => {
    const harness = setupGlobals();
    harness.voiceInput.checkMicPermission
      .mockResolvedValueOnce("granted")
      .mockResolvedValue("not-determined");
    harness.voiceInput.requestMicPermission.mockReturnValue(new Promise(() => {}));
    const connected = deferred<{ status: string }>();
    harness.voiceInput.start.mockReturnValueOnce(connected.promise);
    const { service, summaries } = await load();

    void service.toggle(TARGET);
    await vi.waitFor(() => expect(harness.voiceInput.start).toHaveBeenCalledTimes(1));
    const first = harness.voiceInput.start.mock.calls[0]![0] as string;
    // The newer start waits on a permission prompt; no stop takes the first.
    void service.toggle(OTHER_TARGET);
    await flushPromises();
    connected.resolve({ status: "started" });
    await flushPromises();
    // Another view's start then replaces the first in main, which also ends
    // this view's start still waiting on its prompt (#14600).
    harness.emit("ended", { sessionId: first, reason: "superseded", report: REPORT });
    await flushPromises();
    harness.paintFrames();

    expect(summaries()).toMatchObject([
      { sessionId: first, stopReason: "retarget", backendEnd: "superseded" },
      { stopReason: "superseded", backendEnd: "none" },
    ]);
  });

  it("logs a session another view's start replaced as superseded", async () => {
    const harness = setupGlobals({ reportOnStop: false });
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    harness.emit("complete", { sessionId, text: DICTATED, itemId: "item-1" });
    harness.paintFrames();
    // Main drains it for the other view's start, then ends it.
    harness.emit("status", { sessionId, status: "finishing" });
    await vi.waitFor(() => expect(harness.voiceInput.stop).toHaveBeenCalledWith(sessionId));
    harness.emit("ended", { sessionId, reason: "superseded", report: REPORT });
    await flushPromises();

    expect(summaries()).toMatchObject([
      {
        sessionId,
        stopReason: "superseded",
        backendEnd: "superseded",
        charsCommitted: DICTATED.length,
      },
    ]);
  });

  it("logs an Escape that cancels the dictation once, as escape, with main's cancelled report", async () => {
    const harness = setupGlobals();
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    harness.emit("complete", { sessionId, text: DICTATED, itemId: "item-1" });
    harness.paintFrames();
    expect(draftState.draft).toBe(DICTATED);

    // The first press asks for a second (#14927).
    expect(service.handleEscape(TARGET.panelId)).toBe(true);
    expect(service.handleEscape(TARGET.panelId)).toBe(true);
    await vi.waitFor(() => expect(harness.voiceInput.cancel).toHaveBeenCalledWith(sessionId));
    await flushPromises();
    harness.paintFrames();

    expect(draftState.draft).toBe("");
    expect(harness.voiceInput.stop).not.toHaveBeenCalled();
    expect(summaries()).toHaveLength(1);
    const [line] = summaries();
    expect(line).toMatchObject({
      sessionId,
      stopReason: "escape",
      backendEnd: "cancelled",
      charsCommitted: DICTATED.length,
      ...REPORT,
    });
    expect(typeof line!.stopRequestedMs).toBe("number");
    expect(Object.keys(line!).sort()).toEqual(["sessionId", ...SUMMARY_FIELDS].sort());
    expect(JSON.stringify(line)).not.toContain("canopy");
  });

  it("logs a session whose backend failed to start as start_failed, with main's ending", async () => {
    const harness = setupGlobals();
    harness.voiceInput.start.mockImplementationOnce(async (sessionId: string) => {
      harness.emit("ended", { sessionId, reason: "failed", report: REPORT });
      return { status: "failed", error: "OpenAI API key not configured" };
    });
    const { service, summaries } = await load();
    await service.toggle(TARGET);
    harness.paintFrames();

    expect(summaries()).toMatchObject([
      { stopReason: "start_failed", backendEnd: "failed", socketReadyMs: null },
    ]);
    expect(JSON.stringify(summaries()[0])).not.toContain("not configured");
  });

  it("takes socket ready from the start outcome and first text from a lone completion", async () => {
    const harness = setupGlobals();
    const { service, summaries } = await load();
    await service.toggle(TARGET);
    harness.paintFrames();
    const sessionId = harness.voiceInput.start.mock.calls[0]![0] as string;
    harness.emit("complete", { sessionId, text: DICTATED, itemId: "item-1" });
    harness.paintFrames();
    await service.stop("Dictation stopped.", { reason: "user" });

    const [line] = summaries();
    expect(typeof line!.socketReadyMs).toBe("number");
    expect(typeof line!.firstTextMs).toBe("number");
    expect(line).toMatchObject({ charsCommitted: DICTATED.length, micLiveMs: null });
  });

  it("logs text that lands during the stop once its frame paints", async () => {
    const harness = setupGlobals({ reportOnStop: false });
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    harness.voiceInput.stop.mockImplementationOnce(async () => {
      harness.emit("complete", { sessionId, text: DICTATED, itemId: "item-1" });
      harness.emit("ended", { sessionId, reason: "stopped", report: REPORT });
      return { rawText: null };
    });
    await service.stop("Dictation stopped.", { reason: "key_release" });
    expect(summaries()).toHaveLength(0);

    harness.paintFrames();
    expect(summaries()).toHaveLength(1);
    expect(typeof summaries()[0]!.firstTextMs).toBe("number");
  });

  it("keeps a retarget's two sessions apart while the old one drains", async () => {
    const harness = setupGlobals({ reportOnStop: false });
    const { service, summaries } = await load();
    const first = await startLive(harness, service);
    const drain = deferred();
    harness.voiceInput.stop.mockImplementationOnce(async (sessionId: string) => {
      await drain.promise;
      harness.emit("ended", { sessionId, reason: "stopped", report: REPORT });
      return { rawText: null };
    });

    const retargeting = service.toggle(OTHER_TARGET);
    await vi.waitFor(() => expect(harness.voiceInput.stop).toHaveBeenCalledWith(first));
    // The old session's last words, and the new mic already live, mid-drain.
    harness.emit("complete", { sessionId: first, text: "first words", itemId: "item-1" });
    sendChunk(harness.workletNodes.at(-1)!, 2_000);
    drain.resolve();
    await retargeting;
    harness.paintFrames();
    const second = harness.voiceInput.start.mock.calls.at(-1)![0] as string;

    expect(second).not.toBe(first);
    expect(summaries()).toMatchObject([
      { sessionId: first, stopReason: "retarget", charsCommitted: "first words".length },
    ]);

    harness.voiceInput.stop.mockImplementationOnce(async (sessionId: string) => {
      harness.emit("ended", { sessionId, reason: "stopped", report: REPORT });
      return { rawText: null };
    });
    harness.emit("complete", { sessionId: second, text: "second", itemId: "item-2" });
    harness.paintFrames();
    await service.stop("Dictation stopped.", { reason: "escape" });
    expect(summaries()).toHaveLength(2);
    expect(summaries()[1]).toMatchObject({
      sessionId: second,
      stopReason: "escape",
      charsCommitted: "second".length,
    });
    expect(typeof summaries()[1]!.micLiveMs).toBe("number");
  });

  describe("a stop held until the start's queued audio is sent", () => {
    async function retargetWithHeldDrain() {
      const harness = setupGlobals({ recordingMode: "push-to-talk" });
      const loaded = await load();
      const first = await startLive(harness, loaded.service);
      const drain = deferred();
      harness.voiceInput.stop.mockImplementationOnce(async (sessionId: string) => {
        await drain.promise;
        harness.emit("ended", { sessionId, reason: "stopped", report: REPORT });
        return { rawText: null };
      });
      const pressAt = performance.now();
      harness.pressShortcut(pressAt);
      const retargeting = loaded.service.toggle(OTHER_TARGET);
      await vi.waitFor(() => expect(harness.voiceInput.stop).toHaveBeenCalledWith(first));
      return { harness, ...loaded, first, drain, pressAt, retargeting };
    }

    const pause = () => new Promise((resolve) => setTimeout(resolve, 25));

    it("keeps the release's reason and its time", async () => {
      const { harness, summaries, drain, pressAt, retargeting } = await retargetWithHeldDrain();
      harness.releaseShortcut();
      const releasedMs = performance.now() - pressAt;
      await pause();
      drain.resolve();
      await retargeting;
      harness.paintFrames();
      await vi.waitFor(() => expect(summaries()).toHaveLength(2));

      const second = summaries()[1]!;
      expect(second).toMatchObject({ origin: "key", stopReason: "key_release" });
      expect(second.stopRequestedMs as number).toBeLessThanOrEqual(Math.ceil(releasedMs));
    });

    it("forgets the held stop when a press resumes the start", async () => {
      const { harness, service, summaries, drain, pressAt, retargeting } =
        await retargetWithHeldDrain();
      harness.releaseShortcut();
      await service.toggle(OTHER_TARGET);
      await pause();
      drain.resolve();
      await retargeting;
      harness.paintFrames();
      const resumedMs = performance.now() - pressAt;
      expect(summaries()).toHaveLength(1);

      await service.stop("Dictation stopped.", { reason: "escape" });
      const second = summaries()[1]!;
      expect(second).toMatchObject({ stopReason: "escape" });
      expect(second.stopRequestedMs as number).toBeGreaterThanOrEqual(Math.floor(resumedMs));
    });
  });

  describe("tap-or-hold", () => {
    // A hold that heard speech: pressed, started, two speech-level chunks, and
    // past the hold threshold by the time it comes back up.
    async function holdWithSpeech() {
      const harness = setupGlobals({ recordingMode: "tap-or-hold" });
      const loaded = await load();
      harness.pressShortcut(performance.now());
      const sessionId = await startLive(harness, loaded.service);
      sendChunk(harness.workletNodes.at(-1)!, 2_000);
      const realNow = performance.now.bind(performance);
      vi.spyOn(performance, "now").mockImplementation(() => realNow() + 1_000);
      return { harness, ...loaded, sessionId };
    }

    it("names a held key's release as key_release", async () => {
      const { harness, summaries, sessionId } = await holdWithSpeech();
      harness.releaseShortcut();
      await vi.waitFor(() => expect(summaries()).toHaveLength(1));
      expect(summaries()[0]).toMatchObject({ sessionId, origin: "key", stopReason: "key_release" });
    });

    it("names a blur while the key is held as window_blur", async () => {
      const { harness, summaries, sessionId } = await holdWithSpeech();
      harness.blurWindow();
      await vi.waitFor(() => expect(summaries()).toHaveLength(1));
      expect(summaries()[0]).toMatchObject({ sessionId, stopReason: "window_blur" });
    });

    it("logs nothing for a tap's release or for the release of the press that stopped it", async () => {
      const harness = setupGlobals({ recordingMode: "tap-or-hold" });
      const { service, summaries } = await load();
      harness.pressShortcut(performance.now());
      const sessionId = await startLive(harness, service);
      harness.releaseShortcut();
      await flushPromises();
      expect(harness.voiceInput.stop).not.toHaveBeenCalled();
      expect(summaries()).toHaveLength(0);

      harness.pressShortcut(performance.now());
      await service.toggle(TARGET);
      harness.releaseShortcut();
      await flushPromises();
      expect(summaries()).toMatchObject([{ sessionId, stopReason: "user" }]);
      expect(harness.voiceInput.start).toHaveBeenCalledTimes(1);
    });
  });

  it("waits for main's report, and logs without it once it is overdue", async () => {
    const harness = setupGlobals({ reportOnStop: false });
    const { service, summaries } = await load();
    await startLive(harness, service);
    vi.useFakeTimers();
    const stopping = service.stop("Dictation stopped.", { reason: "wake", skipRemoteStop: true });
    await vi.advanceTimersByTimeAsync(0);
    await stopping;
    expect(summaries()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(VOICE_REPORT_WAIT_MS);
    expect(summaries()).toMatchObject([
      { stopReason: "wake", backendEnd: "unreported", provider: "openai", reconnects: null },
    ]);
  });

  it("waits for the correction and records how it went, part by part", async () => {
    const harness = setupGlobals({ correctionEnabled: true });
    const correction = deferred<{
      action: string;
      correctedText: string;
      timing: { prepMs: number; requestMs: number };
      prefetch: string;
    }>();
    harness.voiceInput.correct.mockReturnValue(correction.promise);
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    harness.emit("complete", { sessionId, text: DICTATED, itemId: "item-1" });
    harness.paintFrames();
    await service.stop("Dictation stopped.", { reason: "user" });

    // Only the correction is left to wait on. Its passage names the session,
    // whose context main read while it ran.
    expect(harness.voiceInput.correct).toHaveBeenCalledTimes(1);
    expect(harness.voiceInput.correct).toHaveBeenCalledWith(expect.objectContaining({ sessionId }));
    expect(summaries()).toHaveLength(0);
    // The clock moves only as the draft takes the result, so that is all the
    // apply time can hold.
    let clock = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    draftState.onWrite = () => {
      clock += 40;
    };
    correction.resolve({
      action: "replace",
      correctedText: "Deploy the canopy branch to staging.",
      timing: { prepMs: 14.2, requestMs: 1380.7 },
      // Main found no prefetch of it, of the one the session started.
      prefetch: "not_matched",
    });
    await flushPromises();
    harness.paintFrames();

    expect(draftState.draft).toBe("Deploy the canopy branch to staging.");
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toMatchObject({
      correction: "applied",
      correctionPrepMs: 14,
      correctionRequestMs: 1381,
      correctionApplyMs: 40,
      correctionPrefetch: "request_changed",
      prefetchesStarted: 1,
    });
    expect(typeof summaries()[0]!.correctionMs).toBe("number");
    expect(JSON.stringify(summaries()[0])).not.toContain("canopy");
    expect(summaries()[0]!.correctionPassages).toEqual({ ...NO_PASSAGES, sent: 1, applied: 1 });
  });

  // Main's verdict for the one passage sent, and the field that counts it.
  it.each([
    ["unchanged", "unchanged", "unchanged"],
    ["skipped", "unchanged", "skipped"],
    ["failed", "failed", "failed"],
    ["timed_out", "failed", "timedOut"],
  ] as const)("counts a passage main answered %s under %s", async (verdict, correction, field) => {
    const harness = setupGlobals({ correctionEnabled: true });
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    const failed = verdict === "failed" || verdict === "timed_out";
    harness.voiceInput.correct.mockResolvedValue({
      action: "no_change",
      correctedText: DICTATED,
      verdict,
      ...(failed ? { failed: true } : {}),
    });
    harness.emit("complete", { sessionId, text: DICTATED, itemId: "item-1" });
    harness.paintFrames();
    await service.stop("Dictation stopped.", { reason: "user" });
    await flushPromises();

    expect(summaries()).toMatchObject([{ correction }]);
    expect(summaries()[0]!.correctionPassages).toEqual({ ...NO_PASSAGES, sent: 1, [field]: 1 });
    expect(JSON.stringify(summaries()[0])).not.toContain("canopy");
  });

  it("counts a failed reply that names no verdict as failed, not unchanged", async () => {
    const harness = setupGlobals({ correctionEnabled: true });
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    harness.voiceInput.correct.mockResolvedValue({
      action: "no_change",
      correctedText: DICTATED,
      failed: true,
    });
    harness.emit("complete", { sessionId, text: DICTATED, itemId: "item-1" });
    harness.paintFrames();
    await service.stop("Dictation stopped.", { reason: "user" });
    await flushPromises();

    expect(summaries()[0]!.correctionPassages).toEqual({ ...NO_PASSAGES, sent: 1, failed: 1 });
  });

  it("counts a request that threw as failed", async () => {
    const harness = setupGlobals({ correctionEnabled: true });
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    harness.voiceInput.correct.mockRejectedValue(new Error(`boom ${DICTATED}`));
    harness.emit("complete", { sessionId, text: DICTATED, itemId: "item-1" });
    harness.paintFrames();
    await service.stop("Dictation stopped.", { reason: "user" });
    await flushPromises();

    expect(summaries()[0]!.correctionPassages).toEqual({ ...NO_PASSAGES, sent: 1, failed: 1 });
    expect(summaries()[0]).toMatchObject({
      correctionPrefetch: null,
      correctionPrepMs: null,
      correctionRequestMs: null,
    });
  });

  it("logs the prefetch a stop's reply took", async () => {
    const harness = setupGlobals({ correctionEnabled: true });
    harness.voiceInput.correct.mockResolvedValue({
      action: "replace",
      correctedText: "Deploy the canopy branch to staging.",
      timing: { prepMs: 3, requestMs: 1_200 },
      prefetch: "adopted",
    });
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    harness.emit("complete", { sessionId, text: DICTATED, itemId: "item-1" });
    harness.paintFrames();
    await service.stop("Dictation stopped.", { reason: "user" });
    await flushPromises();

    expect(summaries()[0]).toMatchObject({
      correctionPrefetch: "adopted",
      correctionRequestMs: 1_200,
    });
  });

  it("counts a cleaned passage whose place in the draft was lost as unable to land", async () => {
    const harness = setupGlobals({ correctionEnabled: true });
    const correction = deferred<{ action: string; correctedText: string; verdict: string }>();
    harness.voiceInput.correct.mockReturnValue(correction.promise);
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    harness.emit("complete", { sessionId, text: DICTATED, itemId: "item-1" });
    harness.paintFrames();
    await service.stop("Dictation stopped.", { reason: "user" });

    draftState.draft = "something else entirely";
    correction.resolve({
      action: "replace",
      correctedText: "Deploy the canopy branch to staging.",
      verdict: "replaced",
    });
    await flushPromises();
    harness.paintFrames();

    expect(summaries()).toMatchObject([{ correction: "discarded" }]);
    expect(summaries()[0]!.correctionPassages).toEqual({ ...NO_PASSAGES, sent: 1, unlanded: 1 });
  });

  it("counts passages a send dropped before their reply came back", async () => {
    const harness = setupGlobals({ correctionEnabled: true });
    const correction = deferred<{ action: string; correctedText: string; verdict: string }>();
    harness.voiceInput.correct.mockReturnValue(correction.promise);
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    harness.emit("complete", { sessionId, text: DICTATED, itemId: "item-1" });
    harness.paintFrames();
    await service.stop("Dictation stopped.", { reason: "user" });

    service.discardPendingCorrections(TARGET.panelId);
    correction.resolve({
      action: "replace",
      correctedText: "Deploy the canopy branch to staging.",
      verdict: "replaced",
    });
    await flushPromises();
    harness.paintFrames();

    expect(summaries()).toMatchObject([{ correction: "discarded" }]);
    expect(summaries()[0]!.correctionPassages).toEqual({ ...NO_PASSAGES, sent: 1, dropped: 1 });
  });

  // A stream that errors or runs out its deadline part-way comes back as
  // main's verdict, after some of its text was already drawn.
  it.each([
    ["failed", "failed"],
    ["timed_out", "timedOut"],
  ] as const)(
    "counts a streamed passage whose stream ended %s part-way under it",
    async (verdict, field) => {
      const harness = setupGlobals({ correctionEnabled: true });
      const correction = deferred<Record<string, unknown>>();
      let streamId = "";
      harness.voiceInput.correct.mockImplementation((request: { streamId: string }) => {
        streamId = request.streamId;
        return correction.promise;
      });
      const { service, summaries } = await load();
      const sessionId = await startLive(harness, service);
      harness.emit("complete", { sessionId, text: DICTATED, itemId: "item-1" });
      harness.paintFrames();
      await service.stop("Dictation stopped.", { reason: "user" });

      harness.emit("correctionProgress", { streamId, text: "Deploy the canopy" });
      correction.resolve({
        action: "no_change",
        correctedText: DICTATED,
        failed: true,
        verdict,
      });
      await flushPromises();
      harness.paintFrames();

      expect(draftState.draft).toBe(DICTATED);
      expect(summaries()).toMatchObject([{ correction: "failed" }]);
      expect(summaries()[0]!.correctionPassages).toEqual({ ...NO_PASSAGES, sent: 1, [field]: 1 });
    }
  );

  it("counts a streamed passage a send dropped part-way as dropped, late progress and all", async () => {
    const harness = setupGlobals({ correctionEnabled: true });
    const correction = deferred<{ action: string; correctedText: string; verdict: string }>();
    let streamId = "";
    harness.voiceInput.correct.mockImplementation((request: { streamId: string }) => {
      streamId = request.streamId;
      return correction.promise;
    });
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    harness.emit("complete", { sessionId, text: DICTATED, itemId: "item-1" });
    harness.paintFrames();
    await service.stop("Dictation stopped.", { reason: "user" });

    harness.emit("correctionProgress", { streamId, text: "Deploy the" });
    service.discardPendingCorrections(TARGET.panelId);
    harness.emit("correctionProgress", { streamId, text: "Deploy the canopy branch" });
    correction.resolve({
      action: "replace",
      correctedText: "Deploy the canopy branch to staging.",
      verdict: "replaced",
    });
    await flushPromises();
    harness.paintFrames();

    expect(summaries()).toMatchObject([{ correction: "discarded" }]);
    expect(summaries()[0]!.correctionPassages).toEqual({ ...NO_PASSAGES, sent: 1, dropped: 1 });
  });

  it("reports no passages for a session that ran no cleanup", async () => {
    const harness = setupGlobals();
    const { service, summaries } = await load();
    await startLive(harness, service);
    await service.stop("Dictation stopped.", { reason: "user" });
    await flushPromises();

    expect(summaries()[0]!.correctionPassages).toEqual(NO_PASSAGES);
  });

  it("counts the chunks cleaned while it ran apart from the stop-time pass (#14772)", async () => {
    const harness = setupGlobals({ correctionEnabled: true });
    harness.voiceInput.correct.mockImplementation(async ({ rawText }: { rawText: string }) => ({
      action: "no_change",
      correctedText: rawText,
    }));
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    let clock = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const sentence =
      "The integration tests keep timing out whenever the staging database is busy with the import.";
    for (let i = 0; i < 7; i++) {
      harness.emit("complete", { sessionId, text: sentence, itemId: `item-${i}` });
    }
    clock += 2_000;
    harness.emit("delta", { sessionId, text: "The login", itemId: "item-next" });
    harness.emit("complete", {
      sessionId,
      text: "The login page is next.",
      itemId: "item-next",
    });
    expect(harness.voiceInput.correct).toHaveBeenCalledTimes(1);
    harness.paintFrames();

    await service.stop("Dictation stopped.", { reason: "user" });
    await flushPromises();
    harness.paintFrames();

    expect(harness.voiceInput.correct).toHaveBeenCalledTimes(2);
    expect(harness.voiceInput.correct).toHaveBeenLastCalledWith(
      expect.objectContaining({ rawText: "The login page is next." })
    );
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toMatchObject({ correctionChunks: 1, correction: "unchanged" });
  });

  it("waits for a chunk whose cleanup failed after the stop, and counts it and its retry apart from the stop-time pass (#14932)", async () => {
    const harness = setupGlobals({ correctionEnabled: true });
    let answerChunk!: (result: unknown) => void;
    let answerRetry!: (result: unknown) => void;
    harness.voiceInput.correct
      .mockReturnValueOnce(new Promise((resolve) => (answerChunk = resolve)))
      .mockImplementationOnce(async ({ rawText }: { rawText: string }) => ({
        action: "no_change",
        correctedText: rawText,
        verdict: "unchanged",
      }))
      .mockReturnValueOnce(new Promise((resolve) => (answerRetry = resolve)));
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    let clock = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const sentence =
      "The integration tests keep timing out whenever the staging database is busy with the import.";
    for (let i = 0; i < 7; i++) {
      harness.emit("complete", { sessionId, text: sentence, itemId: `item-${i}` });
    }
    clock += 2_000;
    harness.emit("delta", { sessionId, text: "The login", itemId: "item-next" });
    harness.emit("complete", {
      sessionId,
      text: "The login page is next.",
      itemId: "item-next",
    });
    expect(harness.voiceInput.correct).toHaveBeenCalledTimes(1);
    harness.paintFrames();

    await service.stop("Dictation stopped.", { reason: "user" });
    await flushPromises();
    harness.paintFrames();
    expect(harness.voiceInput.correct).toHaveBeenCalledTimes(2);
    expect(summaries()).toHaveLength(0);

    const chunkText = Array.from({ length: 7 }, () => sentence).join(" ");
    answerChunk({ action: "no_change", correctedText: chunkText, verdict: "failed" });
    await flushPromises();
    expect(harness.voiceInput.correct).toHaveBeenCalledTimes(3);
    expect(harness.voiceInput.correct).toHaveBeenLastCalledWith(
      expect.objectContaining({ rawText: chunkText })
    );
    expect(summaries()).toHaveLength(0);

    answerRetry({
      action: "replace",
      correctedText: chunkText.replaceAll("keep timing out", "time out"),
      verdict: "replaced",
    });
    await flushPromises();
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toMatchObject({
      correctionChunks: 1,
      correction: "unchanged",
      correctionPassages: { ...NO_PASSAGES, sent: 1, unchanged: 1 },
      correctionChunkPassages: { ...NO_PASSAGES, sent: 2, failed: 1, applied: 1 },
    });
  });

  it("logs at once when a chunk still on its way is dropped, and never counts its late reply (#14932)", async () => {
    const harness = setupGlobals({ correctionEnabled: true });
    let answerChunk!: (result: unknown) => void;
    harness.voiceInput.correct
      .mockReturnValueOnce(new Promise((resolve) => (answerChunk = resolve)))
      .mockImplementation(async ({ rawText }: { rawText: string }) => ({
        action: "no_change",
        correctedText: rawText,
        verdict: "unchanged",
      }));
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    let clock = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const sentence =
      "The integration tests keep timing out whenever the staging database is busy with the import.";
    for (let i = 0; i < 7; i++) {
      harness.emit("complete", { sessionId, text: sentence, itemId: `item-${i}` });
    }
    clock += 2_000;
    harness.emit("delta", { sessionId, text: "The login", itemId: "item-next" });
    harness.emit("complete", { sessionId, text: "The login page is next.", itemId: "item-next" });
    harness.paintFrames();
    await service.stop("Dictation stopped.", { reason: "user" });
    await flushPromises();
    harness.paintFrames();
    expect(summaries()).toHaveLength(0);

    service.discardPendingCorrections(TARGET.panelId);
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]!.correctionChunkPassages).toEqual({
      ...NO_PASSAGES,
      sent: 1,
      dropped: 1,
    });

    answerChunk({ action: "no_change", correctedText: "", verdict: "failed" });
    await flushPromises();
    expect(summaries()).toHaveLength(1);
    expect(harness.voiceInput.correct).toHaveBeenCalledTimes(2);
  });

  it("records a correction request that failed as failed", async () => {
    const harness = setupGlobals({ correctionEnabled: true });
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    harness.voiceInput.correct.mockResolvedValue({
      action: "no_change",
      correctedText: DICTATED,
      failed: true,
    });
    harness.emit("complete", { sessionId, text: DICTATED, itemId: "item-1" });
    harness.paintFrames();
    await service.stop("Dictation stopped.", { reason: "user" });
    await flushPromises();

    // A reply that didn't say leaves main's parts unknown, not zero.
    expect(summaries()).toMatchObject([
      { correction: "failed", correctionPrepMs: null, correctionRequestMs: null },
    ]);
  });
});
