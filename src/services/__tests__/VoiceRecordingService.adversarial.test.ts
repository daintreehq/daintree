import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingCorrection, VoiceRecordingTarget } from "@/store/voiceRecordingStore";

type VoiceStatusCallback = (status: string) => void;
type VoiceErrorCallback = (error: string) => void;
type CorrectionReplaceCallback = (payload: { correctionId: string; correctedText: string }) => void;
type VoidCleanup = () => void;

interface MockTrack {
  stop: ReturnType<typeof vi.fn>;
}

interface MockStream {
  track: MockTrack;
  getTracks: () => MockTrack[];
  getAudioTracks: () => MockTrack[];
}

interface MockPanelBuffer {
  liveText: string;
  completedSegments: string[];
  projectId?: string;
  sessionDraftStart: number;
  draftLengthAtSegmentStart: number;
  pendingCorrections: PendingCorrection[];
  aiCorrectionSpans: Array<{ id: string; segmentStart: number; text: string }>;
  activeParagraphStart: number;
  transcriptPhase: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createPanelBuffer(overrides: Partial<MockPanelBuffer> = {}): MockPanelBuffer {
  return {
    liveText: "",
    completedSegments: [],
    sessionDraftStart: -1,
    draftLengthAtSegmentStart: -1,
    pendingCorrections: [],
    aiCorrectionSpans: [],
    activeParagraphStart: -1,
    transcriptPhase: "idle",
    ...overrides,
  };
}

function createStream(): MockStream {
  const track = { stop: vi.fn() };
  return {
    track,
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };
}

const runtime = vi.hoisted(() => ({
  drafts: {} as Record<string, string>,
  panelState: {
    panelsById: {} as Record<
      string,
      { id: string; title: string; location: string; worktreeId?: string }
    >,
    panelIds: [] as string[],
    focusedId: null as string | null,
    activateTerminal: vi.fn(),
  },
  projectState: {
    currentProject: { id: "project-1", name: "Project One" },
    isSwitching: false,
    switchProject: vi.fn(async () => undefined),
  },
  worktreeSelectionState: {
    activeWorktreeId: null as string | null,
    selectWorktree: vi.fn(),
  },
  voiceState: {
    activeTarget: null as VoiceRecordingTarget | null,
    status: "idle",
    panelBuffers: {} as Record<string, MockPanelBuffer>,
    correctionEnabled: false,
    isConfigured: false,
  },
  voiceFns: {
    setError: vi.fn<(message: string | null) => void>(),
    announce: vi.fn<(text: string) => void>(),
    setStatus: vi.fn<(status: string) => void>(),
    setConfigured: vi.fn<(configured: boolean) => void>(),
    setCorrectionEnabled: vi.fn<(enabled: boolean) => void>(),
    beginSession: vi.fn<(target: VoiceRecordingTarget) => void>(),
    finishSession:
      vi.fn<(options?: { nextStatus?: "idle" | "error"; preserveLiveText?: boolean }) => void>(),
    setAudioLevel: vi.fn<(level: number) => void>(),
    setElapsedSeconds: vi.fn<(seconds: number) => void>(),
    appendDelta: vi.fn<(delta: string) => void>(),
    completeSegment: vi.fn<(text: string) => void>(),
    resolvePendingCorrection: vi.fn<(panelId: string, correctionId: string) => void>(),
    addPendingCorrection:
      vi.fn<
        (panelId: string, correctionId: string, segmentStart: number, rawText: string) => void
      >(),
    updateAICorrectionSpan: vi.fn(),
    rebasePendingCorrections: vi.fn(),
    rebaseAICorrectionSpans: vi.fn(),
    clearAICorrectionSpans: vi.fn(),
    setDraftLengthAtSegmentStart: vi.fn<(panelId: string, length: number) => void>(),
    setSessionDraftStart: vi.fn<(panelId: string, length: number) => void>(),
    setActiveParagraphStart: vi.fn<(panelId: string, length: number) => void>(),
    resetParagraphState: vi.fn<(panelId: string) => void>(),
    clearPanelBuffer: vi.fn<(panelId: string) => void>(),
  },
  terminalInputFns: {
    getDraftInput: vi.fn<(panelId: string, projectId?: string) => string>(),
    setDraftInput: vi.fn<(panelId: string, value: string, projectId?: string) => void>(),
    appendVoiceText: vi.fn<(panelId: string, value: string, projectId?: string) => void>(),
    bumpVoiceDraftRevision: vi.fn<() => void>(),
  },
  correctionReplaceListeners: new Set<CorrectionReplaceCallback>(),
  statusListeners: new Set<VoiceStatusCallback>(),
  errorListeners: new Set<VoiceErrorCallback>(),
  rafCallbacks: new Map<number, FrameRequestCallback>(),
  nextRafId: 1,
  micPermissionQueue: [] as Array<string | Promise<string>>,
  requestMicPermissionQueue: [] as Array<boolean | Promise<boolean>>,
  getUserMediaQueue: [] as Array<MockStream | Promise<MockStream>>,
  addModuleQueue: [] as Array<Promise<void>>,
  startQueue: [] as Array<
    Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string }
  >,
  stopQueue: [] as Array<Promise<void> | void>,
  createdStreams: [] as MockStream[],
  createdAudioContexts: [] as Array<{
    close: ReturnType<typeof vi.fn>;
    audioWorklet: { addModule: ReturnType<typeof vi.fn> };
  }>,
  createdWorkletNodes: [] as Array<{
    port: { onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null };
    disconnect: ReturnType<typeof vi.fn>;
  }>,
  voiceInput: {
    getSettings: vi.fn<
      () => Promise<{
        enabled: boolean;
        deepgramApiKey: string;
        correctionApiKey: string;
        correctionEnabled: boolean;
      }>
    >(),
    checkMicPermission: vi.fn<() => Promise<string>>(),
    requestMicPermission: vi.fn<() => Promise<boolean>>(),
    openMicSettings: vi.fn(),
    sendAudioChunk: vi.fn<(chunk: ArrayBuffer) => void>(),
    start: vi.fn<() => Promise<{ ok: boolean; error?: string }>>(),
    stop: vi.fn<() => Promise<void>>(),
  },
}));

