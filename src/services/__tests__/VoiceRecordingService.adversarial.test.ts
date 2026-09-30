import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceRecordingTarget } from "@/store/voiceRecordingStore";
import type { VoiceInputError } from "@shared/types";

type VoiceStatusCallback = (status: string) => void;
type VoiceErrorCallback = (error: VoiceInputError) => void;
type VoidCleanup = () => void;

interface MockTrack {
  stop: ReturnType<typeof vi.fn>;
  muted?: boolean;
  readyState?: string;
  addEventListener?: (type: string, listener: () => void) => void;
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
  insertPoint: number;
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
    insertPoint: -1,
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
    micSignal: "pending" as string,
  },
  voiceFns: {
    setLastError: vi.fn<(error: VoiceInputError | null) => void>(),
    announce: vi.fn<(text: string) => void>(),
    setStatus: vi.fn<(status: string) => void>(),
    setConfigured: vi.fn<(configured: boolean) => void>(),
    setCorrectionEnabled: vi.fn<(enabled: boolean) => void>(),
    setLearnFromCorrections: vi.fn<(enabled: boolean) => void>(),
    setSessionCorrectedText: vi.fn<(panelId: string, text: string | null) => void>(),
    beginSession: vi.fn<(target: VoiceRecordingTarget) => void>(),
    finishSession:
      vi.fn<(options?: { nextStatus?: "idle" | "error"; preserveLiveText?: boolean }) => void>(),
    setAudioLevel: vi.fn<(level: number) => void>(),
    setMicSignal: vi.fn<(signal: string) => void>(),
    setElapsedSeconds: vi.fn<(seconds: number) => void>(),
    appendDelta: vi.fn<(delta: string) => void>(),
    completeSegment: vi.fn<(text: string) => void>(),
    setInsertPoint: vi.fn<(panelId: string, length: number) => void>(),
    setSessionDraftStart: vi.fn<(panelId: string, length: number) => void>(),
    setActiveParagraphStart: vi.fn<(panelId: string, length: number) => void>(),
    resetParagraphState: vi.fn<(panelId: string) => void>(),
    clearPanelBuffer: vi.fn<(panelId: string) => void>(),
  },
  terminalInputFns: {
    getDraftInput: vi.fn<(panelId: string, projectId?: string) => string>(),
    setDraftInput: vi.fn<(panelId: string, value: string, projectId?: string) => void>(),
    bumpExternalDraftRevision: vi.fn<() => void>(),
  },
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
  audioContextInitialState: "running",
  audioContextListeners: new Map<string, () => void>(),
  createdAudioContexts: [] as Array<{
    state: string;
    close: ReturnType<typeof vi.fn>;
    audioWorklet: { addModule: ReturnType<typeof vi.fn> };
  }>,
  createdWorkletNodes: [] as Array<{
    port: {
      onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null;
      postMessage: ReturnType<typeof vi.fn>;
    };
    disconnect: ReturnType<typeof vi.fn>;
  }>,
  voiceInput: {
    getSettings: vi.fn<
      () => Promise<{
        enabled: boolean;
        openaiApiKey: string;
        correctionEnabled: boolean;
      }>
    >(),
    checkMicPermission: vi.fn<() => Promise<string>>(),
    requestMicPermission: vi.fn<() => Promise<boolean>>(),
    openMicSettings: vi.fn<() => Promise<void>>(),
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
  runtime.audioContextInitialState = "running";
  runtime.audioContextListeners.clear();
  runtime.createdAudioContexts = [];
  runtime.createdWorkletNodes = [];
  Object.values(runtime.voiceInput).forEach((fn) => fn.mockReset());

  runtime.voiceFns.setLastError.mockImplementation(() => undefined);
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
    runtime.voiceState.micSignal = "pending";
    runtime.voiceState.panelBuffers[target.panelId] = createPanelBuffer({
      projectId: target.projectId,
    });
  });
  runtime.voiceFns.finishSession.mockImplementation((options) => {
    runtime.voiceState.activeTarget = null;
    runtime.voiceState.status = options?.nextStatus ?? "idle";
  });
  runtime.voiceFns.setAudioLevel.mockImplementation(() => undefined);
  runtime.voiceFns.setMicSignal.mockImplementation((signal) => {
    runtime.voiceState.micSignal = signal;
  });
  runtime.voiceFns.setElapsedSeconds.mockImplementation(() => undefined);
  runtime.voiceFns.appendDelta.mockImplementation(() => undefined);
  runtime.voiceFns.completeSegment.mockImplementation(() => undefined);
  runtime.voiceFns.setInsertPoint.mockImplementation((panelId, length) => {
    runtime.voiceState.panelBuffers[panelId] = createPanelBuffer(
      runtime.voiceState.panelBuffers[panelId]
    );
    runtime.voiceState.panelBuffers[panelId].insertPoint = length;
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
  runtime.terminalInputFns.bumpExternalDraftRevision.mockImplementation(() => undefined);

  runtime.voiceInput.getSettings.mockResolvedValue({
    enabled: true,
    openaiApiKey: "sk-key",
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
  // The real IPC method resolves a promise; the caller hands it to
  // safeFireAndForget, which would throw on a bare undefined.
  runtime.voiceInput.openMicSettings.mockImplementation(async () => {});
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
    isVoiceMicPending: (state: { status: string; micSignal: string }) =>
      ["connecting", "recording", "reconnecting"].includes(state.status) &&
      state.micSignal !== "live",
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
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/voiceInputSettingsEvents", () => ({
  VOICE_INPUT_SETTINGS_CHANGED_EVENT: "voice-input-settings-changed",
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getEffectiveCombo: vi.fn(() => undefined),
    getEffectiveCombos: vi.fn(() => []),
    matchesEvent: vi.fn(() => false),
  },
}));

