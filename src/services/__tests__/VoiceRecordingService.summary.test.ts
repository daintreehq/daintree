import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_SESSION_SUMMARY_MESSAGE } from "@shared/utils/voiceLogFields";
import { VoiceSessionSummarySchema } from "@shared/types/voiceSessionSummary";
import { VOICE_REPORT_WAIT_MS } from "../voiceSessionTimeline";

// Drives real sessions through the service and reads the one summary line
// each leaves (#14617).

const draftState = vi.hoisted(() => ({ draft: "" }));

vi.mock("@/store/terminalInputStore", () => {
  const fns = {
    getDraftInput: vi.fn(() => draftState.draft),
    setDraftInput: vi.fn((_panelId: string, value: string) => {
      draftState.draft = value;
    }),
    bumpExternalDraftRevision: vi.fn(),
  };
  const getState = () => fns;
  return {
    useTerminalInputStore: Object.assign(getState, { getState, subscribe: vi.fn(() => () => {}) }),
  };
});

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
    recordingMode?: "toggle" | "push-to-talk";
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
    onFileTokenResolved: on("fileToken"),
    onError: on("error"),
    onStatus: on("status"),
    onSessionEnded: on("ended"),
    onLiveSession: vi.fn(() => () => {}),
    onStopRequested: vi.fn(() => () => {}),
    onRevealRequested: vi.fn(() => () => {}),
    getLiveSession: vi.fn().mockResolvedValue({ revision: 0, session: null }),
    getSettings: vi.fn(async () => ({
      enabled: true,
      openaiApiKey: "sk-key",
      transcriptionProvider: "openai",
      correctionEnabled: options.correctionEnabled ?? false,
      recordingMode: options.recordingMode ?? "toggle",
      deviceId: "",
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
  target = TARGET
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
    for (const field of ["cueMs", "micLiveMs", "socketReadyMs", "firstTextMs", "stopSettledMs"]) {
      expect([field, typeof line![field]]).toEqual([field, "number"]);
    }
    expect(Object.keys(line!).sort()).toEqual(["sessionId", ...SUMMARY_FIELDS].sort());
    const serialized = JSON.stringify(line);
    for (const secret of [PANEL_TITLE, "Acme", "canopy", "staging", KEYTERM]) {
      expect(serialized).not.toContain(secret);
    }
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

  it("falls back to start() entry without a shortcut press", async () => {
    const harness = setupGlobals();
    const { service, summaries } = await load();
    await startLive(harness, service);
    await service.stop("Dictation stopped.", { reason: "user" });

    expect(summaries()).toMatchObject([{ origin: "call" }]);
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

  it("waits for the correction and records how it went", async () => {
    const harness = setupGlobals({ correctionEnabled: true });
    const correction = deferred<{ action: string; correctedText: string }>();
    harness.voiceInput.correct.mockReturnValue(correction.promise);
    const { service, summaries } = await load();
    const sessionId = await startLive(harness, service);
    harness.emit("complete", { sessionId, text: DICTATED, itemId: "item-1" });
    harness.paintFrames();
    await service.stop("Dictation stopped.", { reason: "user" });

    // Only the correction is left to wait on.
    expect(harness.voiceInput.correct).toHaveBeenCalledTimes(1);
    expect(summaries()).toHaveLength(0);
    correction.resolve({
      action: "replace",
      correctedText: "Deploy the canopy branch to staging.",
    });
    await flushPromises();
    harness.paintFrames();

    expect(draftState.draft).toBe("Deploy the canopy branch to staging.");
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toMatchObject({ correction: "applied" });
    expect(typeof summaries()[0]!.correctionMs).toBe("number");
    expect(JSON.stringify(summaries()[0])).not.toContain("canopy");
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

    expect(summaries()).toMatchObject([{ correction: "failed" }]);
  });
});