function resetRuntime(): void {
  runtime.drafts = {};
  runtime.panelState.panelsById = {
    "panel-1": { id: "panel-1", title: "Panel One", location: "grid" },
    "panel-2": { id: "panel-2", title: "Panel Two", location: "grid" },
  };
  runtime.panelState.panelIds = ["panel-1", "panel-2"];
  runtime.panelState.focusedId = "panel-1";
  runtime.panelState.activateTerminal.mockReset();
  runtime.projectState.currentProject = { id: "project-1", name: "Project One" };
  runtime.projectState.isSwitching = false;
  runtime.projectState.switchProject.mockReset();
  runtime.worktreeSelectionState.activeWorktreeId = null;
  runtime.worktreeSelectionState.selectWorktree.mockReset();
  runtime.voiceState.activeTarget = null;
  runtime.voiceState.status = "idle";
  runtime.voiceState.panelBuffers = {};
  runtime.voiceState.correctionEnabled = false;
  runtime.voiceState.isConfigured = false;
  Object.values(runtime.voiceFns).forEach((fn) => fn.mockReset());
  Object.values(runtime.terminalInputFns).forEach((fn) => fn.mockReset());
  runtime.correctionReplaceListeners.clear();
  runtime.statusListeners.clear();
  runtime.errorListeners.clear();
  runtime.rafCallbacks.clear();
  runtime.nextRafId = 1;
  runtime.micPermissionQueue = [];
  runtime.requestMicPermissionQueue = [];
  runtime.getUserMediaQueue = [];
  runtime.addModuleQueue = [];
  runtime.startQueue = [];
  runtime.stopQueue = [];
  runtime.createdStreams = [];
  runtime.createdAudioContexts = [];
  runtime.createdWorkletNodes = [];
  Object.values(runtime.voiceInput).forEach((fn) => fn.mockReset());

  runtime.voiceFns.setError.mockImplementation(() => undefined);
  runtime.voiceFns.announce.mockImplementation(() => undefined);
  runtime.voiceFns.setStatus.mockImplementation((status) => {
    runtime.voiceState.status = status;
  });
  runtime.voiceFns.setConfigured.mockImplementation((configured) => {
    runtime.voiceState.isConfigured = configured;
  });
  runtime.voiceFns.setCorrectionEnabled.mockImplementation((enabled) => {
    runtime.voiceState.correctionEnabled = enabled;
  });
  runtime.voiceFns.beginSession.mockImplementation((target) => {
    runtime.voiceState.activeTarget = target;
    runtime.voiceState.status = "connecting";
    runtime.voiceState.panelBuffers[target.panelId] = createPanelBuffer({
      projectId: target.projectId,
    });
  });
  runtime.voiceFns.finishSession.mockImplementation((options) => {
    runtime.voiceState.activeTarget = null;
    runtime.voiceState.status = options?.nextStatus ?? "idle";
  });
  runtime.voiceFns.setAudioLevel.mockImplementation(() => undefined);
  runtime.voiceFns.setElapsedSeconds.mockImplementation(() => undefined);
  runtime.voiceFns.appendDelta.mockImplementation(() => undefined);
  runtime.voiceFns.completeSegment.mockImplementation(() => undefined);
  runtime.voiceFns.resolvePendingCorrection.mockImplementation(() => undefined);
  runtime.voiceFns.addPendingCorrection.mockImplementation(() => undefined);
  runtime.voiceFns.updateAICorrectionSpan.mockImplementation(() => undefined);
  runtime.voiceFns.rebasePendingCorrections.mockImplementation(() => undefined);
  runtime.voiceFns.rebaseAICorrectionSpans.mockImplementation(() => undefined);
  runtime.voiceFns.clearAICorrectionSpans.mockImplementation(() => undefined);
  runtime.voiceFns.setDraftLengthAtSegmentStart.mockImplementation((panelId, length) => {
    runtime.voiceState.panelBuffers[panelId] = createPanelBuffer(
      runtime.voiceState.panelBuffers[panelId]
    );
    runtime.voiceState.panelBuffers[panelId].draftLengthAtSegmentStart = length;
  });
  runtime.voiceFns.setSessionDraftStart.mockImplementation((panelId, length) => {
    runtime.voiceState.panelBuffers[panelId] = createPanelBuffer(
      runtime.voiceState.panelBuffers[panelId]
    );
    runtime.voiceState.panelBuffers[panelId].sessionDraftStart = length;
  });
  runtime.voiceFns.setActiveParagraphStart.mockImplementation((panelId, length) => {
    runtime.voiceState.panelBuffers[panelId] = createPanelBuffer(
      runtime.voiceState.panelBuffers[panelId]
    );
    runtime.voiceState.panelBuffers[panelId].activeParagraphStart = length;
  });
  runtime.voiceFns.resetParagraphState.mockImplementation((panelId) => {
    runtime.voiceState.panelBuffers[panelId] = createPanelBuffer(
      runtime.voiceState.panelBuffers[panelId]
    );
    runtime.voiceState.panelBuffers[panelId].activeParagraphStart = -1;
  });
  runtime.voiceFns.clearPanelBuffer.mockImplementation((panelId) => {
    delete runtime.voiceState.panelBuffers[panelId];
  });

  runtime.terminalInputFns.getDraftInput.mockImplementation(
    (panelId) => runtime.drafts[panelId] ?? ""
  );
  runtime.terminalInputFns.setDraftInput.mockImplementation((panelId, value) => {
    runtime.drafts[panelId] = value;
  });
  runtime.terminalInputFns.appendVoiceText.mockImplementation((panelId, value) => {
    runtime.drafts[panelId] = `${runtime.drafts[panelId] ?? ""}${value}`;
  });
  runtime.terminalInputFns.bumpVoiceDraftRevision.mockImplementation(() => undefined);

  runtime.voiceInput.getSettings.mockResolvedValue({
    enabled: true,
    deepgramApiKey: "dg-key",
    correctionApiKey: "corr-key",
    correctionEnabled: true,
  });
  runtime.voiceInput.checkMicPermission.mockImplementation(async () => {
    const next = runtime.micPermissionQueue.shift();
    return next instanceof Promise ? next : (next ?? "granted");
  });
  runtime.voiceInput.requestMicPermission.mockImplementation(async () => {
    const next = runtime.requestMicPermissionQueue.shift();
    return next instanceof Promise ? next : (next ?? true);
  });
  runtime.voiceInput.start.mockImplementation(async () => {
    const next = runtime.startQueue.shift();
    if (next instanceof Promise) {
      return next;
    }
    return next ?? { ok: true };
  });
  runtime.voiceInput.stop.mockImplementation(async () => {
    const next = runtime.stopQueue.shift();
    if (next instanceof Promise) {
      await next;
      return;
    }
  });
}