function setupGlobals(): void {
  vi.stubGlobal("window", {
    electron: {
      voiceInput: {
        onTranscriptionDelta: vi.fn(() => () => {}),
        onTranscriptionComplete: vi.fn(() => () => {}),
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
      state: runtime.audioContextInitialState,
      destination: {},
      resume: vi.fn(async () => {
        context.state = "running";
      }),
      addEventListener: vi.fn((type: string, listener: () => void) => {
        runtime.audioContextListeners.set(type, listener);
      }),
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
      port: {
        onmessage: null as ((event: MessageEvent<ArrayBuffer>) => void) | null,
        postMessage: vi.fn(),
      },
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

function emitError(error: VoiceInputError): void {
  for (const listener of runtime.errorListeners) {
    listener(error);
  }
}

// A real MessageEvent carrying one PCM16 chunk, as the worklet port delivers it.
function pcmEvent(samples: Int16Array<ArrayBuffer>): MessageEvent<ArrayBuffer> {
  return new MessageEvent("message", { data: samples.buffer });
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

    // The first start opens its microphone but stalls on the worklet module,
    // so it never reaches a session before the second start supersedes it.
    const firstStart = voiceRecordingService.start(firstTarget);
    await vi.waitFor(() => {
      expect(runtime.createdStreams).toHaveLength(1);
    });

    const secondStart = voiceRecordingService.start(secondTarget);
    await vi.waitFor(() => {
      expect(runtime.voiceFns.beginSession).toHaveBeenCalledTimes(1);
    });

    firstAddModule.resolve();
    await Promise.all([firstStart, secondStart]);

    expect(runtime.voiceState.activeTarget?.panelId).toBe("panel-2");
    expect(runtime.voiceFns.beginSession).toHaveBeenCalledTimes(1);
    expect(runtime.voiceFns.finishSession).not.toHaveBeenCalled();
    expect(firstStream.track.stop).toHaveBeenCalled();
    expect(runtime.createdAudioContexts[0]?.close).toHaveBeenCalled();
    expect(secondStream.track.stop).not.toHaveBeenCalled();
    expect(runtime.voiceInput.start).toHaveBeenCalledTimes(1);
  });

  describe("early capture (#13106)", () => {
    const panelOne: VoiceRecordingTarget = { panelId: "panel-1", panelTitle: "Panel One" };
    const panelTwo: VoiceRecordingTarget = { panelId: "panel-2", panelTitle: "Panel Two" };

    function emitChunk(nodeIndex: number, fill: number): ArrayBuffer {
      const samples = new Int16Array(2400);
      samples.fill(fill);
      runtime.createdWorkletNodes[nodeIndex]?.port.onmessage?.(
        new MessageEvent<ArrayBuffer>("message", { data: samples.buffer })
      );
      return samples.buffer;
    }

    it("loads the worklet while the microphone is still opening", async () => {
      const microphone = deferred<MockStream>();
      runtime.getUserMediaQueue.push(microphone.promise);

      const { voiceRecordingService } = await import("../VoiceRecordingService");
      const starting = voiceRecordingService.start(panelOne);

      await vi.waitFor(() => {
        expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled();
      });
      expect(runtime.createdAudioContexts[0]?.audioWorklet.addModule).toHaveBeenCalledWith(
        "/pcm-processor.js"
      );

      microphone.resolve(createStream());
      await starting;
      expect(runtime.voiceInput.start).toHaveBeenCalledTimes(1);
    });

    it("queues audio until the backend starts, then flushes it in order before live audio", async () => {
      const backendStart = deferred<{ ok: boolean }>();
      runtime.startQueue.push(backendStart.promise);

      const { voiceRecordingService } = await import("../VoiceRecordingService");
      const starting = voiceRecordingService.start(panelOne);
      await vi.waitFor(() => {
        expect(runtime.voiceInput.start).toHaveBeenCalledTimes(1);
      });

      const first = emitChunk(0, 100);
      const second = emitChunk(0, 200);
      expect(runtime.voiceInput.sendAudioChunk).not.toHaveBeenCalled();

      backendStart.resolve({ ok: true });
      await starting;
      const live = emitChunk(0, 300);

      expect(runtime.voiceInput.sendAudioChunk.mock.calls.map(([chunk]) => chunk)).toEqual([
        first,
        second,
        live,
      ]);
    });

    it("discards queued audio when the start is cancelled before the backend is ready", async () => {
      const backendStart = deferred<{ ok: boolean }>();
      runtime.startQueue.push(backendStart.promise);
      const stream = createStream();
      runtime.getUserMediaQueue.push(stream);

      const { voiceRecordingService } = await import("../VoiceRecordingService");
      const starting = voiceRecordingService.start(panelOne);
      await vi.waitFor(() => {
        expect(runtime.voiceInput.start).toHaveBeenCalledTimes(1);
      });
      emitChunk(0, 100);

      await voiceRecordingService.stop("Dictation stopped.", { skipRemoteStop: true });
      backendStart.resolve({ ok: true });
      await starting;

      expect(runtime.voiceInput.sendAudioChunk).not.toHaveBeenCalled();
      expect(stream.track.stop).toHaveBeenCalled();
    });

    it("discards queued audio when the backend fails to start", async () => {
      const backendStart = deferred<{ ok: boolean; error?: string }>();
      runtime.startQueue.push(backendStart.promise);

      const { voiceRecordingService } = await import("../VoiceRecordingService");
      const starting = voiceRecordingService.start(panelOne);
      await vi.waitFor(() => {
        expect(runtime.voiceInput.start).toHaveBeenCalledTimes(1);
      });
      expect(runtime.createdWorkletNodes[0]?.port.onmessage).toBeTypeOf("function");
      emitChunk(0, 100);

      backendStart.resolve({ ok: false, error: "boom" });
      await starting;

      expect(runtime.voiceInput.sendAudioChunk).not.toHaveBeenCalled();
      expect(runtime.createdStreams[0]!.track.stop).toHaveBeenCalled();
      expect(runtime.voiceFns.setLastError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "backend_start_failed" })
      );
    });

    it("releases capture when the backend start IPC rejects", async () => {
      const backendStart = deferred<{ ok: boolean }>();
      runtime.startQueue.push(backendStart.promise);

      const { voiceRecordingService } = await import("../VoiceRecordingService");
      const starting = voiceRecordingService.start(panelOne);
      await vi.waitFor(() => {
        expect(runtime.voiceInput.start).toHaveBeenCalledTimes(1);
      });
      emitChunk(0, 100);

      backendStart.reject(new Error("service import failed"));
      await expect(starting).resolves.toBeUndefined();

      expect(runtime.voiceInput.sendAudioChunk).not.toHaveBeenCalled();
      expect(runtime.createdStreams[0]!.track.stop).toHaveBeenCalled();
      expect(runtime.createdAudioContexts[0]!.close).toHaveBeenCalled();
      expect(runtime.voiceFns.finishSession).toHaveBeenCalledWith({ nextStatus: "error" });
    });

    it("caps the startup queue by dropping the oldest audio", async () => {
      const backendStart = deferred<{ ok: boolean }>();
      runtime.startQueue.push(backendStart.promise);

      const { voiceRecordingService } = await import("../VoiceRecordingService");
      const starting = voiceRecordingService.start(panelOne);
      await vi.waitFor(() => {
        expect(runtime.voiceInput.start).toHaveBeenCalledTimes(1);
      });
      const chunks = Array.from({ length: 160 }, (_, i) => emitChunk(0, i));

      backendStart.resolve({ ok: true });
      await starting;

      const sent = runtime.voiceInput.sendAudioChunk.mock.calls.map(([chunk]) => chunk);
      expect(sent).toHaveLength(150);
      expect(sent[0]).toBe(chunks[10]);
      expect(sent[149]).toBe(chunks[159]);
    });

    it("releases the microphone when the worklet fails to load", async () => {
      const failure = Promise.reject(new Error("module failed"));
      failure.catch(() => {});
      runtime.addModuleQueue.push(failure);
      const stream = createStream();
      runtime.getUserMediaQueue.push(stream);

      const { voiceRecordingService } = await import("../VoiceRecordingService");
      await voiceRecordingService.start(panelOne);

      expect(stream.track.stop).toHaveBeenCalled();
      expect(runtime.createdAudioContexts[0]?.close).toHaveBeenCalled();
      expect(runtime.voiceFns.beginSession).not.toHaveBeenCalled();
      expect(runtime.voiceFns.setLastError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "renderer_error", severity: "fatal" })
      );
      expect(runtime.voiceFns.finishSession).toHaveBeenCalledWith({ nextStatus: "error" });
    });

    it("attaches the new microphone during a retarget drain without leaking into the old session", async () => {
      const { voiceRecordingService } = await import("../VoiceRecordingService");
      await voiceRecordingService.start(panelOne);
      runtime.voiceState.status = "recording";

      const drain = deferred<void>();
      runtime.stopQueue.push(drain.promise);
      const retargeting = voiceRecordingService.start(panelTwo);
      await vi.waitFor(() => {
        expect(runtime.voiceInput.stop).toHaveBeenCalledTimes(1);
      });
      expect(runtime.createdWorkletNodes).toHaveLength(2);

      const early = emitChunk(1, 100);
      expect(runtime.voiceInput.sendAudioChunk).not.toHaveBeenCalled();

      drain.resolve();
      await retargeting;

      expect(runtime.voiceFns.beginSession).toHaveBeenLastCalledWith(panelTwo);
      expect(runtime.voiceInput.sendAudioChunk.mock.calls.map(([chunk]) => chunk)).toEqual([early]);
      expect(runtime.createdStreams[1]?.track.stop).not.toHaveBeenCalled();
    });

    it("releases the new microphone when a retarget is cancelled during the drain", async () => {
      const { voiceRecordingService } = await import("../VoiceRecordingService");
      await voiceRecordingService.start(panelOne);
      runtime.voiceState.status = "recording";

      const drain = deferred<void>();
      runtime.stopQueue.push(drain.promise);
      const retargeting = voiceRecordingService.start(panelTwo);
      await vi.waitFor(() => {
        expect(runtime.voiceInput.stop).toHaveBeenCalledTimes(1);
      });
      const newStream = runtime.createdStreams[1]!;
      expect(runtime.createdWorkletNodes).toHaveLength(2);
      emitChunk(1, 100);

      const cancelling = voiceRecordingService.stop("Dictation stopped.");
      // Released while the previous session is still draining.
      await vi.waitFor(() => {
        expect(newStream.track.stop).toHaveBeenCalled();
      });
      expect(runtime.createdAudioContexts[1]!.close).toHaveBeenCalled();
      expect(runtime.createdWorkletNodes[1]!.port.onmessage).toBeNull();

      drain.resolve();
      await Promise.all([retargeting, cancelling]);

      expect(runtime.voiceFns.beginSession).toHaveBeenCalledTimes(1);
      expect(runtime.voiceInput.start).toHaveBeenCalledTimes(1);
      expect(runtime.voiceInput.sendAudioChunk).not.toHaveBeenCalled();
    });

    it("ends the previous session when a retarget fails to set up capture", async () => {
      const { voiceRecordingService } = await import("../VoiceRecordingService");
      await voiceRecordingService.start(panelOne);
      runtime.voiceState.status = "recording";
      const oldStream = runtime.createdStreams[0]!;

      const failure = Promise.reject(new Error("module failed"));
      failure.catch(() => {});
      runtime.addModuleQueue.push(failure);
      await voiceRecordingService.start(panelTwo);

      expect(oldStream.track.stop).toHaveBeenCalled();
      expect(runtime.createdStreams[1]!.track.stop).toHaveBeenCalled();
      expect(runtime.voiceInput.stop).toHaveBeenCalledTimes(1);
      expect(runtime.voiceFns.finishSession).toHaveBeenLastCalledWith(
        expect.objectContaining({ nextStatus: "error" })
      );
      expect(runtime.voiceFns.beginSession).toHaveBeenCalledTimes(1);
    });
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

  it("NOT_DETERMINED_PREFLIGHT_REACHES_GET_USER_MEDIA", async () => {
    // Windows reports not-determined and has no native request API, so the
    // preflight only clears the way — getUserMedia is the real gate and must be
    // reached. Regression for the dead-end where a non-grant aborted start().
    runtime.micPermissionQueue.push("not-determined");
    runtime.requestMicPermissionQueue.push(true);

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Panel One" });

    expect(runtime.createdStreams).toHaveLength(1);
    expect(runtime.voiceFns.beginSession).toHaveBeenCalledTimes(1);
    expect(runtime.voiceInput.start).toHaveBeenCalledTimes(1);
  });

  it("NATIVE_PREFLIGHT_DENIAL_SKIPS_CAPTURE", async () => {
    // macOS is the one platform that can deny authoritatively; that false must
    // still abort before we ever open the mic.
    runtime.micPermissionQueue.push("not-determined");
    runtime.requestMicPermissionQueue.push(false);

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Panel One" });

    expect(runtime.createdStreams).toHaveLength(0);
    expect(runtime.voiceFns.beginSession).not.toHaveBeenCalled();
    expect(runtime.voiceFns.setLastError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "mic_permission_denied", severity: "fatal" })
    );
  });

  it("CAPTURE_DENIAL_IS_FATAL_BUT_RETRYABLE", async () => {
    // A denial at the getUserMedia gate must report as a permission denial and
    // leave no cached refusal behind — the next start has to try capture again.
    const denial = Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    denial.catch(() => {}); // Mark handled; the mock still rejects on await.
    const retryStream = createStream();
    runtime.micPermissionQueue.push("not-determined", "not-determined");
    runtime.requestMicPermissionQueue.push(true, true);
    runtime.getUserMediaQueue.push(denial as unknown as MockStream, retryStream);

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const target: VoiceRecordingTarget = { panelId: "panel-1", panelTitle: "Panel One" };

    await voiceRecordingService.start(target);
    expect(runtime.voiceFns.setLastError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "mic_permission_denied", severity: "fatal" })
    );
    expect(runtime.voiceFns.beginSession).not.toHaveBeenCalled();

    await voiceRecordingService.start(target);
    expect(runtime.voiceFns.beginSession).toHaveBeenCalledTimes(1);
    expect(runtime.voiceInput.start).toHaveBeenCalledTimes(1);
  });

  it("OS_LEVEL_DENIAL_NEVER_REACHES_THE_PREFLIGHT", async () => {
    // A status of denied/restricted is already authoritative on every platform,
    // so it must short-circuit ahead of both the preflight and capture.
    for (const status of ["denied", "restricted"]) {
      resetRuntime();
      setupGlobals();
      runtime.micPermissionQueue.push(status);

      vi.resetModules();
      const { voiceRecordingService } = await import("../VoiceRecordingService");
      await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Panel One" });

      expect(runtime.voiceInput.requestMicPermission).not.toHaveBeenCalled();
      expect(runtime.createdStreams).toHaveLength(0);
      expect(runtime.voiceInput.openMicSettings).toHaveBeenCalledTimes(1);
    }
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

  it("MIC_ZERO_CHUNKS_DO_NOT_CLAIM_LISTENING_BUT_STILL_FORWARD", async () => {
    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Panel One" });
    const handler = runtime.createdWorkletNodes[0]?.port.onmessage;

    // Bluetooth HFP warm-up: digital silence plus rounding dither.
    const zeros = new Int16Array(2400);
    const dither = new Int16Array(2400);
    dither[10] = 3;
    dither[20] = -3;
    handler?.(pcmEvent(zeros));
    handler?.(pcmEvent(dither));

    expect(runtime.voiceFns.setMicSignal).not.toHaveBeenCalled();
    expect(runtime.voiceFns.announce).not.toHaveBeenCalledWith(
      expect.stringContaining("Dictation started")
    );
    // The leading audio is never gated on the mic signal.
    expect(runtime.voiceInput.sendAudioChunk).toHaveBeenCalledTimes(2);

    const speech = new Int16Array(2400);
    speech[100] = -66;
    handler?.(pcmEvent(speech));
    handler?.(pcmEvent(speech.slice()));

    expect(runtime.voiceFns.setMicSignal).toHaveBeenCalledTimes(1);
    expect(runtime.voiceFns.setMicSignal).toHaveBeenCalledWith("live");
    expect(
      runtime.voiceFns.announce.mock.calls.filter(([text]) => text.startsWith("Dictation started"))
    ).toHaveLength(1);
    expect(runtime.voiceInput.sendAudioChunk).toHaveBeenCalledTimes(4);
  });

  it("MIC_SILENT_AFTER_GRACE_WINDOW_THEN_RECOVERS", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { voiceRecordingService } = await import("../VoiceRecordingService");
      await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Panel One" });
      const handler = runtime.createdWorkletNodes[0]?.port.onmessage;
      handler?.(pcmEvent(new Int16Array(2400)));

      vi.advanceTimersByTime(2_999);
      expect(runtime.voiceFns.setMicSignal).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(runtime.voiceFns.setMicSignal).toHaveBeenCalledWith("silent");
      expect(runtime.voiceFns.announce).toHaveBeenCalledWith("No audio from the microphone yet.");

      const speech = new Int16Array(2400);
      speech[0] = 1200;
      handler?.(pcmEvent(speech));
      expect(runtime.voiceFns.setMicSignal).toHaveBeenLastCalledWith("live");
    } finally {
      vi.useRealTimers();
    }
  });

  it("MIC_SILENCE_GRACE_ONLY_COUNTS_UNPAUSED_CAPTURE", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { voiceRecordingService } = await import("../VoiceRecordingService");
      await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Panel One" });
      runtime.voiceState.status = "recording";

      voiceRecordingService.pause();
      vi.advanceTimersByTime(10_000);
      expect(runtime.voiceFns.setMicSignal).not.toHaveBeenCalledWith("silent");

      runtime.voiceState.status = "paused";
      voiceRecordingService.resume();
      runtime.voiceState.status = "recording";
      vi.advanceTimersByTime(3_000);
      expect(runtime.voiceFns.setMicSignal).toHaveBeenCalledWith("silent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("MIC_SILENCE_TIMER_CLEARED_ON_STOP", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { voiceRecordingService } = await import("../VoiceRecordingService");
      await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Panel One" });
      await voiceRecordingService.stop();
      runtime.voiceFns.setMicSignal.mockClear();

      vi.advanceTimersByTime(10_000);
      expect(runtime.voiceFns.setMicSignal).not.toHaveBeenCalledWith("silent");
    } finally {
      vi.useRealTimers();
    }
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
    // A late backend error arriving mid-drain (isStoppingSession === true) must be
    // suppressed — it would otherwise clobber lastError and prematurely finalize
    // a session that's already winding down gracefully.
    emitError({ severity: "fatal", code: "ws_close_1006", message: "network lost" });
    stopDeferred.resolve();
    await stopPromise;

    expect(runtime.voiceInput.stop).toHaveBeenCalledTimes(1);
    expect(runtime.voiceFns.finishSession).toHaveBeenCalledTimes(1);
    expect(runtime.voiceFns.announce).toHaveBeenCalledTimes(1);
    // The error is dropped while stopping, so the structured error never reaches
    // the store — lastError stays whatever it was before the graceful stop.
    expect(runtime.voiceFns.setLastError).not.toHaveBeenCalled();
  });

  it("TRANSIENT_ERROR_STORES_STRUCTURED_PAYLOAD_AND_KEEPS_SESSION", async () => {
    runtime.voiceState.activeTarget = { panelId: "panel-1", panelTitle: "Panel One" };
    runtime.voiceState.status = "recording";
    runtime.voiceState.panelBuffers["panel-1"] = createPanelBuffer();

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    voiceRecordingService.initialize();

    const transientError: VoiceInputError = {
      severity: "transient",
      code: "rate_limit_exceeded",
      message: "Rate limited, reconnecting…",
    };
    emitError(transientError);

    // The full structured payload — not just a string — is forwarded to the store
    // so the renderer can branch on code/severity for tooltip and recovery copy.
    expect(runtime.voiceFns.setLastError).toHaveBeenCalledTimes(1);
    expect(runtime.voiceFns.setLastError).toHaveBeenCalledWith(transientError);
    // Transient errors are recoverable: the main process is already reconnecting,
    // so the session must stay alive (no teardown / no remote stop).
    expect(runtime.voiceFns.finishSession).not.toHaveBeenCalled();
    expect(runtime.voiceInput.stop).not.toHaveBeenCalled();
    expect(runtime.voiceState.activeTarget?.panelId).toBe("panel-1");
  });

  it("PAUSE_AUTO_STOPS_AFTER_60S_WHEN_NOT_RESUMED", async () => {
    vi.useFakeTimers();
    try {
      runtime.voiceState.activeTarget = { panelId: "panel-1", panelTitle: "Panel One" };
      runtime.voiceState.status = "recording";

      const { voiceRecordingService } = await import("../VoiceRecordingService");
      voiceRecordingService.initialize();
      const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();

      voiceRecordingService.pause();
      expect(runtime.voiceFns.setStatus).toHaveBeenCalledWith("paused");

      // Just before 60s: nothing happens.
      vi.advanceTimersByTime(59_999);
      expect(stopSpy).not.toHaveBeenCalled();

      // At 60s the auto-stop fires and full teardown is requested.
      vi.advanceTimersByTime(1);
      expect(stopSpy).toHaveBeenCalledWith(
        expect.stringContaining("60-second"),
        expect.objectContaining({ preserveLiveText: true })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("RESUME_BEFORE_60S_CANCELS_AUTO_STOP", async () => {
    vi.useFakeTimers();
    try {
      runtime.voiceState.activeTarget = { panelId: "panel-1", panelTitle: "Panel One" };
      runtime.voiceState.status = "recording";

      const { voiceRecordingService } = await import("../VoiceRecordingService");
      voiceRecordingService.initialize();
      const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();

      voiceRecordingService.pause();
      vi.advanceTimersByTime(30_000);
      voiceRecordingService.resume();

      // Long past the original 60s mark: no auto-stop because resume cancelled it.
      vi.advanceTimersByTime(60_000);
      expect(stopSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("AUTO_STOP_CALLBACK_REREADS_STATE_NOT_STALE_CLOSURE", async () => {
    vi.useFakeTimers();
    try {
      runtime.voiceState.activeTarget = { panelId: "panel-1", panelTitle: "Panel One" };
      runtime.voiceState.status = "recording";

      const { voiceRecordingService } = await import("../VoiceRecordingService");
      voiceRecordingService.initialize();
      const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();

      voiceRecordingService.pause();
      expect(runtime.voiceState.status).toBe("paused");

      // External transition before the timeout fires — e.g. session torn down by
      // an error or a manual stop on a different code path. The callback must
      // re-read state and bail out rather than calling stop() on a dead session.
      runtime.voiceState.status = "idle";

      vi.advanceTimersByTime(60_000);
      expect(stopSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("PAUSE_IGNORES_BACKEND_RECORDING_STATUS", async () => {
    runtime.voiceState.activeTarget = { panelId: "panel-1", panelTitle: "Panel One" };
    runtime.voiceState.status = "recording";

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    voiceRecordingService.initialize();
    runtime.voiceFns.setStatus.mockClear();

    voiceRecordingService.pause();
    expect(runtime.voiceFns.setStatus).toHaveBeenCalledWith("paused");
    runtime.voiceFns.setStatus.mockClear();

    // Backend re-emits "recording" or "reconnecting" while the renderer is
    // locally paused — these must NOT overwrite the local pause state, or the
    // worklet stays gated, the timer stays frozen, and togglePause routes to
    // pause() again instead of resume().
    emitStatus("recording");
    expect(runtime.voiceFns.setStatus).not.toHaveBeenCalled();
    emitStatus("reconnecting");
    expect(runtime.voiceFns.setStatus).not.toHaveBeenCalled();

    // Genuine teardown signals still flow through.
    emitStatus("error");
    expect(runtime.voiceFns.setStatus).toHaveBeenCalledWith("error");
  });

  it("DESTROY_WHILE_PAUSED_CLEARS_AUTO_STOP", async () => {
    vi.useFakeTimers();
    try {
      runtime.voiceState.activeTarget = { panelId: "panel-1", panelTitle: "Panel One" };
      runtime.voiceState.status = "recording";

      const { voiceRecordingService } = await import("../VoiceRecordingService");
      voiceRecordingService.initialize();
      const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();

      voiceRecordingService.pause();
      voiceRecordingService.destroy();

      // The HMR-style destroy path must clear the 60s timer; if it doesn't, the
      // orphaned callback can fire against the next singleton's session state.
      vi.advanceTimersByTime(120_000);
      expect(stopSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("STOP_DURING_PAUSE_CLEARS_AUTO_STOP_TIMER", async () => {
    vi.useFakeTimers();
    try {
      runtime.voiceState.activeTarget = { panelId: "panel-1", panelTitle: "Panel One" };
      runtime.voiceState.status = "recording";

      const { voiceRecordingService } = await import("../VoiceRecordingService");
      voiceRecordingService.initialize();

      voiceRecordingService.pause();
      // Manual stop fires before the auto-stop deadline; let the user-driven
      // teardown complete on the microtask queue under fake timers.
      const stopPromise = voiceRecordingService.stop("Dictation stopped.", {
        skipRemoteStop: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      await stopPromise;
      runtime.voiceFns.finishSession.mockClear();

      // Advance well past the 60s mark — the timer must have been cleared, so
      // no spurious second teardown happens.
      vi.advanceTimersByTime(120_000);
      expect(runtime.voiceFns.finishSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("VoiceRecordingService start diagnostics", () => {
  type Service = (typeof import("../VoiceRecordingService"))["voiceRecordingService"];
  let service: Service | null = null;

  beforeEach(async () => {
    vi.resetModules();
    resetRuntime();
    setupGlobals();
    const { logInfo } = await import("@/utils/logger");
    vi.mocked(logInfo).mockClear();
    service = null;
  });

  afterEach(async () => {
    // The elapsed-time interval is real; leaving a session running would keep
    // this module instance ticking into later tests.
    if (service) {
      await service.stop(undefined, { announce: false });
      service.destroy();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function loadService() {
    const mod = await import("../VoiceRecordingService");
    service = mod.voiceRecordingService;
    const { logInfo } = await import("@/utils/logger");
    const infoCalls = () => vi.mocked(logInfo).mock.calls;
    const detailsFor = (fragment: string) =>
      infoCalls()
        .filter(([message]) => message.includes(fragment))
        .map(([, details]) => details ?? {});
    const steps = () => detailsFor("Start step");
    const openingLogs = () => detailsFor("Opening audio");
    const sendChunk = (samples: Int16Array<ArrayBuffer>, nodeIndex = 0) => {
      const handler = runtime.createdWorkletNodes[nodeIndex]?.port.onmessage;
      if (!handler) throw new Error("worklet handler not attached");
      handler(new MessageEvent<ArrayBuffer>("message", { data: samples.buffer }));
    };
    return {
      voiceRecordingService: mod.voiceRecordingService,
      infoCalls,
      steps,
      openingLogs,
      sendChunk,
    };
  }

  async function startWithLogger() {
    const loaded = await loadService();
    await loaded.voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Panel One" });
    return loaded;
  }

  function expectInOrder(actual: unknown[], expected: string[]) {
    const positions = expected.map((step) => actual.indexOf(step));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  }

  it("logs the start steps in order with monotonic elapsed time", async () => {
    const { steps } = await startWithLogger();

    const logged = steps();
    const names = logged.map((s) => s.step);
    expectInOrder(names, [
      "start",
      "audio_context_create",
      "get_user_media",
      "source_attach",
      "backend_start",
      "startup_audio_flush",
    ]);
    // Settings and permission reads run together, as do the microphone open
    // and the worklet load, so each pair is pinned only to its bracketing steps.
    expectInOrder(names, ["start", "settings", "audio_context_create"]);
    expectInOrder(names, ["start", "permission_check", "audio_context_create"]);
    expectInOrder(names, ["audio_context_create", "worklet_load", "source_attach"]);
    expect(new Set(logged.map((s) => s.startRequestId)).size).toBe(1);
    const elapsed = logged.map((s) => Number(s.elapsedMs));
    for (let i = 1; i < elapsed.length; i++) {
      expect(elapsed[i]).toBeGreaterThanOrEqual(elapsed[i - 1]!);
    }
  });

  it("logs the conditional permission-request and resume steps when those paths run", async () => {
    runtime.micPermissionQueue.push("not-determined");
    runtime.audioContextInitialState = "suspended";

    const { steps } = await startWithLogger();

    const logged = steps();
    expectInOrder(
      logged.map((s) => s.step),
      ["permission_check", "permission_request", "audio_context_create", "audio_context_resume"]
    );
    expect(logged.find((s) => s.step === "audio_context_create")).toMatchObject({
      state: "suspended",
    });
    expect(logged.find((s) => s.step === "audio_context_resume")).toMatchObject({
      state: "running",
    });
  });

  it("separates zero-filled, dithered and above-threshold opening chunks", async () => {
    const { sendChunk, steps, openingLogs } = await startWithLogger();

    sendChunk(new Int16Array(2400));
    sendChunk(new Int16Array(2400));
    sendChunk(Int16Array.from({ length: 2400 }, (_, i) => (i % 2 ? 1 : -1)));
    for (let i = 0; i < 17; i++) sendChunk(new Int16Array(2400).fill(3000));

    const chunkSteps = steps().filter((s) => String(s.step).startsWith("first_"));
    expect(chunkSteps.map((s) => [s.step, s.chunk])).toEqual([
      ["first_chunk", undefined],
      ["first_nonzero_chunk", 3],
      ["first_signal_chunk", 4],
    ]);

    const opening = openingLogs();
    expect(opening).toHaveLength(1);
    expect(opening[0]).toMatchObject({ chunks: 20, allZeroChunks: 2 });
    expect(opening[0]!.zeroFraction).toEqual([1, 1, 0, ...new Array<number>(17).fill(0)]);

    sendChunk(new Int16Array(2400));
    expect(openingLogs()).toHaveLength(1);
    expect(runtime.voiceInput.sendAudioChunk).toHaveBeenCalledTimes(21);
  });

  it("reports a partial opening window when the session stops early", async () => {
    const { voiceRecordingService, sendChunk, openingLogs } = await startWithLogger();

    sendChunk(new Int16Array(2400));
    sendChunk(new Int16Array(2400).fill(3000));
    expect(openingLogs()).toHaveLength(0);

    await voiceRecordingService.stop();

    expect(openingLogs()).toEqual([expect.objectContaining({ chunks: 2, allZeroChunks: 1 })]);
  });

  it("reports the partial window of a failed backend start without leaking it into the next session", async () => {
    const backendStart = deferred<{ ok: boolean; error?: string }>();
    runtime.startQueue.push(backendStart.promise);
    const { voiceRecordingService, sendChunk, openingLogs, steps } = await loadService();

    const firstStart = voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Panel One" });
    await vi.waitFor(() =>
      expect(runtime.createdWorkletNodes[0]?.port.onmessage).toBeTypeOf("function")
    );
    sendChunk(new Int16Array(2400));
    sendChunk(new Int16Array(2400));
    backendStart.resolve({ ok: false, error: "boom" });
    await firstStart;

    const failedId = steps()[0]!.startRequestId;
    expect(openingLogs()).toEqual([
      expect.objectContaining({ startRequestId: failedId, chunks: 2, allZeroChunks: 2 }),
    ]);

    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Panel One" });
    sendChunk(new Int16Array(2400).fill(3000), 1);
    await voiceRecordingService.stop();

    const logs = openingLogs();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatchObject({ chunks: 1, allZeroChunks: 0 });
    expect(logs[1]!.startRequestId).not.toBe(failedId);
  });

  it("measures audio held before the backend is ready on arrival and logs its flush", async () => {
    const backendStart = deferred<{ ok: boolean }>();
    runtime.startQueue.push(backendStart.promise);
    const { voiceRecordingService, sendChunk, steps } = await loadService();

    const starting = voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Panel One" });
    await vi.waitFor(() => expect(runtime.voiceInput.start).toHaveBeenCalledTimes(1));
    sendChunk(new Int16Array(2400));
    sendChunk(new Int16Array(2400).fill(3000));

    const arrivalSteps = steps().filter((s) => String(s.step).startsWith("first_"));
    expect(arrivalSteps).toEqual([
      expect.objectContaining({ step: "first_chunk", held: true }),
      expect.objectContaining({ step: "first_nonzero_chunk", chunk: 2 }),
      expect.objectContaining({ step: "first_signal_chunk", chunk: 2 }),
    ]);
    expect(runtime.voiceInput.sendAudioChunk).not.toHaveBeenCalled();

    backendStart.resolve({ ok: true });
    await starting;

    expect(steps().find((s) => s.step === "startup_audio_flush")).toMatchObject({
      chunks: 2,
      droppedChunks: 0,
    });
    expect(runtime.voiceInput.sendAudioChunk).toHaveBeenCalledTimes(2);
  });

  it("keeps a retarget's opening window out of the previous session's stop", async () => {
    const { voiceRecordingService, sendChunk, openingLogs, steps } = await startWithLogger();
    const firstId = steps()[0]!.startRequestId;

    const previousStop = deferred<void>();
    runtime.stopQueue.push(previousStop.promise);
    const retarget = voiceRecordingService.start({ panelId: "panel-2", panelTitle: "Panel Two" });
    await vi.waitFor(() => expect(runtime.voiceInput.stop).toHaveBeenCalledTimes(1));

    // The new attempt's capture is already attached while the old session drains.
    sendChunk(new Int16Array(2400).fill(3000), 1);
    sendChunk(new Int16Array(2400).fill(3000), 1);
    previousStop.resolve();
    await retarget;

    expect(openingLogs()).toEqual([]);
    await voiceRecordingService.stop();

    const logs = openingLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ chunks: 2, allZeroChunks: 0 });
    expect(logs[0]!.startRequestId).not.toBe(firstId);
  });

  it("logs track mute/unmute/ended and AudioContext state changes", async () => {
    const trackListeners: Record<string, () => void> = {};
    const track = {
      stop: vi.fn(),
      muted: true,
      readyState: "live",
      addEventListener: vi.fn((type: string, cb: () => void) => {
        trackListeners[type] = cb;
      }),
    };
    runtime.getUserMediaQueue.push({
      track,
      getTracks: () => [track],
      getAudioTracks: () => [track],
    });

    const { steps } = await startWithLogger();

    track.muted = false;
    trackListeners.unmute?.();
    track.readyState = "ended";
    trackListeners.ended?.();
    runtime.createdAudioContexts[0]!.state = "interrupted";
    runtime.audioContextListeners.get("statechange")?.();

    const events = steps().filter(
      (s) => String(s.step).startsWith("track_") || s.step === "audio_context_statechange"
    );
    expect(events).toEqual([
      expect.objectContaining({ step: "track_unmute", muted: false, readyState: "live" }),
      expect.objectContaining({ step: "track_ended", readyState: "ended" }),
      expect.objectContaining({ step: "audio_context_statechange", state: "interrupted" }),
    ]);
    expect(Object.keys(trackListeners).sort()).toEqual(["ended", "mute", "unmute"]);
  });

  it("keeps capturing when a start diagnostic fails to log", async () => {
    const { logInfo } = await import("@/utils/logger");
    vi.mocked(logInfo).mockImplementation((message: string) => {
      if (message.includes("Start step") || message.includes("Opening audio")) {
        throw new Error("logger down");
      }
    });
    try {
      const { sendChunk } = await startWithLogger();
      expect(runtime.createdWorkletNodes).toHaveLength(1);
      for (let i = 0; i < 20; i++) sendChunk(new Int16Array(2400).fill(3000));
      expect(runtime.voiceInput.sendAudioChunk).toHaveBeenCalledTimes(20);
    } finally {
      vi.mocked(logInfo).mockReset();
    }
  });

  it("never puts raw samples or buffers in log payloads", async () => {
    const { sendChunk, infoCalls } = await startWithLogger();
    for (let i = 0; i < 20; i++) sendChunk(new Int16Array(2400).fill(1234));

    for (const [, details] of infoCalls()) {
      for (const value of Object.values(details ?? {})) {
        expect(value instanceof ArrayBuffer || ArrayBuffer.isView(value)).toBe(false);
        if (Array.isArray(value)) expect(value.length).toBeLessThanOrEqual(20);
      }
    }
  });
});