function addListener<T>(listeners: Set<T>, callback: T): VoidCleanup {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

vi.mock("@/store/voiceRecordingStore", () => {
  const getState = () => ({ ...runtime.voiceState, ...runtime.voiceFns });
  const subscribe = vi.fn(() => () => {});
  return {
    useVoiceRecordingStore: Object.assign(getState, { getState, subscribe }),
  };
});

vi.mock("@/store/terminalInputStore", () => {
  const getState = () => runtime.terminalInputFns;
  return {
    useTerminalInputStore: Object.assign(getState, { getState }),
  };
});

vi.mock("@/store/panelStore", () => {
  const getState = () => runtime.panelState;
  const subscribe = vi.fn(() => () => {});
  return {
    usePanelStore: Object.assign(getState, { getState, subscribe }),
  };
});

vi.mock("@/store/projectStore", () => {
  const getState = () => runtime.projectState;
  return {
    useProjectStore: Object.assign(getState, { getState }),
  };
});

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({
    getState: () => ({ worktrees: new Map() }),
  }),
}));

vi.mock("@/store/worktreeStore", () => {
  const getState = () => runtime.worktreeSelectionState;
  return {
    useWorktreeSelectionStore: Object.assign(getState, { getState }),
  };
});

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/voiceInputSettingsEvents", () => ({
  VOICE_INPUT_SETTINGS_CHANGED_EVENT: "voice-input-settings-changed",
}));

function setupGlobals(): void {
  vi.stubGlobal("window", {
    electron: {
      voiceInput: {
        onTranscriptionDelta: vi.fn(() => () => {}),
        onTranscriptionComplete: vi.fn(() => () => {}),
        onCorrectionQueued: vi.fn(() => () => {}),
        onCorrectionReplace: vi.fn((callback: CorrectionReplaceCallback) =>
          addListener(runtime.correctionReplaceListeners, callback)
        ),
        onParagraphBoundary: vi.fn(() => () => {}),
        onFileTokenResolved: vi.fn(() => () => {}),
        onError: vi.fn((callback: VoiceErrorCallback) =>
          addListener(runtime.errorListeners, callback)
        ),
        onStatus: vi.fn((callback: VoiceStatusCallback) =>
          addListener(runtime.statusListeners, callback)
        ),
        getSettings: runtime.voiceInput.getSettings,
        checkMicPermission: runtime.voiceInput.checkMicPermission,
        requestMicPermission: runtime.voiceInput.requestMicPermission,
        openMicSettings: runtime.voiceInput.openMicSettings,
        sendAudioChunk: runtime.voiceInput.sendAudioChunk,
        start: runtime.voiceInput.start,
        stop: runtime.voiceInput.stop,
      },
      systemSleep: {
        onSuspend: vi.fn(() => () => {}),
        onWake: vi.fn(() => () => {}),
      },
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      const id = runtime.nextRafId++;
      runtime.rafCallbacks.set(id, callback);
      return id;
    }),
    cancelAnimationFrame: vi.fn((id: number) => {
      runtime.rafCallbacks.delete(id);
    }),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = runtime.nextRafId++;
    runtime.rafCallbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    runtime.rafCallbacks.delete(id);
  });

  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });

  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => {
        const next = runtime.getUserMediaQueue.shift();
        const stream = next instanceof Promise ? await next : (next ?? createStream());
        runtime.createdStreams.push(stream);
        return stream;
      }),
    },
  });

  vi.stubGlobal("AudioContext", function () {
    const addModule = vi.fn(async () => {
      const next = runtime.addModuleQueue.shift();
      if (next) {
        await next;
      }
    });
    const context = {
      state: "running",
      destination: {},
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
      createOscillator: vi.fn(() => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      })),
      createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
      audioWorklet: { addModule },
    };
    runtime.createdAudioContexts.push(context);
    return context;
  });

  vi.stubGlobal("AudioWorkletNode", function () {
    const node = {
      port: { onmessage: null as ((event: MessageEvent<ArrayBuffer>) => void) | null },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    runtime.createdWorkletNodes.push(node);
    return node;
  });
}

function flushRaf(): void {
  const callbacks = Array.from(runtime.rafCallbacks.values());
  runtime.rafCallbacks.clear();
  for (const callback of callbacks) {
    callback(0);
  }
}

function emitStatus(status: string): void {
  for (const listener of runtime.statusListeners) {
    listener(status);
  }
}

function emitError(error: string): void {
  for (const listener of runtime.errorListeners) {
    listener(error);
  }
}

function emitCorrectionReplace(payload: { correctionId: string; correctedText: string }): void {
  for (const listener of runtime.correctionReplaceListeners) {
    listener(payload);
  }
}

describe("VoiceRecordingService adversarial", () => {
  beforeEach(() => {
    vi.resetModules();
    resetRuntime();
    setupGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("CONCURRENT_STARTS_KEEP_LATEST_ONLY", async () => {
    const firstAddModule = deferred<void>();
    const firstStream = createStream();
    const secondStream = createStream();
    runtime.addModuleQueue.push(firstAddModule.promise);
    runtime.getUserMediaQueue.push(firstStream, secondStream);

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const firstTarget: VoiceRecordingTarget = { panelId: "panel-1", panelTitle: "Panel One" };
    const secondTarget: VoiceRecordingTarget = { panelId: "panel-2", panelTitle: "Panel Two" };

    const firstStart = voiceRecordingService.start(firstTarget);
    await vi.waitFor(() => {
      expect(runtime.voiceFns.beginSession).toHaveBeenCalledTimes(1);
    });

    const secondStart = voiceRecordingService.start(secondTarget);
    await vi.waitFor(() => {
      expect(runtime.voiceFns.beginSession).toHaveBeenCalledTimes(2);
    });

    firstAddModule.resolve();
    await Promise.all([firstStart, secondStart]);

    expect(runtime.voiceState.activeTarget?.panelId).toBe("panel-2");
    expect(runtime.voiceFns.finishSession).toHaveBeenCalledTimes(1);
    expect(firstStream.track.stop).toHaveBeenCalled();
    expect(secondStream.track.stop).not.toHaveBeenCalled();
    expect(runtime.voiceInput.start).toHaveBeenCalledTimes(1);
  });

  it("DOUBLE_STOP_SINGLE_REMOTE_STOP", async () => {
    const stopDeferred = deferred<void>();
    runtime.stopQueue.push(stopDeferred.promise);
    runtime.voiceState.activeTarget = { panelId: "panel-1", panelTitle: "Panel One" };
    runtime.voiceState.status = "recording";
    runtime.voiceState.panelBuffers["panel-1"] = createPanelBuffer();

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    voiceRecordingService.initialize();

    const firstStop = voiceRecordingService.stop("Dictation stopped.");
    const secondStop = voiceRecordingService.stop("Dictation stopped.");
    stopDeferred.resolve();
    await Promise.all([firstStop, secondStop]);

    expect(runtime.voiceInput.stop).toHaveBeenCalledTimes(1);
    expect(runtime.voiceFns.finishSession).toHaveBeenCalledTimes(1);
    expect(runtime.voiceFns.announce).toHaveBeenCalledTimes(1);
  });

  it("STOP_BEFORE_MIC_RESOLVES_NO_LATE_START", async () => {
    const micPermission = deferred<string>();
    runtime.micPermissionQueue.push(micPermission.promise);

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const startPromise = voiceRecordingService.start({
      panelId: "panel-1",
      panelTitle: "Panel One",
    });
    const stopPromise = voiceRecordingService.stop("Cancelled.");
    voiceRecordingService.destroy();

    micPermission.resolve("granted");
    await Promise.all([startPromise, stopPromise]);

    expect(runtime.voiceFns.beginSession).not.toHaveBeenCalled();
    expect(runtime.voiceInput.start).not.toHaveBeenCalled();
    expect(runtime.createdWorkletNodes).toHaveLength(0);
  });

  it("HUGE_AUDIO_BUFFER_BATCHES_LEVEL_PER_FRAME", async () => {
    const { voiceRecordingService } = await import("../VoiceRecordingService");

    await voiceRecordingService.start({
      panelId: "panel-1",
      panelTitle: "Panel One",
    });

    const handler = runtime.createdWorkletNodes[0]?.port.onmessage;
    expect(handler).toBeTypeOf("function");

    const bufferOne = new Int16Array(32_768);
    bufferOne.fill(16_000);
    const bufferTwo = new Int16Array(32_768);
    bufferTwo.fill(8_000);

    handler?.({ data: bufferOne.buffer } as MessageEvent<ArrayBuffer>);
    handler?.({ data: bufferTwo.buffer } as MessageEvent<ArrayBuffer>);

    expect(runtime.voiceFns.setAudioLevel).not.toHaveBeenCalled();
    flushRaf();

    expect(runtime.voiceFns.setAudioLevel).toHaveBeenCalledTimes(1);
    const level = runtime.voiceFns.setAudioLevel.mock.calls[0]?.[0];
    expect(typeof level).toBe("number");
    expect(Number.isFinite(level)).toBe(true);
    expect(level).toBeLessThanOrEqual(1);
    expect(runtime.voiceInput.sendAudioChunk).toHaveBeenCalledTimes(2);
  });

  it("DESTROY_THEN_LATE_CORRECTION_IGNORED", async () => {
    runtime.voiceState.activeTarget = {
      panelId: "panel-1",
      panelTitle: "Panel One",
      projectId: "project-1",
    };
    runtime.voiceState.panelBuffers["panel-1"] = createPanelBuffer({
      projectId: "project-1",
      pendingCorrections: [{ id: "corr-1", segmentStart: 0, rawText: "hello" }],
      activeParagraphStart: 0,
    });
    runtime.drafts["panel-1"] = "hello";

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    voiceRecordingService.initialize();
    voiceRecordingService.destroy();

    emitCorrectionReplace({ correctionId: "corr-1", correctedText: "HELLO" });

    expect(runtime.terminalInputFns.setDraftInput).not.toHaveBeenCalled();
    expect(runtime.voiceFns.resolvePendingCorrection).not.toHaveBeenCalled();
  });

  it("STOP_DURING_CONNECTING_IGNORES_RACE", async () => {
    const stopDeferred = deferred<void>();
    runtime.stopQueue.push(stopDeferred.promise);
    runtime.voiceState.activeTarget = { panelId: "panel-1", panelTitle: "Panel One" };
    runtime.voiceState.status = "connecting";
    runtime.voiceState.panelBuffers["panel-1"] = createPanelBuffer({
      liveText: "partial",
    });

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    voiceRecordingService.initialize();

    const stopPromise = voiceRecordingService.stop("Dictation stopped.");
    await vi.waitFor(() => {
      expect(runtime.voiceFns.setStatus).toHaveBeenCalledWith("finishing");
    });
    emitStatus("idle");
    emitError("network lost");
    stopDeferred.resolve();
    await stopPromise;

    expect(runtime.voiceInput.stop).toHaveBeenCalledTimes(1);
    expect(runtime.voiceFns.finishSession).toHaveBeenCalledTimes(1);
    expect(runtime.voiceFns.announce).toHaveBeenCalledTimes(1);
    expect(runtime.voiceFns.setError).not.toHaveBeenCalled();
  });
});
