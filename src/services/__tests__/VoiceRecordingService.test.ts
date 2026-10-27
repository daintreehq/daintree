import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { isActiveVoiceSession, type VoiceLiveSessionUpdate } from "@shared/types";

// Capture suspend/wake callbacks registered by the service.
const suspendCallbacks = vi.hoisted(() => [] as Array<() => void>);

const focusDictationComposer = vi.hoisted(() => vi.fn());
// The real one reads the DOM, which these suites stub in part; its own suite
// is voiceComposerFocus.test.tsx.
const revealDictationComposer = vi.hoisted(() => vi.fn());
vi.mock("@/services/voiceComposerFocus", () => ({
  focusDictationComposer,
  revealDictationComposer,
}));

// Whether main has this view cached, and its lifecycle edges, as a test drives them.
const viewLifecycle = vi.hoisted(() => ({
  cached: false,
  listeners: new Set<(phase: "cached" | "active" | "revealed") => void>(),
}));
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewCached: () => viewLifecycle.cached,
  subscribeProjectViewLifecycle: (listener: (phase: "cached" | "active" | "revealed") => void) => {
    viewLifecycle.listeners.add(listener);
    return () => viewLifecycle.listeners.delete(listener);
  },
}));

const switchToHost = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/components/Hosts/hostSwitching", () => ({ switchToHost }));

vi.mock("@/store/voiceRecordingStore", () => {
  const state = {
    activeTarget: null as { panelId: string } | null,
    pendingTarget: null as { panelId: string } | null,
    status: "idle" as string,
    panelBuffers: {} as Record<string, unknown>,
    correctionEnabled: false,
    isConfigured: false,
    lockedTarget: null as { panelId: string } | null,
    recentTargets: [] as Array<unknown>,
    micSignal: "pending" as string,
    micDeviceLabel: null as string | null,
    micNotice: null as unknown,
    sessionElsewhere: null as unknown,
  };
  const fns = {
    applyLiveSessionUpdate: vi.fn(),
    setLastError: vi.fn(),
    announce: vi.fn(),
    setStatus: vi.fn(),
    setConfigured: vi.fn(),
    setCorrectionEnabled: vi.fn(),
    setLearnFromCorrections: vi.fn(),
    setSessionCorrectedText: vi.fn(),
    setArming: vi.fn(),
    clearPendingTarget: vi.fn(() => {
      state.pendingTarget = null;
    }),
    beginSession: vi.fn(),
    finishSession: vi.fn(),
    setAudioLevel: vi.fn(),
    setMicSignal: vi.fn((signal: string) => {
      state.micSignal = signal;
    }),
    setMicDeviceLabel: vi.fn((label: string | null) => {
      state.micDeviceLabel = label;
    }),
    setMicNotice: vi.fn((notice: unknown) => {
      state.micNotice = notice;
    }),
    setElapsedSeconds: vi.fn(),
    appendDelta: vi.fn(),
    completeSegment: vi.fn(),
    setSessionDraftStart: vi.fn(),
    setActiveParagraphStart: vi.fn(),
    clearPanelBuffer: vi.fn(),
    consumeCompletedSegments: vi.fn(() => []),
    lockTarget: vi.fn(),
    unlockTarget: vi.fn(),
    clearLockedTarget: vi.fn(),
    recordRecentTarget: vi.fn(),
  };
  const getState = () => ({ ...state, ...fns });
  const subscribe = vi.fn(() => () => {});
  return {
    useVoiceRecordingStore: Object.assign(getState, { getState, subscribe }),
    isVoiceMicPending: (s: { status: string; micSignal: string }) =>
      ["connecting", "recording", "reconnecting"].includes(s.status) && s.micSignal !== "live",
    __state: state,
  };
});

vi.mock("@/store/panelStore", () => {
  const state = {
    panelsById: {} as Record<string, unknown>,
    panelIds: [] as string[],
    focusedId: null as string | null,
  };
  const getState = () => state;
  const subscribe = vi.fn(() => () => {});
  return { usePanelStore: Object.assign(getState, { getState, subscribe }), __state: state };
});

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

vi.mock("@/store/canopyStore", () => {
  const state = { isOpen: false };
  const getState = () => state;
  return { useCanopyStore: Object.assign(getState, { getState }), __state: state };
});

vi.mock("@/store/terminalInputStore", () => {
  const fns = {
    getDraftInput: vi.fn(() => ""),
    setDraftInput: vi.fn(),
    bumpExternalDraftRevision: vi.fn(),
  };
  const getState = () => ({ ...fns, hybridInputEnabled: true });
  return {
    useTerminalInputStore: Object.assign(getState, { getState, subscribe: () => () => {} }),
  };
});

vi.mock("@/store/projectStore", () => {
  const state = { currentProject: null, isSwitching: false };
  const switchProject = vi.fn();
  const getState = () => ({ ...state, switchProject });
  return { useProjectStore: Object.assign(getState, { getState }), __switchProject: switchProject };
});

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({
    getState: () => ({ worktrees: new Map() }),
  }),
}));

vi.mock("@/store/worktreeStore", () => {
  const getState = () => ({ activeWorktreeId: null, selectWorktree: vi.fn() });
  return { useWorktreeSelectionStore: Object.assign(getState, { getState }) };
});

vi.mock("@/store/helpPanelStore", () => {
  const state = {
    isOpen: false,
    terminalId: null as string | null,
  };
  // #12108: dictation targets the lane on screen. This fixture runs one lane,
  // so the selector projects the same flat state as that lane.
  const selectActiveSlot = (s: typeof state) => s;
  const fns = {
    setOpen: vi.fn((open: boolean) => {
      state.isOpen = open;
    }),
    requestFocus: vi.fn(),
  };
  const getState = () => ({ ...state, ...fns });
  return {
    useHelpPanelStore: Object.assign(getState, { getState }),
    selectActiveSlot,
    __state: state,
    __fns: fns,
  };
});

vi.mock("@/store/macroFocusStore", () => {
  return { isAssistantFocused: vi.fn(() => false) };
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
    getEffectiveCombo: vi.fn((actionId: string) => {
      if (actionId === "voiceInput.toggle") return "Cmd+.";
      if (actionId === "voiceInput.toggleAssistant") return "Cmd+Shift+Alt+V";
      return undefined;
    }),
    getEffectiveCombos: vi.fn((actionId: string) => {
      if (actionId === "voiceInput.toggle") return ["Cmd+."];
      if (actionId === "voiceInput.toggleAssistant") return ["Cmd+Shift+Alt+V"];
      return [];
    }),
    matchesEvent: vi.fn(),
  },
}));

function buildElectronStub() {
  return {
    voiceInput: {
      onTranscriptionDelta: vi.fn(() => () => {}),
      onTranscriptionComplete: vi.fn(() => () => {}),
      onParagraphBoundary: vi.fn(() => () => {}),
      onFileTokenResolved: vi.fn(() => () => {}),
      onError: vi.fn(() => () => {}),
      onStatus: vi.fn(() => () => {}),
      onSessionEnded: vi.fn(() => () => {}),
      onLiveSession: vi.fn((_callback: (update: VoiceLiveSessionUpdate) => void) => () => {}),
      onStopRequested: vi.fn((_callback: (payload: { sessionId: string }) => void) => () => {}),
      onRevealRequested: vi.fn(
        (_callback: (payload: { sessionId: string; workspaceId: string | null }) => void) =>
          () => {}
      ),
      getLiveSession: vi.fn().mockResolvedValue({ revision: 0, session: null }),
      getSettings: vi.fn().mockResolvedValue({
        enabled: true,
        openaiApiKey: "sk-key",
        correctionEnabled: false,
      }),
      checkMicPermission: vi.fn().mockResolvedValue("granted"),
      requestMicPermission: vi.fn().mockResolvedValue(true),
      openMicSettings: vi.fn(),
      sendAudioChunk: vi.fn(),
      start: vi.fn().mockResolvedValue({ status: "started" }),
      stop: vi.fn().mockResolvedValue(undefined),
      stopLive: vi.fn().mockResolvedValue(true),
      revealLive: vi.fn().mockResolvedValue(true),
    },
    systemSleep: {
      onSuspend: vi.fn((cb: () => void) => {
        suspendCallbacks.push(cb);
        return () => {};
      }),
      onWake: vi.fn(() => () => {}),
    },
  };
}

function buildAudioContextMock() {
  const destination = {};
  const oscillatorMock = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
  const gainMock = {
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const workletNodeMock = {
    port: { onmessage: null as unknown },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  const sourceMock = { connect: vi.fn(), disconnect: vi.fn() };
  const ctx = {
    state: "running",
    destination,
    sampleRate: 24000,
    resume: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createGain: vi.fn(() => gainMock),
    createOscillator: vi.fn(() => oscillatorMock),
    createMediaStreamSource: vi.fn(() => sourceMock),
    audioWorklet: {
      addModule: vi.fn().mockResolvedValue(undefined),
    },
  };
  return { ctx, oscillatorMock, gainMock, workletNodeMock };
}

// Set up browser globals for all tests in this suite.
// The store mock exposes its backing state for tests to prime.
async function voiceStoreState() {
  const { __state } = (await import("@/store/voiceRecordingStore")) as unknown as {
    __state: { activeTarget: { panelId: string } | null };
  };
  return __state;
}

function fakeStream(stream: object): MediaStream {
  return stream as MediaStream;
}

function setupGlobals(electronStub = buildElectronStub()) {
  const windowListeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const documentListeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  vi.stubGlobal("window", {
    electron: electronStub,
    addEventListener: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      windowListeners[event] ??= [];
      windowListeners[event].push(cb);
    }),
    removeEventListener: vi.fn(),
    requestAnimationFrame: vi.fn(),
    cancelAnimationFrame: vi.fn(),
  });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 0)
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());

  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      documentListeners[event] ??= [];
      documentListeners[event].push(cb);
    }),
    removeEventListener: vi.fn(),
  });

  const audio = buildAudioContextMock();
  const { ctx, oscillatorMock, gainMock } = audio;
  // Must be a regular function (not arrow) so it works as a constructor with `new`.
  vi.stubGlobal("AudioContext", function () {
    return ctx;
  });
  // Capture the most-recently-constructed worklet node so tests can inspect its
  // port. The service calls `port.postMessage` to signal pause/resume.
  const workletNodes: Array<{
    port: { onmessage: null | ((e: unknown) => void); postMessage: ReturnType<typeof vi.fn> };
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  vi.stubGlobal("AudioWorkletNode", function () {
    const node = {
      port: { onmessage: null, postMessage: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    workletNodes.push(node);
    return node;
  });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [{ stop: vi.fn() }],
        getAudioTracks: () => [{}],
      }),
    },
  });

  return {
    windowListeners,
    documentListeners,
    electronStub,
    ctx,
    oscillatorMock,
    gainMock,
    workletNodes,
  };
}

describe("VoiceRecordingService — background recording", () => {
  beforeEach(() => {
    vi.resetModules();
    suspendCallbacks.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not stop recording when the window loses focus (blur event)", async () => {
    const { windowListeners } = setupGlobals();

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi.spyOn(voiceRecordingService, "stop");

    voiceRecordingService.initialize();

    // Fire every registered window "blur" listener. The push-to-talk blur
    // listener (#9189) registers but is a no-op when no PTT press is active,
    // so stop() must still not be called in toggle mode.
    const blurListeners = windowListeners["blur"] ?? [];
    for (const listener of blurListeners) {
      await listener(new Event("blur"));
    }

    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("does not stop recording when the window is hidden (visibilitychange event)", async () => {
    const { documentListeners } = setupGlobals();

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi.spyOn(voiceRecordingService, "stop");

    voiceRecordingService.initialize();

    // Simulate visibility becoming hidden.
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });

    const visListeners = documentListeners["visibilitychange"] ?? [];
    for (const listener of visListeners) {
      await listener(new Event("visibilitychange"));
    }

    expect(stopSpy).not.toHaveBeenCalled();
    expect(visListeners).toHaveLength(0);
  });

  it("still stops recording when the system goes to sleep (regression guard)", async () => {
    setupGlobals();

    // Prime the store with an active target so the suspend handler fires.
    const __state = await voiceStoreState();
    __state.activeTarget = { panelId: "panel-1" };

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi.spyOn(voiceRecordingService, "stop");

    voiceRecordingService.initialize();

    expect(suspendCallbacks.length).toBeGreaterThan(0);
    for (const cb of suspendCallbacks) {
      await cb();
    }

    expect(stopSpy).toHaveBeenCalledWith(
      expect.stringContaining("sleep"),
      expect.objectContaining({ preserveLiveText: true })
    );

    __state.activeTarget = null;
  });

  it("creates a silent keep-alive oscillator during start() to prevent AudioContext suspension", async () => {
    const { ctx, oscillatorMock, gainMock } = setupGlobals();

    const { voiceRecordingService } = await import("../VoiceRecordingService");

    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });

    expect(ctx.createOscillator).toHaveBeenCalled();
    expect(ctx.createGain).toHaveBeenCalled();
    expect(oscillatorMock.start).toHaveBeenCalled();
    expect(gainMock.gain.value).toBe(0);
    expect(oscillatorMock.connect).toHaveBeenCalledWith(gainMock);
    expect(gainMock.connect).toHaveBeenCalledWith(ctx.destination);
  });

  it("tells main which terminal it is dictating into", async () => {
    setupGlobals();

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await voiceRecordingService.start({ panelId: "panel-7", panelTitle: "Terminal" });

    expect(window.electron.voiceInput.start).toHaveBeenCalledWith(expect.any(String), {
      terminalId: "panel-7",
    });
  });

  it("tells main the terminal a Canopy reply types to, not the reply's own id", async () => {
    setupGlobals();

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await voiceRecordingService.start({
      panelId: "isolated-composer:run-7",
      surface: "canopy-reply",
      terminalId: "run-7",
    });

    expect(window.electron.voiceInput.start).toHaveBeenCalledWith(expect.any(String), {
      terminalId: "run-7",
    });
  });

  it("gives main nothing of this view's for a reply to a terminal outside it", async () => {
    setupGlobals();

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await voiceRecordingService.start({
      panelId: "isolated-composer:host-2:run-7",
      surface: "canopy-reply",
      otherHostId: "host-2",
    });

    expect(window.electron.voiceInput.start).toHaveBeenCalledWith(expect.any(String), {
      outsideView: true,
    });
  });

  it("tells main when the session records a rewrite instruction", async () => {
    setupGlobals();

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const selection = {
      text: "make me shorter",
      range: () => ({ from: 0, to: 15 }),
      onLost: () => {},
      apply: () => true,
      release: () => {},
    };
    await voiceRecordingService.start({
      panelId: "panel-7",
      rewrite: { selection, instruction: [], cancelled: false },
    });

    expect(window.electron.voiceInput.start).toHaveBeenCalledWith(expect.any(String), {
      terminalId: "panel-7",
      intent: "rewrite",
    });
  });

  // Constructed after getUserMedia, the context's synchronous output-device
  // lookup queued behind the input stream start and froze the renderer ~650ms.
  it("constructs the AudioContext before opening the microphone", async () => {
    const { ctx } = setupGlobals();
    const audioContextCtor = vi.fn(function () {
      return ctx;
    });
    vi.stubGlobal("AudioContext", audioContextCtor);
    const getUserMedia = vi.mocked(navigator.mediaDevices.getUserMedia);

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });

    expect(audioContextCtor).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(audioContextCtor.mock.invocationCallOrder[0]).toBeLessThan(
      getUserMedia.mock.invocationCallOrder[0]!
    );
  });

  it("reads settings and microphone permission together rather than in series", async () => {
    const electronStub = buildElectronStub();
    let resolveSettings: (value: unknown) => void = () => {};
    electronStub.voiceInput.getSettings.mockReturnValue(
      new Promise((resolve) => {
        resolveSettings = resolve;
      })
    );
    setupGlobals(electronStub);

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const starting = voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });

    await vi.waitFor(() => expect(electronStub.voiceInput.checkMicPermission).toHaveBeenCalled());
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();

    resolveSettings({ enabled: true, openaiApiKey: "sk-key", correctionEnabled: false });
    await starting;
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("asks for an AudioContext that opens no output device", async () => {
    const { ctx } = setupGlobals();
    const audioContextCtor = vi.fn(function () {
      return ctx;
    });
    vi.stubGlobal("AudioContext", audioContextCtor);

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });

    expect(audioContextCtor).toHaveBeenCalledWith(
      expect.objectContaining({ sinkId: { type: "none" } })
    );
  });

  it("falls back to the default output when the silent sink is rejected", async () => {
    const { ctx } = setupGlobals();
    const audioContextCtor = vi.fn(function (options: { sinkId?: unknown }) {
      if (options.sinkId) throw new DOMException("unsupported", "NotSupportedError");
      return ctx;
    });
    vi.stubGlobal("AudioContext", audioContextCtor);

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });

    expect(audioContextCtor).toHaveBeenCalledTimes(2);
    expect(window.electron.voiceInput.start).toHaveBeenCalledTimes(1);
  });

  it("parks the pre-built AudioContext when the microphone can't be opened", async () => {
    const { ctx } = setupGlobals();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(
      new DOMException("denied", "NotAllowedError")
    );

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });

    await vi.waitFor(() => expect(ctx.suspend).toHaveBeenCalledTimes(1));
    expect(ctx.close).not.toHaveBeenCalled();
    expect(ctx.createMediaStreamSource).not.toHaveBeenCalled();
  });

  it("releases the microphone when the start is cancelled while it is pending", async () => {
    const { ctx } = setupGlobals();
    const getUserMedia = vi.mocked(navigator.mediaDevices.getUserMedia);
    const track = { stop: vi.fn() };
    const stream = fakeStream({ getTracks: () => [track], getAudioTracks: () => [{}] });
    let grantMicrophone = () => {};
    getUserMedia.mockReturnValue(
      new Promise((resolve) => {
        grantMicrophone = () => resolve(stream);
      })
    );

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const starting = voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalled());

    await voiceRecordingService.stop();
    await vi.waitFor(() => expect(ctx.suspend).toHaveBeenCalledTimes(1));

    grantMicrophone();
    await starting;

    // The stale start still releases the late-arriving microphone, without
    // releasing the already-released context a second time.
    expect(track.stop).toHaveBeenCalled();
    await Promise.resolve();
    expect(ctx.suspend).toHaveBeenCalledTimes(1);
    expect(ctx.close).not.toHaveBeenCalled();
    expect(ctx.createMediaStreamSource).not.toHaveBeenCalled();
  });

  it("releases the microphone and parks the AudioContext when stop() is called", async () => {
    const { ctx, oscillatorMock, workletNodes } = setupGlobals();
    const track = { stop: vi.fn() };
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(
      fakeStream({
        getTracks: () => [track],
        getAudioTracks: () => [{}],
      })
    );

    const __state = await voiceStoreState();
    __state.activeTarget = { panelId: "panel-1" };

    const { voiceRecordingService } = await import("../VoiceRecordingService");

    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });
    await voiceRecordingService.stop("Dictation stopped.", { skipRemoteStop: true });

    expect(track.stop).toHaveBeenCalled();
    expect(workletNodes[0]!.port.postMessage).toHaveBeenCalledWith({ type: "dispose" });
    expect(workletNodes[0]!.disconnect).toHaveBeenCalled();
    await vi.waitFor(() => expect(ctx.suspend).toHaveBeenCalledTimes(1));
    expect(oscillatorMock.stop).not.toHaveBeenCalled();
    expect(ctx.close).not.toHaveBeenCalled();

    __state.activeTarget = null;
  });

  it("reuses the AudioContext and worklet for the next dictation, with a fresh microphone", async () => {
    const { ctx } = setupGlobals();
    const audioContextCtor = vi.fn(function () {
      return ctx;
    });
    vi.stubGlobal("AudioContext", audioContextCtor);
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
    const getUserMedia = vi.mocked(navigator.mediaDevices.getUserMedia);
    for (const track of tracks) {
      getUserMedia.mockResolvedValueOnce(
        fakeStream({
          getTracks: () => [track],
          getAudioTracks: () => [{}],
        })
      );
    }

    const __state = await voiceStoreState();
    const { voiceRecordingService } = await import("../VoiceRecordingService");
    for (const track of tracks) {
      __state.activeTarget = { panelId: "panel-1" };
      await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });
      await voiceRecordingService.stop("Dictation stopped.", { skipRemoteStop: true });
      expect(track.stop).toHaveBeenCalled();
    }

    expect(audioContextCtor).toHaveBeenCalledTimes(1);
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(ctx.createMediaStreamSource).toHaveBeenCalledTimes(2);
    // The second start resumes the context the first stop suspended.
    await vi.waitFor(() => expect(ctx.suspend).toHaveBeenCalledTimes(2));
    expect(ctx.resume.mock.invocationCallOrder[1]!).toBeGreaterThan(
      ctx.suspend.mock.invocationCallOrder[0]!
    );
    expect(ctx.close).not.toHaveBeenCalled();
    __state.activeTarget = null;
  });

  it("resumes for the next dictation only once the last stop's suspend has landed", async () => {
    const { ctx } = setupGlobals();
    let suspended!: () => void;
    ctx.suspend.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          suspended = () => resolve(undefined);
        })
    );

    const __state = await voiceStoreState();
    const { voiceRecordingService } = await import("../VoiceRecordingService");
    __state.activeTarget = { panelId: "panel-1" };
    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });
    await voiceRecordingService.stop("Dictation stopped.", { skipRemoteStop: true });
    await vi.waitFor(() => expect(ctx.suspend).toHaveBeenCalledTimes(1));

    __state.activeTarget = { panelId: "panel-1" };
    const starting = voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });
    await vi.waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.resume).toHaveBeenCalledTimes(1);

    suspended();
    await starting;
    expect(ctx.resume).toHaveBeenCalledTimes(2);
    expect(window.electron.voiceInput.start).toHaveBeenCalledTimes(2);
    __state.activeTarget = null;
  });

  it("closes the parked AudioContext when the system goes to sleep", async () => {
    const { ctx } = setupGlobals();
    const __state = await voiceStoreState();
    const { voiceRecordingService } = await import("../VoiceRecordingService");
    voiceRecordingService.initialize();
    __state.activeTarget = { panelId: "panel-1" };
    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });
    await voiceRecordingService.stop("Dictation stopped.", { skipRemoteStop: true });
    __state.activeTarget = null;
    expect(ctx.close).not.toHaveBeenCalled();

    for (const cb of suspendCallbacks) cb();
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it("closes the AudioContext on destroy only once the capture on it is released", async () => {
    const { ctx } = setupGlobals();
    const __state = await voiceStoreState();
    const { voiceRecordingService } = await import("../VoiceRecordingService");
    __state.activeTarget = { panelId: "panel-1" };
    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });

    voiceRecordingService.destroy();
    expect(ctx.close).not.toHaveBeenCalled();

    await voiceRecordingService.stop("Dictation stopped.", { skipRemoteStop: true });
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(ctx.suspend).not.toHaveBeenCalled();
    __state.activeTarget = null;
  });

  it("closes the idle AudioContext after a few minutes, and builds a new one after", async () => {
    const { ctx } = setupGlobals();
    const audioContextCtor = vi.fn(function () {
      return ctx;
    });
    vi.stubGlobal("AudioContext", audioContextCtor);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const __state = await voiceStoreState();
      const { voiceRecordingService } = await import("../VoiceRecordingService");
      __state.activeTarget = { panelId: "panel-1" };
      await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });
      await voiceRecordingService.stop("Dictation stopped.", { skipRemoteStop: true });

      vi.advanceTimersByTime(60_000);
      expect(ctx.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5 * 60_000);
      expect(ctx.close).toHaveBeenCalledTimes(1);

      __state.activeTarget = { panelId: "panel-1" };
      await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });
      expect(audioContextCtor).toHaveBeenCalledTimes(2);
      __state.activeTarget = null;
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds a fresh AudioContext after the worklet fails to load", async () => {
    const { ctx } = setupGlobals();
    const audioContextCtor = vi.fn(function () {
      return ctx;
    });
    vi.stubGlobal("AudioContext", audioContextCtor);
    ctx.audioWorklet.addModule.mockRejectedValueOnce(new Error("module failed"));

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });
    expect(ctx.close).toHaveBeenCalledTimes(1);

    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });
    expect(audioContextCtor).toHaveBeenCalledTimes(2);
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledTimes(2);
  });

  it("stops recording when the active panel is moved to trash (panel-close regression)", async () => {
    // Capture the terminalStore subscribe callback so we can trigger it.
    let storeCallback:
      ((state: { panelsById: Record<string, unknown>; panelIds: string[] }) => void) | null = null;
    const { usePanelStore } = (await import("@/store/panelStore")) as unknown as {
      usePanelStore: { subscribe: ReturnType<typeof vi.fn> };
    };
    (usePanelStore.subscribe as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (state: { panelsById: Record<string, unknown>; panelIds: string[] }) => void) => {
        storeCallback = cb;
        return () => {};
      }
    );

    const voiceState = await voiceStoreState();
    voiceState.activeTarget = { panelId: "panel-1" };

    setupGlobals();
    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi.spyOn(voiceRecordingService, "stop");

    voiceRecordingService.initialize();

    // Simulate the panel being removed from the terminal list.
    expect(storeCallback).not.toBeNull();
    storeCallback!({ panelsById: {}, panelIds: [] });

    expect(stopSpy).toHaveBeenCalledWith(
      "Dictation stopped because its panel was closed.",
      expect.objectContaining({ preserveLiveText: true })
    );

    voiceState.activeTarget = null;
  });
});

describe("isActiveVoiceSession helper", () => {
  it("returns false for arming — it is pre-audio, not an active session", () => {
    // Arming must be excluded so the toggle guard treats a second hotkey
    // press during arming as continuing the start, not stopping a session
    // that hasn't begun.
    expect(isActiveVoiceSession("arming")).toBe(false);
  });
});

describe("VoiceRecordingService — the keyboard follows a start (#14770)", () => {
  beforeEach(() => {
    vi.resetModules();
    suspendCallbacks.length = 0;
    focusDictationComposer.mockClear();
  });

  afterEach(() => {
    // The store mock is shared with the suites after this one, and one of them
    // compares the first arming call with its own start.
    if (arranged) {
      arranged.state.status = "idle";
      arranged.state.activeTarget = null;
      arranged.state.pendingTarget = null;
      arranged.state.lockedTarget = null;
      for (const fn of arranged.calls) fn.mockClear();
      arranged = null;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  type VoiceState = {
    status: string;
    activeTarget: { panelId: string } | null;
    pendingTarget: { panelId: string } | null;
    lockedTarget: { panelId: string } | null;
  };
  let arranged: { state: VoiceState; calls: Mock[] } | null = null;

  async function arrange(recordingMode: "toggle" | "push-to-talk" = "toggle") {
    const electron = buildElectronStub();
    electron.voiceInput.getSettings.mockResolvedValue({
      enabled: true,
      openaiApiKey: "sk-key",
      correctionEnabled: false,
      recordingMode,
    });
    setupGlobals(electron);

    const panelState: { focusedId: string | null; panelsById: Record<string, unknown> } =
      Reflect.get(await import("@/store/panelStore"), "__state");
    panelState.focusedId = "panel-1";
    panelState.panelsById = {
      "panel-1": { id: "panel-1", title: "One", location: "grid", launchAgentId: "claude" },
      "panel-2": { id: "panel-2", title: "Two", location: "grid", launchAgentId: "claude" },
    };
    const voiceState: VoiceState = Reflect.get(
      await import("@/store/voiceRecordingStore"),
      "__state"
    );
    const { setArming, recordRecentTarget } = (
      await import("@/store/voiceRecordingStore")
    ).useVoiceRecordingStore.getState();
    arranged = { state: voiceState, calls: [vi.mocked(setArming), vi.mocked(recordRecentTarget)] };
    voiceState.status = "idle";
    voiceState.activeTarget = null;
    voiceState.pendingTarget = null;
    voiceState.lockedTarget = null;

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const startSpy = vi.spyOn(voiceRecordingService, "start").mockResolvedValue();
    const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();
    voiceRecordingService.initialize();
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });
    return { voiceRecordingService, voiceState, startSpy, stopSpy };
  }

  // The mic button in a pane's input bar.
  it("asks for the target's composer when a toggle starts dictation, before the mic opens", async () => {
    const { voiceRecordingService, startSpy } = await arrange();

    await voiceRecordingService.toggle({ panelId: "panel-1" });

    expect(focusDictationComposer).toHaveBeenCalledTimes(1);
    expect(focusDictationComposer).toHaveBeenCalledWith("panel-1");
    expect(focusDictationComposer.mock.invocationCallOrder[0]).toBeLessThan(
      startSpy.mock.invocationCallOrder[0]!
    );
  });

  it("asks for it from the dictation key", async () => {
    const { voiceRecordingService, startSpy } = await arrange();

    await voiceRecordingService.toggleFocusedPanel();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(focusDictationComposer).toHaveBeenCalledTimes(1);
    expect(focusDictationComposer).toHaveBeenCalledWith("panel-1");
  });

  it("asks for it from a held key in push-to-talk", async () => {
    const { voiceRecordingService, startSpy } = await arrange("push-to-talk");

    await voiceRecordingService.toggleFocusedPanel();

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(focusDictationComposer).toHaveBeenCalledTimes(1);
    expect(focusDictationComposer).toHaveBeenCalledWith("panel-1");
    expect(focusDictationComposer.mock.invocationCallOrder[0]).toBeLessThan(
      startSpy.mock.invocationCallOrder[0]!
    );
  });

  // The resolved target, not the selected pane: the two differ for the assistant.
  it("names the resolved target in push-to-talk", async () => {
    const { voiceRecordingService, startSpy } = await arrange("push-to-talk");
    const { isAssistantFocused } = await import("@/store/macroFocusStore");
    const helpState: { terminalId: string | null } = Reflect.get(
      await import("@/store/helpPanelStore"),
      "__state"
    );
    vi.mocked(isAssistantFocused).mockReturnValue(true);
    helpState.terminalId = "assistant-term-1";
    const panelState: { panelsById: Record<string, unknown> } = Reflect.get(
      await import("@/store/panelStore"),
      "__state"
    );
    panelState.panelsById["assistant-term-1"] = { id: "assistant-term-1", location: "background" };

    try {
      await voiceRecordingService.toggleFocusedPanel();
    } finally {
      vi.mocked(isAssistantFocused).mockReturnValue(false);
      helpState.terminalId = null;
    }

    expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({ panelId: "assistant-term-1" }));
    expect(focusDictationComposer).toHaveBeenCalledTimes(1);
    expect(focusDictationComposer).toHaveBeenCalledWith("assistant-term-1");
  });

  // The helper decides what a pane other than the selected one gets; the
  // service names the pane dictation goes to, not the one holding focus.
  it("names the locked target's pane rather than the focused one", async () => {
    const { voiceRecordingService, voiceState } = await arrange();
    voiceState.lockedTarget = { panelId: "panel-2" };

    await voiceRecordingService.toggleFocusedPanel();

    expect(focusDictationComposer).toHaveBeenCalledTimes(1);
    expect(focusDictationComposer).toHaveBeenCalledWith("panel-2");
  });

  it("leaves the keyboard alone when the press stops the session", async () => {
    const { voiceRecordingService, voiceState, stopSpy } = await arrange();
    voiceState.status = "recording";
    voiceState.activeTarget = { panelId: "panel-1" };

    await voiceRecordingService.toggle({ panelId: "panel-1" });

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(focusDictationComposer).not.toHaveBeenCalled();
  });

  it("leaves the keyboard alone when the press stops a session from the key", async () => {
    const { voiceRecordingService, voiceState, stopSpy } = await arrange("push-to-talk");
    voiceState.status = "recording";
    voiceState.activeTarget = { panelId: "panel-1" };

    await voiceRecordingService.toggleFocusedPanel();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(focusDictationComposer).not.toHaveBeenCalled();
  });

  it("leaves the keyboard alone when the press cancels the arming window", async () => {
    const { voiceRecordingService, voiceState, startSpy } = await arrange();
    voiceState.status = "arming";
    voiceState.activeTarget = { panelId: "panel-1" };

    await voiceRecordingService.toggle({ panelId: "panel-1" });

    expect(startSpy).not.toHaveBeenCalled();
    expect(focusDictationComposer).not.toHaveBeenCalled();
  });
});

describe("VoiceRecordingService — arming state", () => {
  beforeEach(() => {
    vi.resetModules();
    suspendCallbacks.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("toggle() calls setArming() with the target before invoking start()", async () => {
    setupGlobals();

    const storeModule = (await import("@/store/voiceRecordingStore")) as unknown as {
      useVoiceRecordingStore: {
        getState: () => { setArming: ReturnType<typeof vi.fn> };
      };
    };
    const setArmingMock = storeModule.useVoiceRecordingStore.getState().setArming;

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const startSpy = vi
      .spyOn(voiceRecordingService, "start")
      .mockImplementation(async () => undefined);

    const target = { panelId: "panel-1", panelTitle: "Terminal" };
    await voiceRecordingService.toggle(target);

    expect(setArmingMock).toHaveBeenCalledWith(target);
    expect(startSpy).toHaveBeenCalledWith(target);
    // Ordering: setArming must run before start() so the synchronous cue
    // paints before any await yields control.
    expect(setArmingMock.mock.invocationCallOrder[0]).toBeLessThan(
      startSpy.mock.invocationCallOrder[0]!
    );
  });

  it("toggle() during arming on the same target aborts via finishSession (no stop())", async () => {
    setupGlobals();

    const storeModule = (await import("@/store/voiceRecordingStore")) as unknown as {
      useVoiceRecordingStore: {
        getState: () => { finishSession: ReturnType<typeof vi.fn> };
      };
      __state: { activeTarget: { panelId: string } | null; status: string };
    };
    storeModule.__state.activeTarget = { panelId: "panel-1" };
    storeModule.__state.status = "arming";
    const finishSessionMock = storeModule.useVoiceRecordingStore.getState().finishSession;

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi.spyOn(voiceRecordingService, "stop");
    const startSpy = vi.spyOn(voiceRecordingService, "start");

    await voiceRecordingService.toggle({ panelId: "panel-1" });

    expect(finishSessionMock).toHaveBeenCalledWith({ nextStatus: "idle" });
    expect(stopSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();

    storeModule.__state.activeTarget = null;
    storeModule.__state.status = "idle";
  });

  it("start() failure path clears arming so the store does not stay armed forever", async () => {
    // Issue #9178 — every start() early-return after setArming() must roll
    // the store off "arming", otherwise the toolbar/panel border keeps
    // showing the pre-recording cue with no mic behind it. This test
    // simulates the not-configured path.
    const electronStub = buildElectronStub();
    electronStub.voiceInput.getSettings.mockResolvedValue({
      enabled: false,
      openaiApiKey: "",
      correctionEnabled: false,
    });
    setupGlobals(electronStub);

    const storeModule = (await import("@/store/voiceRecordingStore")) as unknown as {
      useVoiceRecordingStore: {
        getState: () => {
          finishSession: ReturnType<typeof vi.fn>;
          setLastError: ReturnType<typeof vi.fn>;
        };
      };
    };
    const fns = storeModule.useVoiceRecordingStore.getState();
    const finishSessionMock = fns.finishSession;
    const setLastErrorMock = fns.setLastError;

    const { voiceRecordingService } = await import("../VoiceRecordingService");

    await voiceRecordingService.start({ panelId: "panel-1" });

    expect(setLastErrorMock).toHaveBeenCalled();
    // failArming() routes through finishSession with nextStatus:"error"
    expect(finishSessionMock).toHaveBeenCalledWith({ nextStatus: "error" });
  });

  it("cross-panel switch while recording tears down the existing session", async () => {
    // Regression guard. Before the fix, toggle() set arming on the new
    // target which masked the existing recording status — start()'s
    // teardown check skipped, leaving the old MediaStream open. The fix
    // keys teardown on this.stream rather than store status.
    setupGlobals();

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi
      .spyOn(voiceRecordingService, "stop")
      .mockImplementation(async () => undefined);

    // Simulate an open audio session by attaching a stream directly.
    // We use `as unknown as` to reach a private field for test setup only.
    const fakeStream = { getTracks: () => [{ stop: vi.fn() }] };
    (voiceRecordingService as unknown as { stream: unknown }).stream = fakeStream;

    await voiceRecordingService.start({ panelId: "panel-b" });

    // start() must call stop() to tear down the prior session even though
    // setArming() has by now overwritten store status from "recording" to
    // "arming". Before the fix this assertion failed.
    expect(stopSpy).toHaveBeenCalled();

    (voiceRecordingService as unknown as { stream: unknown }).stream = null;
  });

  it("Escape during arming routes through finishSession instead of stop()", async () => {
    setupGlobals();

    const storeModule = (await import("@/store/voiceRecordingStore")) as unknown as {
      useVoiceRecordingStore: {
        getState: () => { finishSession: ReturnType<typeof vi.fn> };
      };
      __state: { activeTarget: { panelId: string } | null; status: string };
    };
    storeModule.__state.activeTarget = { panelId: "panel-1" };
    storeModule.__state.status = "arming";
    const finishSessionMock = storeModule.useVoiceRecordingStore.getState().finishSession;

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi.spyOn(voiceRecordingService, "stop");

    voiceRecordingService.initialize();
    const { dispatchEscapeFallback } = await import("@/lib/escapeStack");

    expect(dispatchEscapeFallback()).toBe(true);

    expect(finishSessionMock).toHaveBeenCalledWith({ nextStatus: "idle" });
    expect(stopSpy).not.toHaveBeenCalled();

    storeModule.__state.activeTarget = null;
    storeModule.__state.status = "idle";
  });

  it("leaves a window Escape alone while recording so an open overlay can take it", async () => {
    const { windowListeners } = setupGlobals();

    const storeModule = (await import("@/store/voiceRecordingStore")) as unknown as {
      __state: { activeTarget: { panelId: string } | null; status: string };
    };
    storeModule.__state.activeTarget = { panelId: "panel-1" };
    storeModule.__state.status = "recording";

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi
      .spyOn(voiceRecordingService, "stop")
      .mockImplementation(async () => undefined);

    voiceRecordingService.initialize();

    const escapeEvent = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    for (const listener of windowListeners["keydown"] ?? []) {
      listener(escapeEvent);
    }

    expect(escapeEvent.stopPropagation).not.toHaveBeenCalled();
    expect(escapeEvent.preventDefault).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();

    storeModule.__state.activeTarget = null;
    storeModule.__state.status = "idle";
  });

  it("an Escape nothing else took cancels the dictation, where the dictation key stops it", async () => {
    setupGlobals();

    const storeModule = (await import("@/store/voiceRecordingStore")) as unknown as {
      useVoiceRecordingStore: {
        getState: () => {
          finishSession: ReturnType<typeof vi.fn>;
          announce: ReturnType<typeof vi.fn>;
        };
      };
      __state: { activeTarget: { panelId: string } | null; status: string };
    };
    storeModule.__state.activeTarget = { panelId: "panel-1" };
    storeModule.__state.status = "recording";
    const { finishSession, announce } = storeModule.useVoiceRecordingStore.getState();
    finishSession.mockClear();
    announce.mockClear();

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi
      .spyOn(voiceRecordingService, "stop")
      .mockImplementation(async () => undefined);

    voiceRecordingService.initialize();
    const { dispatchEscapeFallback } = await import("@/lib/escapeStack");

    await voiceRecordingService.toggle({ panelId: "panel-1" });
    expect(stopSpy).toHaveBeenCalledOnce();
    expect(stopSpy.mock.calls[0]![1]).toMatchObject({ preserveLiveText: true });

    expect(dispatchEscapeFallback()).toBe(true);

    expect(stopSpy).toHaveBeenCalledOnce();
    expect(stopSpy.mock.calls[0]![1]).toMatchObject({ reason: "user" });
    expect(finishSession).toHaveBeenCalledWith({ preserveLiveText: false });
    expect(announce).toHaveBeenCalledWith(expect.stringMatching(/cancelled.*discarded/i));

    storeModule.__state.activeTarget = null;
    storeModule.__state.status = "idle";
  });

  it("leaves Escape alone once the session is finishing", async () => {
    setupGlobals();

    const storeModule = (await import("@/store/voiceRecordingStore")) as unknown as {
      __state: { activeTarget: { panelId: string } | null; status: string };
    };
    storeModule.__state.activeTarget = { panelId: "panel-1" };
    storeModule.__state.status = "finishing";

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi
      .spyOn(voiceRecordingService, "stop")
      .mockImplementation(async () => undefined);

    voiceRecordingService.initialize();
    const { dispatchEscapeFallback } = await import("@/lib/escapeStack");

    expect(dispatchEscapeFallback()).toBe(false);
    expect(voiceRecordingService.handleEscape("panel-1")).toBe(false);
    expect(stopSpy).not.toHaveBeenCalled();

    storeModule.__state.activeTarget = null;
    storeModule.__state.status = "idle";
  });

  it.each(["connecting", "recording", "paused", "reconnecting"])(
    "takes a composer's Escape only from the panel it is dictating into (%s)",
    async (status) => {
      setupGlobals();

      const storeModule = (await import("@/store/voiceRecordingStore")) as unknown as {
        useVoiceRecordingStore: {
          getState: () => { finishSession: ReturnType<typeof vi.fn> };
        };
        __state: { activeTarget: { panelId: string } | null; status: string };
      };
      storeModule.__state.activeTarget = { panelId: "panel-1" };
      storeModule.__state.status = status;
      const { finishSession } = storeModule.useVoiceRecordingStore.getState();
      finishSession.mockClear();

      const { voiceRecordingService } = await import("../VoiceRecordingService");
      const stopSpy = vi.spyOn(voiceRecordingService, "stop");
      const teardownDone = () =>
        vi.waitFor(() => expect(Reflect.get(voiceRecordingService, "stopPromise")).toBeNull());

      expect(voiceRecordingService.handleEscape("panel-2")).toBe(false);
      expect(finishSession).not.toHaveBeenCalled();

      expect(voiceRecordingService.handleEscape("panel-1")).toBe(true);
      expect(finishSession).toHaveBeenCalledExactlyOnceWith({ preserveLiveText: false });
      await teardownDone();

      voiceRecordingService.initialize();
      const { dispatchEscapeFallback } = await import("@/lib/escapeStack");
      expect(dispatchEscapeFallback()).toBe(true);
      expect(finishSession).toHaveBeenCalledTimes(2);
      await teardownDone();
      expect(stopSpy).not.toHaveBeenCalled();

      storeModule.__state.activeTarget = null;
      storeModule.__state.status = "idle";
    }
  );
});

describe("VoiceRecordingService — microphone device selection", () => {
  beforeEach(() => {
    vi.resetModules();
    suspendCallbacks.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("passes audio: true when selectedDeviceId is empty", async () => {
    setupGlobals();

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    voiceRecordingService.initialize();

    // Default electron stub returns getSettings without deviceId,
    // so selectedDeviceId stays "".
    const getUserMediaSpy = vi.mocked(navigator.mediaDevices.getUserMedia);

    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Test" });

    expect(getUserMediaSpy).toHaveBeenCalledWith({ audio: true, video: false });
  });

  it("passes ideal deviceId constraint when selectedDeviceId is set", async () => {
    const electron = buildElectronStub();
    electron.voiceInput.getSettings.mockResolvedValue({
      enabled: true,
      openaiApiKey: "sk-key",
      correctionEnabled: false,
      deviceId: "preferred-mic-id",
    });

    setupGlobals(electron);

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    voiceRecordingService.initialize();

    // refreshConfiguration runs async; wait it out.
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    const getUserMediaSpy = vi.mocked(navigator.mediaDevices.getUserMedia);

    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Test" });

    expect(getUserMediaSpy).toHaveBeenCalledWith({
      audio: { deviceId: { ideal: "preferred-mic-id" } },
      video: false,
    });
  });

  it("logs mismatch when actual deviceId differs from requested", async () => {
    const electron = buildElectronStub();
    electron.voiceInput.getSettings.mockResolvedValue({
      enabled: true,
      openaiApiKey: "sk-key",
      correctionEnabled: false,
      deviceId: "preferred-mic-id",
    });

    setupGlobals(electron);

    // Override getUserMedia to return a track with a different deviceId
    const getUserMediaMock = vi.mocked(navigator.mediaDevices.getUserMedia);
    getUserMediaMock.mockResolvedValue(
      fakeStream({
        getTracks: () => [{ stop: vi.fn() }],
        getAudioTracks: () => [
          {
            label: "Other Mic",
            enabled: true,
            muted: false,
            readyState: "live",
            getSettings: () => ({ deviceId: "different-mic-id" }),
          },
        ],
      })
    );

    const { logWarn } = await import("@/utils/logger");

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    voiceRecordingService.initialize();

    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Test" });

    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("Microphone device mismatch"),
      expect.objectContaining({
        requested: "preferred-mic-id",
        actual: "different-mic-id",
      })
    );
  });
});

describe("VoiceRecordingService — assistant dictation routing (#8887)", () => {
  beforeEach(() => {
    vi.resetModules();
    suspendCallbacks.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function importMocks() {
    const macro = (await import("@/store/macroFocusStore")) as unknown as {
      isAssistantFocused: ReturnType<typeof vi.fn>;
    };
    const help = (await import("@/store/helpPanelStore")) as unknown as {
      __state: { isOpen: boolean; terminalId: string | null };
      __fns: { setOpen: ReturnType<typeof vi.fn>; requestFocus: ReturnType<typeof vi.fn> };
    };
    const panel = (await import("@/store/panelStore")) as unknown as {
      __state: { focusedId: string | null; panelsById: Record<string, unknown> };
    };
    // The mock factories run once, so __state and the vi.fn() handlers are
    // singletons shared across tests — reset them to a clean baseline here.
    macro.isAssistantFocused.mockReset();
    macro.isAssistantFocused.mockReturnValue(false);
    help.__fns.setOpen.mockClear();
    help.__fns.requestFocus.mockClear();
    help.__state.isOpen = false;
    help.__state.terminalId = null;
    panel.__state.focusedId = null;
    panel.__state.panelsById = {};
    const voice = (await import("@/store/voiceRecordingStore")) as unknown as {
      useVoiceRecordingStore: {
        getState: () => {
          setLastError: ReturnType<typeof vi.fn>;
          announce: ReturnType<typeof vi.fn>;
        };
      };
    };
    voice.useVoiceRecordingStore.getState().setLastError.mockClear();
    voice.useVoiceRecordingStore.getState().announce.mockClear();
    return { macro, help, panel };
  }

  it("routes the dictation shortcut to the assistant terminal when the assistant is focused", async () => {
    setupGlobals();
    const { macro, help, panel } = await importMocks();
    macro.isAssistantFocused.mockReturnValue(true);
    help.__state.terminalId = "assistant-term-1";
    panel.__state.panelsById = {
      "assistant-term-1": { id: "assistant-term-1", location: "background" },
    };
    // A grid terminal is the last-focused panel — it must NOT win.
    panel.__state.focusedId = "grid-panel-9";

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();

    await voiceRecordingService.toggleFocusedPanel();

    expect(toggleSpy).toHaveBeenCalledTimes(1);
    expect(toggleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        panelId: "assistant-term-1",
        panelTitle: "Daintree Assistant",
      })
    );
  });

  it("shows a toast when the assistant is focused but has no terminal yet", async () => {
    setupGlobals();
    const { macro, help } = await importMocks();
    macro.isAssistantFocused.mockReturnValue(true);
    help.__state.terminalId = null;

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();
    const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");

    await voiceRecordingService.toggleFocusedPanel();

    expect(toggleSpy).not.toHaveBeenCalled();
    expect(useVoiceRecordingStore.getState().setLastError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("starting") })
    );
  });

  it.each([
    ["a plain shell", { id: "p1", kind: "terminal", title: "zsh", location: "grid" }],
    ["a browser panel", { id: "p1", kind: "browser", title: "Web", location: "grid" }],
  ])("refuses to start dictation in %s and says to focus an agent terminal", async (_n, entry) => {
    setupGlobals();
    const { macro, panel } = await importMocks();
    macro.isAssistantFocused.mockReturnValue(false);
    panel.__state.focusedId = "p1";
    panel.__state.panelsById = { p1: entry };

    const { notify } = await import("@/lib/notify");
    vi.mocked(notify).mockClear();
    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();

    await voiceRecordingService.toggleFocusedPanel();

    expect(toggleSpy).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notify).mock.calls[0]![0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("agent terminal"),
    });
  });

  it("never aims dictation at a focused pane held for recovery (#12434)", async () => {
    setupGlobals();
    const { macro, panel } = await importMocks();
    macro.isAssistantFocused.mockReturnValue(false);
    panel.__state.focusedId = "held-1";
    panel.__state.panelsById = {
      "held-1": {
        id: "held-1",
        kind: "terminal",
        title: "Codex",
        location: "grid",
        restoreRecovery: { reason: "session-unresolved" },
      },
    };

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();

    await voiceRecordingService.toggleFocusedPanel();

    expect(toggleSpy).not.toHaveBeenCalled();
  });

  it("toggleAssistant opens the assistant and toasts when no terminal exists", async () => {
    setupGlobals();
    const { help } = await importMocks();
    help.__state.isOpen = false;
    help.__state.terminalId = null;

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();
    const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");

    await voiceRecordingService.toggleAssistant();

    expect(help.__fns.setOpen).toHaveBeenCalledWith(true);
    expect(help.__fns.requestFocus).toHaveBeenCalled();
    expect(toggleSpy).not.toHaveBeenCalled();
    expect(useVoiceRecordingStore.getState().setLastError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Start the Daintree Assistant") })
    );
  });

  it("falls back to the focused grid panel even when an assistant terminal exists but is unfocused", async () => {
    setupGlobals();
    const { macro, help, panel } = await importMocks();
    macro.isAssistantFocused.mockReturnValue(false);
    // An assistant terminal exists, but focus is in the grid — the grid wins.
    help.__state.terminalId = "assistant-term-1";
    panel.__state.focusedId = "grid-panel-9";
    panel.__state.panelsById = {
      "assistant-term-1": { id: "assistant-term-1", location: "background" },
      "grid-panel-9": {
        id: "grid-panel-9",
        title: "Terminal",
        location: "grid",
        launchAgentId: "claude",
      },
    };

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();

    await voiceRecordingService.toggleFocusedPanel();

    expect(toggleSpy).toHaveBeenCalledTimes(1);
    expect(toggleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ panelId: "grid-panel-9", panelTitle: "Terminal" })
    );
  });

  it("toggleAssistant routes to the assistant terminal regardless of grid focus", async () => {
    setupGlobals();
    const { help, panel } = await importMocks();
    help.__state.isOpen = true;
    help.__state.terminalId = "assistant-term-1";
    panel.__state.focusedId = "grid-panel-9";
    panel.__state.panelsById = {
      "assistant-term-1": { id: "assistant-term-1", location: "background" },
    };

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();
    const focusSpy = vi.spyOn(voiceRecordingService, "focusActiveTarget");

    await voiceRecordingService.toggleAssistant();

    expect(toggleSpy).toHaveBeenCalledTimes(1);
    expect(toggleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        panelId: "assistant-term-1",
        panelTitle: "Daintree Assistant",
      })
    );
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("toggleAssistant does not re-open or re-focus when the assistant is already open", async () => {
    setupGlobals();
    const { help, panel } = await importMocks();
    help.__state.isOpen = true;
    help.__state.terminalId = "assistant-term-1";
    panel.__state.panelsById = {
      "assistant-term-1": { id: "assistant-term-1", location: "background" },
    };

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();

    await voiceRecordingService.toggleAssistant();

    expect(help.__fns.setOpen).not.toHaveBeenCalled();
    expect(help.__fns.requestFocus).not.toHaveBeenCalled();
    expect(toggleSpy).toHaveBeenCalledTimes(1);
  });

  it("toggleAssistant toasts instead of dictating into a trashed assistant terminal", async () => {
    setupGlobals();
    const { help, panel } = await importMocks();
    help.__state.isOpen = true;
    help.__state.terminalId = "assistant-term-1";
    // The terminal id is still set, but the panel has been sent to trash.
    panel.__state.panelsById = {
      "assistant-term-1": { id: "assistant-term-1", location: "trash" },
    };

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();
    const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");

    await voiceRecordingService.toggleAssistant();

    expect(toggleSpy).not.toHaveBeenCalled();
    expect(useVoiceRecordingStore.getState().setLastError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Start the Daintree Assistant") })
    );
  });
});

describe("VoiceRecordingService — Canopy's reply box (#14777)", () => {
  beforeEach(() => {
    vi.resetModules();
    suspendCallbacks.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const REPLY = {
    panelId: "isolated-composer:run-1",
    panelTitle: "Reply to Claude",
    surface: "canopy-reply" as const,
    terminalId: "run-1",
  };

  type VoiceState = {
    status: string;
    activeTarget: object | null;
    pendingTarget: object | null;
    lockedTarget: object | null;
  };

  function hasMockExport<K extends string, T>(mod: object, key: K): mod is Record<K, T> {
    return key in mod;
  }

  async function canopyState() {
    const canopy = await import("@/store/canopyStore");
    if (!hasMockExport<"__state", { isOpen: boolean }>(canopy, "__state")) {
      throw new Error("canopyStore mock lacks __state");
    }
    return canopy.__state;
  }

  async function arrange() {
    setupGlobals();
    const panel = await import("@/store/panelStore");
    if (
      !hasMockExport<"__state", { focusedId: string | null; panelsById: Record<string, unknown> }>(
        panel,
        "__state"
      )
    ) {
      throw new Error("panelStore mock lacks __state");
    }
    panel.__state.focusedId = "grid-1";
    panel.__state.panelsById = {
      "grid-1": { id: "grid-1", title: "Behind", location: "grid", launchAgentId: "claude" },
    };
    (await canopyState()).isOpen = true;
    const voice = await import("@/store/voiceRecordingStore");
    if (!hasMockExport<"__state", VoiceState>(voice, "__state")) {
      throw new Error("voiceRecordingStore mock lacks __state");
    }
    voice.__state.status = "idle";
    voice.__state.activeTarget = null;
    voice.__state.pendingTarget = null;
    voice.__state.lockedTarget = null;
    vi.mocked(voice.useVoiceRecordingStore.getState().announce).mockClear();
    const { notify } = await import("@/lib/notify");
    vi.mocked(notify).mockClear();
    const registry = await import("@/services/canopyReplyDictation");
    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();
    const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();
    return { voiceRecordingService, toggleSpy, stopSpy, registry, panel, voice, notify };
  }

  afterEach(async () => {
    (await canopyState()).isOpen = false;
  });

  it("starts the selected row's reply and moves the keyboard into it, not the grid pane behind", async () => {
    const { voiceRecordingService, toggleSpy, registry } = await arrange();
    const focus = vi.fn();
    registry.registerCanopyReplyDictation(() => ({ ok: true, target: REPLY, focus }));

    await voiceRecordingService.toggleFocusedPanel();

    expect(toggleSpy).toHaveBeenCalledTimes(1);
    expect(toggleSpy).toHaveBeenCalledWith(REPLY);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("goes to the reply ahead of a lock on a grid pane, and leaves the lock in place", async () => {
    const { voiceRecordingService, toggleSpy, registry, voice } = await arrange();
    voice.__state.lockedTarget = { panelId: "grid-1" };
    registry.registerCanopyReplyDictation(() => ({ ok: true, target: REPLY, focus: () => {} }));

    await voiceRecordingService.toggleFocusedPanel();

    expect(toggleSpy).toHaveBeenCalledWith(REPLY);
    expect(voice.__state.lockedTarget).toEqual({ panelId: "grid-1" });
  });

  it("says why when the selected row can't take a reply, and starts nothing", async () => {
    const { voiceRecordingService, toggleSpy, registry, voice, notify } = await arrange();
    const message = "It's asking for a secret. Type it straight into the terminal above.";
    registry.registerCanopyReplyDictation(() => ({ ok: false, message }));

    await voiceRecordingService.toggleFocusedPanel();

    expect(toggleSpy).not.toHaveBeenCalled();
    expect(voice.useVoiceRecordingStore.getState().announce).toHaveBeenCalledWith(message);
    expect(vi.mocked(notify).mock.calls[0]![0]).toMatchObject({ message });
  });

  it("never falls back to the grid while Canopy has no inbox showing", async () => {
    const { voiceRecordingService, toggleSpy, notify } = await arrange();

    await voiceRecordingService.toggleFocusedPanel();

    expect(toggleSpy).not.toHaveBeenCalled();
    expect(vi.mocked(notify).mock.calls[0]![0]).toMatchObject({
      message: expect.stringContaining("Select an agent in Canopy"),
    });
  });

  it("still stops a running session first, wherever it is, and starts no reply", async () => {
    const { voiceRecordingService, toggleSpy, stopSpy, registry, voice } = await arrange();
    voice.__state.status = "recording";
    voice.__state.activeTarget = { panelId: "grid-1" };
    const focus = vi.fn();
    registry.registerCanopyReplyDictation(() => ({ ok: true, target: REPLY, focus }));

    await voiceRecordingService.toggleFocusedPanel();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(toggleSpy).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("brings a reply's session forward only while its row is still selected", async () => {
    const { voiceRecordingService, registry, voice } = await arrange();
    const projects = await import("@/store/projectStore");
    if (!hasMockExport<"__switchProject", Mock>(projects, "__switchProject")) {
      throw new Error("projectStore mock lacks __switchProject");
    }
    projects.__switchProject.mockClear();
    voice.__state.status = "recording";
    voice.__state.activeTarget = REPLY;
    const focus = vi.fn();
    const unregister = registry.registerCanopyReplyDictation(() => ({
      ok: true,
      target: REPLY,
      focus,
    }));

    await expect(voiceRecordingService.focusActiveTarget()).resolves.toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);

    unregister();
    registry.registerCanopyReplyDictation(() => ({
      ok: true,
      target: { ...REPLY, panelId: "isolated-composer:run-2" },
      focus,
    }));
    await expect(voiceRecordingService.focusActiveTarget()).resolves.toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(projects.__switchProject).not.toHaveBeenCalled();
  });

  it("keeps a reply's session going when the grid's panels change", async () => {
    const { voiceRecordingService, stopSpy, panel, voice } = await arrange();
    voiceRecordingService.initialize();
    voice.__state.status = "recording";
    voice.__state.activeTarget = REPLY;
    const listeners = vi.mocked(panel.usePanelStore.subscribe).mock.calls.map((call) => call[0]);
    expect(listeners.length).toBeGreaterThan(0);

    const emptied = { ...panel.usePanelStore.getState(), panelsById: {}, panelIds: [] };
    for (const listener of listeners) listener(emptied);

    expect(stopSpy).not.toHaveBeenCalled();
  });
});

describe("VoiceRecordingService — shortcut stops from anywhere (#12832)", () => {
  beforeEach(() => {
    vi.resetModules();
    suspendCallbacks.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  type VoiceState = {
    status: string;
    activeTarget: { panelId: string } | null;
    pendingTarget: { panelId: string } | null;
    lockedTarget: { panelId: string } | null;
  };
  type PanelState = { focusedId: string | null; panelsById: Record<string, unknown> };

  function hasMockState<T>(mod: object): mod is { __state: T } {
    return "__state" in mod;
  }

  async function arrange(options: {
    status: string;
    activeTarget?: { panelId: string } | null;
    pendingTarget?: { panelId: string } | null;
    recordingMode?: "toggle" | "push-to-talk";
  }) {
    const electron = buildElectronStub();
    electron.voiceInput.getSettings.mockResolvedValue({
      enabled: true,
      openaiApiKey: "sk-key",
      correctionEnabled: false,
      recordingMode: options.recordingMode ?? "toggle",
    });
    const { windowListeners } = setupGlobals(electron);

    const panel = await import("@/store/panelStore");
    if (!hasMockState<PanelState>(panel)) throw new Error("panelStore mock lacks __state");
    panel.__state.focusedId = "panel-b";
    panel.__state.panelsById = {
      "panel-a": { id: "panel-a", title: "Recording", location: "grid", launchAgentId: "claude" },
      "panel-b": { id: "panel-b", title: "Focused", location: "grid", launchAgentId: "claude" },
    };

    const voiceModule = await import("@/store/voiceRecordingStore");
    if (!hasMockState<VoiceState>(voiceModule)) {
      throw new Error("voiceRecordingStore mock lacks __state");
    }
    const voiceState = voiceModule.__state;
    voiceState.status = options.status;
    voiceState.activeTarget =
      options.activeTarget === undefined ? { panelId: "panel-a" } : options.activeTarget;
    voiceState.pendingTarget = options.pendingTarget ?? null;
    voiceState.lockedTarget = null;
    const finishSession = vi.mocked(voiceModule.useVoiceRecordingStore.getState().finishSession);
    finishSession.mockClear();

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    voiceRecordingService.initialize();
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();
    const startSpy = vi.spyOn(voiceRecordingService, "start").mockResolvedValue();
    const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();
    return {
      voiceRecordingService,
      voiceState,
      panelState: panel.__state,
      windowListeners,
      finishSession,
      stopSpy,
      startSpy,
      toggleSpy,
    };
  }

  for (const status of ["connecting", "recording", "paused", "reconnecting"]) {
    it(`stops a ${status} session on another panel instead of retargeting to focus`, async () => {
      const { voiceRecordingService, stopSpy, startSpy, toggleSpy } = await arrange({ status });

      await voiceRecordingService.toggleFocusedPanel();

      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(stopSpy).toHaveBeenCalledWith("Dictation stopped.", {
        preserveLiveText: true,
        reason: "user",
      });
      expect(startSpy).not.toHaveBeenCalled();
      expect(toggleSpy).not.toHaveBeenCalled();
    });
  }

  // #14604: the finishing session is already ending, so the press is the next
  // session's start rather than a stop that joins the drain.
  it("starts the next session in the focused panel while another is finishing", async () => {
    const { voiceRecordingService, stopSpy, toggleSpy } = await arrange({ status: "finishing" });

    await voiceRecordingService.toggleFocusedPanel();

    expect(stopSpy).not.toHaveBeenCalled();
    expect(toggleSpy).toHaveBeenCalledWith(expect.objectContaining({ panelId: "panel-b" }));
  });

  it("aborts the arming window from a different panel without opening the mic", async () => {
    const { voiceRecordingService, finishSession, stopSpy, startSpy, toggleSpy } = await arrange({
      status: "arming",
    });

    await voiceRecordingService.toggleFocusedPanel();

    expect(finishSession).toHaveBeenCalledWith({
      nextStatus: "idle",
    });
    expect(stopSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    expect(toggleSpy).not.toHaveBeenCalled();
  });

  it("stops a session that is still recording elsewhere even when dictation is locked", async () => {
    const { voiceRecordingService, voiceState, stopSpy, toggleSpy } = await arrange({
      status: "recording",
    });
    voiceState.lockedTarget = { panelId: "panel-b" };

    await voiceRecordingService.toggleFocusedPanel();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(toggleSpy).not.toHaveBeenCalled();
  });

  it("stops the session when the assistant owns focus", async () => {
    const macro = await import("@/store/macroFocusStore");
    const isAssistantFocused = vi.mocked(macro.isAssistantFocused);
    isAssistantFocused.mockReturnValue(true);
    const { voiceRecordingService, stopSpy, toggleSpy } = await arrange({ status: "recording" });

    await voiceRecordingService.toggleFocusedPanel();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(toggleSpy).not.toHaveBeenCalled();
    isAssistantFocused.mockReturnValue(false);
  });

  it("stops rather than starts in push-to-talk mode when a session runs elsewhere", async () => {
    const { voiceRecordingService, stopSpy, startSpy } = await arrange({
      status: "recording",
      recordingMode: "push-to-talk",
    });

    await voiceRecordingService.toggleFocusedPanel();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("starts in the focused panel when idle", async () => {
    const { voiceRecordingService, stopSpy, toggleSpy } = await arrange({
      status: "idle",
      activeTarget: null,
    });

    await voiceRecordingService.toggleFocusedPanel();

    expect(stopSpy).not.toHaveBeenCalled();
    expect(toggleSpy).toHaveBeenCalledWith(expect.objectContaining({ panelId: "panel-b" }));
  });

  it("reads focus at the moment of the press when starting from idle", async () => {
    const { voiceRecordingService, panelState, toggleSpy } = await arrange({
      status: "idle",
      activeTarget: null,
    });

    const pending = voiceRecordingService.toggleFocusedPanel();
    panelState.focusedId = "panel-a";
    await pending;

    expect(toggleSpy).toHaveBeenCalledWith(expect.objectContaining({ panelId: "panel-b" }));
  });

  it("does not send a stop on push-to-talk keyup after the press aborted arming", async () => {
    const { voiceRecordingService, windowListeners, stopSpy } = await arrange({
      status: "arming",
      recordingMode: "push-to-talk",
    });
    const { keybindingService } = await import("@/services/KeybindingService");
    vi.mocked(keybindingService.matchesEvent).mockReturnValue(true);

    const down = { code: "Period", key: ".", repeat: false, metaKey: true };
    for (const listener of windowListeners["keydown"] ?? []) listener(down);
    await voiceRecordingService.toggleFocusedPanel();
    for (const listener of windowListeners["keyup"] ?? []) listener({ code: "Period" });

    expect(stopSpy).not.toHaveBeenCalled();
    vi.mocked(keybindingService.matchesEvent).mockReset();
  });

  it("cancels a pending start before its capture attaches without touching the finishing session", async () => {
    const { voiceRecordingService, voiceState, finishSession, stopSpy, toggleSpy } = await arrange({
      status: "finishing",
      pendingTarget: { panelId: "panel-c" },
    });
    const before: unknown = Reflect.get(voiceRecordingService, "startRequestId");

    await voiceRecordingService.toggleFocusedPanel();

    expect(Reflect.get(voiceRecordingService, "startRequestId")).not.toBe(before);
    expect(voiceState.pendingTarget).toBeNull();
    expect(voiceState.activeTarget).toEqual({ panelId: "panel-a" });
    expect(finishSession).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(toggleSpy).not.toHaveBeenCalled();
  });

  it("cancels a pending start when an explicit stop joins a drain already in flight", async () => {
    const { voiceRecordingService, voiceState, stopSpy } = await arrange({
      status: "finishing",
      pendingTarget: { panelId: "panel-c" },
    });
    stopSpy.mockRestore();
    let releaseDrain: () => void = () => {};
    Reflect.set(
      voiceRecordingService,
      "stopPromise",
      new Promise<void>((resolve) => {
        releaseDrain = resolve;
      })
    );
    const before: unknown = Reflect.get(voiceRecordingService, "startRequestId");
    let joined = false;

    const stopping = voiceRecordingService.stop("Dictation cancelled.").then(() => {
      joined = true;
    });

    expect(Reflect.get(voiceRecordingService, "startRequestId")).not.toBe(before);
    expect(voiceState.pendingTarget).toBeNull();
    await Promise.resolve();
    expect(joined).toBe(false);
    releaseDrain();
    await stopping;
    expect(joined).toBe(true);
  });

  it("leaves explicit toggle(target) retargeting intact for panel mic buttons", async () => {
    const { voiceRecordingService, stopSpy, startSpy, toggleSpy } = await arrange({
      status: "recording",
    });
    toggleSpy.mockRestore();

    await voiceRecordingService.toggle({ panelId: "panel-b" });

    expect(stopSpy).not.toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalledWith({ panelId: "panel-b" });
  });
});

describe("VoiceRecordingService — pause/resume (#9191)", () => {
  beforeEach(() => {
    vi.resetModules();
    suspendCallbacks.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function getVoiceMockState() {
    const mod = (await import("@/store/voiceRecordingStore")) as unknown as {
      __state: { activeTarget: { panelId: string } | null; status: string; micSignal: string };
    };
    return mod.__state;
  }

  // The voiceRecordingStore mock factory runs once per file, so vi.fn instances
  // are shared across tests in this block — reset them so each test asserts
  // against a clean call history.
  async function resetVoiceStoreFns() {
    const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
    const fns = useVoiceRecordingStore.getState();
    (fns.setStatus as ReturnType<typeof vi.fn>).mockClear();
    (fns.announce as ReturnType<typeof vi.fn>).mockClear();
    (fns.beginSession as ReturnType<typeof vi.fn>).mockClear();
    (fns.finishSession as ReturnType<typeof vi.fn>).mockClear();
  }

  it("pause() suspends the PCM worklet and sets status to paused", async () => {
    const { workletNodes } = setupGlobals();
    await resetVoiceStoreFns();
    const voiceState = await getVoiceMockState();
    voiceState.activeTarget = { panelId: "panel-1" };
    voiceState.status = "recording";

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Test" });

    voiceRecordingService.pause();

    expect(workletNodes.length).toBeGreaterThan(0);
    const node = workletNodes[workletNodes.length - 1]!;
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: "setPaused", value: true });
    const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
    expect(useVoiceRecordingStore.getState().setStatus).toHaveBeenCalledWith("paused");
    expect(useVoiceRecordingStore.getState().announce).toHaveBeenCalledWith("Dictation paused.");
  });

  it("pause() is a no-op when status is not recording", async () => {
    const { workletNodes } = setupGlobals();
    await resetVoiceStoreFns();
    const voiceState = await getVoiceMockState();
    voiceState.activeTarget = { panelId: "panel-1" };
    voiceState.status = "connecting";

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Test" });

    // Reset post-start calls so we only see post-pause behaviour.
    const node = workletNodes[workletNodes.length - 1]!;
    node.port.postMessage.mockClear();
    const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
    (useVoiceRecordingStore.getState().setStatus as ReturnType<typeof vi.fn>).mockClear();

    voiceRecordingService.pause();

    expect(node.port.postMessage).not.toHaveBeenCalled();
    expect(useVoiceRecordingStore.getState().setStatus).not.toHaveBeenCalled();
  });

  it("resume() ungates the PCM worklet and sets status back to recording", async () => {
    const { workletNodes } = setupGlobals();
    await resetVoiceStoreFns();
    const voiceState = await getVoiceMockState();
    voiceState.activeTarget = { panelId: "panel-1" };
    voiceState.status = "paused";
    voiceState.micSignal = "live";

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Test" });

    const node = workletNodes[workletNodes.length - 1]!;
    node.port.postMessage.mockClear();
    const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
    (useVoiceRecordingStore.getState().setStatus as ReturnType<typeof vi.fn>).mockClear();

    voiceRecordingService.resume();

    expect(node.port.postMessage).toHaveBeenCalledWith({ type: "setPaused", value: false });
    expect(useVoiceRecordingStore.getState().setStatus).toHaveBeenCalledWith("recording");
    expect(useVoiceRecordingStore.getState().announce).toHaveBeenCalledWith("Dictation resumed.");
  });

  it("resume() before the mic went live defers the announcement to real audio (#13105)", async () => {
    setupGlobals();
    await resetVoiceStoreFns();
    const voiceState = await getVoiceMockState();
    voiceState.activeTarget = { panelId: "panel-1" };
    voiceState.status = "paused";
    voiceState.micSignal = "pending";

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Test" });
    const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
    vi.mocked(useVoiceRecordingStore.getState().announce).mockClear();

    voiceRecordingService.resume();

    expect(useVoiceRecordingStore.getState().setStatus).toHaveBeenCalledWith("recording");
    expect(useVoiceRecordingStore.getState().announce).not.toHaveBeenCalledWith(
      "Dictation resumed."
    );
    voiceRecordingService.destroy();
  });

  it("resume() is a no-op when status is not paused", async () => {
    const { workletNodes } = setupGlobals();
    await resetVoiceStoreFns();
    const voiceState = await getVoiceMockState();
    voiceState.activeTarget = { panelId: "panel-1" };
    voiceState.status = "recording";

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Test" });

    const node = workletNodes[workletNodes.length - 1]!;
    node.port.postMessage.mockClear();
    const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
    (useVoiceRecordingStore.getState().setStatus as ReturnType<typeof vi.fn>).mockClear();

    voiceRecordingService.resume();

    expect(node.port.postMessage).not.toHaveBeenCalled();
    expect(useVoiceRecordingStore.getState().setStatus).not.toHaveBeenCalled();
  });

  it("togglePause() dispatches to pause when recording and resume when paused", async () => {
    const { workletNodes } = setupGlobals();
    await resetVoiceStoreFns();
    const voiceState = await getVoiceMockState();
    voiceState.activeTarget = { panelId: "panel-1" };
    voiceState.status = "recording";

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Test" });

    const node = workletNodes[workletNodes.length - 1]!;
    node.port.postMessage.mockClear();

    voiceRecordingService.togglePause();
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: "setPaused", value: true });

    voiceState.status = "paused";
    node.port.postMessage.mockClear();
    voiceRecordingService.togglePause();
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: "setPaused", value: false });
  });

  it("togglePause() is a no-op when status is idle", async () => {
    setupGlobals();
    await resetVoiceStoreFns();
    const voiceState = await getVoiceMockState();
    voiceState.activeTarget = null;
    voiceState.status = "idle";

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
    voiceRecordingService.togglePause();
    expect(useVoiceRecordingStore.getState().setStatus).not.toHaveBeenCalled();
  });
});

describe("VoiceRecordingService — interim delta handling (#9172)", () => {
  beforeEach(() => {
    vi.resetModules();
    suspendCallbacks.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not write to the draft store or bump the voice revision on interim deltas", async () => {
    const { electronStub } = setupGlobals();
    let deltaCallback: ((payload: { text: string }) => void) | null = null;
    // Cast through unknown because the stub's vi.fn is initialised with a
    // zero-arg shape; the real handler takes a (payload)=>void.
    (
      electronStub.voiceInput.onTranscriptionDelta as unknown as {
        mockImplementation: (impl: (cb: (payload: { text: string }) => void) => () => void) => void;
      }
    ).mockImplementation((cb) => {
      deltaCallback = cb;
      return () => {};
    });

    const __state = await voiceStoreState();
    __state.activeTarget = { panelId: "panel-1" };

    const { useTerminalInputStore } = await import("@/store/terminalInputStore");
    const inputStore = useTerminalInputStore.getState();

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    voiceRecordingService.initialize();

    expect(deltaCallback).not.toBeNull();
    deltaCallback!({ text: "hello" });
    deltaCallback!({ text: " world" });
    deltaCallback!({ text: " again" });

    // The interim path must not mutate the draft store — that's the entire fix.
    expect(inputStore.setDraftInput).not.toHaveBeenCalled();
    expect(inputStore.bumpExternalDraftRevision).not.toHaveBeenCalled();

    __state.activeTarget = null;
  });

  it("commits exactly one draft write per onTranscriptionComplete (one undo step)", async () => {
    const { electronStub } = setupGlobals();
    let deltaCallback: ((payload: { text: string }) => void) | null = null;
    let completeCallback: ((payload: { text: string }) => void) | null = null;
    (
      electronStub.voiceInput.onTranscriptionDelta as unknown as {
        mockImplementation: (impl: (cb: (payload: { text: string }) => void) => () => void) => void;
      }
    ).mockImplementation((cb) => {
      deltaCallback = cb;
      return () => {};
    });
    (
      electronStub.voiceInput.onTranscriptionComplete as unknown as {
        mockImplementation: (impl: (cb: (payload: { text: string }) => void) => () => void) => void;
      }
    ).mockImplementation((cb) => {
      completeCallback = cb;
      return () => {};
    });

    const voiceModule = (await import("@/store/voiceRecordingStore")) as unknown as {
      __state: {
        activeTarget: { panelId: string } | null;
        panelBuffers: Record<string, { insertPoint: number }>;
      };
    };
    voiceModule.__state.activeTarget = { panelId: "panel-1" };

    const { useTerminalInputStore } = await import("@/store/terminalInputStore");
    const inputStore = useTerminalInputStore.getState();
    (inputStore.getDraftInput as ReturnType<typeof vi.fn>).mockReturnValue("existing");

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    voiceRecordingService.initialize();

    // Five interim deltas — none should commit to the draft.
    deltaCallback!({ text: "hel" });
    deltaCallback!({ text: "lo" });
    deltaCallback!({ text: " wor" });
    deltaCallback!({ text: "ld" });
    deltaCallback!({ text: "!" });

    // Simulate insertPoint being captured by the first delta. The test stub
    // for setInsertPoint is a no-op, so seed the buffer manually.
    voiceModule.__state.panelBuffers["panel-1"] = { insertPoint: 8 };

    // Single completion event — exactly one write, one revision bump.
    completeCallback!({ text: "hello world!" });

    expect(inputStore.setDraftInput).toHaveBeenCalledTimes(1);
    expect(inputStore.bumpExternalDraftRevision).toHaveBeenCalledTimes(1);

    voiceModule.__state.activeTarget = null;
    voiceModule.__state.panelBuffers = {};
  });

  it("does not write a separator-only draft on a silent (empty) onTranscriptionComplete", async () => {
    const { electronStub } = setupGlobals();
    let completeCallback: ((payload: { text: string }) => void) | null = null;
    (
      electronStub.voiceInput.onTranscriptionComplete as unknown as {
        mockImplementation: (impl: (cb: (payload: { text: string }) => void) => () => void) => void;
      }
    ).mockImplementation((cb) => {
      completeCallback = cb;
      return () => {};
    });

    const voiceModule = (await import("@/store/voiceRecordingStore")) as unknown as {
      __state: {
        activeTarget: { panelId: string } | null;
        panelBuffers: Record<string, { insertPoint: number }>;
      };
    };
    voiceModule.__state.activeTarget = { panelId: "panel-1" };
    voiceModule.__state.panelBuffers["panel-1"] = { insertPoint: 5 };

    const { useTerminalInputStore } = await import("@/store/terminalInputStore");
    const inputStore = useTerminalInputStore.getState();
    (inputStore.getDraftInput as ReturnType<typeof vi.fn>).mockReturnValue("hello");

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    voiceRecordingService.initialize();

    // Defeat any cross-test fn-instance reuse (Vitest may keep top-level
    // mock factory closures across re-imports).
    (inputStore.setDraftInput as ReturnType<typeof vi.fn>).mockClear();
    (inputStore.bumpExternalDraftRevision as ReturnType<typeof vi.fn>).mockClear();

    completeCallback!({ text: "   " });

    expect(inputStore.setDraftInput).not.toHaveBeenCalled();
    expect(inputStore.bumpExternalDraftRevision).not.toHaveBeenCalled();

    voiceModule.__state.activeTarget = null;
    voiceModule.__state.panelBuffers = {};
  });
});

describe("VoiceRecordingService — provider configuration gating", () => {
  beforeEach(() => {
    vi.resetModules();
    suspendCallbacks.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("treats a Deepgram-only user (no OpenAI key) as configured", async () => {
    const electron = buildElectronStub();
    electron.voiceInput.getSettings.mockResolvedValue({
      enabled: true,
      openaiApiKey: "",
      deepgramApiKey: "dg-test",
      transcriptionProvider: "deepgram",
      correctionEnabled: false,
    });
    setupGlobals(electron);

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await expect(voiceRecordingService.refreshConfiguration()).resolves.toBe(true);
  });

  it("treats a Deepgram user without a Deepgram key as not configured", async () => {
    const electron = buildElectronStub();
    electron.voiceInput.getSettings.mockResolvedValue({
      enabled: true,
      // An OpenAI key must NOT satisfy the Deepgram provider.
      openaiApiKey: "sk-key",
      deepgramApiKey: "",
      transcriptionProvider: "deepgram",
      correctionEnabled: false,
    });
    setupGlobals(electron);

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await expect(voiceRecordingService.refreshConfiguration()).resolves.toBe(false);
  });

  it("keeps a Deepgram user configured while cleanup stays off without an OpenAI key", async () => {
    const electron = buildElectronStub();
    electron.voiceInput.getSettings.mockResolvedValue({
      enabled: true,
      openaiApiKey: "",
      deepgramApiKey: "dg-test",
      transcriptionProvider: "deepgram",
      correctionEnabled: true,
    });
    setupGlobals(electron);

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
    await expect(voiceRecordingService.refreshConfiguration()).resolves.toBe(true);
    expect(useVoiceRecordingStore.getState().setCorrectionEnabled).toHaveBeenLastCalledWith(false);

    electron.voiceInput.getSettings.mockResolvedValue({
      enabled: true,
      openaiApiKey: "sk-key",
      deepgramApiKey: "dg-test",
      transcriptionProvider: "deepgram",
      correctionEnabled: true,
    });
    await voiceRecordingService.refreshConfiguration();
    expect(useVoiceRecordingStore.getState().setCorrectionEnabled).toHaveBeenLastCalledWith(true);
  });

  it("treats an OpenAI user with an OpenAI key as configured", async () => {
    const electron = buildElectronStub();
    electron.voiceInput.getSettings.mockResolvedValue({
      enabled: true,
      openaiApiKey: "sk-key",
      deepgramApiKey: "",
      transcriptionProvider: "openai",
      correctionEnabled: false,
    });
    setupGlobals(electron);

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    await expect(voiceRecordingService.refreshConfiguration()).resolves.toBe(true);
  });
});
type VoiceRecordingServiceInstance =
  (typeof import("../VoiceRecordingService"))["voiceRecordingService"];

// Focus a plain terminal, the target a dictation shortcut picks up.
async function focusTerminalPanel() {
  const panelState: { focusedId: string | null; panelsById: Record<string, unknown> } = Reflect.get(
    await import("@/store/panelStore"),
    "__state"
  );
  panelState.focusedId = "panel-1";
  panelState.panelsById = {
    "panel-1": { id: "panel-1", title: "Terminal", location: "grid", launchAgentId: "claude" },
  };
}

describe("VoiceRecordingService — push-to-talk mode (#9189)", () => {
  beforeEach(() => {
    vi.resetModules();
    suspendCallbacks.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function buildPttElectronStub() {
    const stub = buildElectronStub();
    stub.voiceInput.getSettings.mockResolvedValue({
      enabled: true,
      openaiApiKey: "sk-key",
      correctionEnabled: false,
      recordingMode: "push-to-talk",
    });
    return stub;
  }

  // What the dispatched shortcut does after its keydown: start in the focused
  // panel, which claims the press so its release can stop the recording.
  async function startFromPress(service: VoiceRecordingServiceInstance) {
    await focusTerminalPanel();
    vi.spyOn(service, "start").mockResolvedValue();
    await service.toggleFocusedPanel();
  }

  it("toggleFocusedPanel calls start() in push-to-talk mode (not toggle)", async () => {
    const electron = buildPttElectronStub();
    setupGlobals(electron);

    const panel = (await import("@/store/panelStore")) as unknown as {
      __state: { focusedId: string | null; panelsById: Record<string, unknown> };
    };
    panel.__state.focusedId = "panel-1";
    panel.__state.panelsById = {
      "panel-1": { id: "panel-1", title: "Terminal", location: "grid", launchAgentId: "claude" },
    };

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const startSpy = vi.spyOn(voiceRecordingService, "start").mockResolvedValue();
    const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();

    voiceRecordingService.initialize();
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    await voiceRecordingService.toggleFocusedPanel();

    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ panelId: "panel-1", panelTitle: "Terminal" })
    );
    expect(toggleSpy).not.toHaveBeenCalled();
  });

  it("toggleFocusedPanel still calls toggle() in toggle mode (regression guard)", async () => {
    const electron = buildElectronStub();
    electron.voiceInput.getSettings.mockResolvedValue({
      enabled: true,
      openaiApiKey: "sk-key",
      correctionEnabled: false,
      recordingMode: "toggle",
    });
    setupGlobals(electron);

    const panel = (await import("@/store/panelStore")) as unknown as {
      __state: { focusedId: string | null; panelsById: Record<string, unknown> };
    };
    panel.__state.focusedId = "panel-1";
    panel.__state.panelsById = {
      "panel-1": { id: "panel-1", title: "Terminal", location: "grid", launchAgentId: "claude" },
    };

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const startSpy = vi.spyOn(voiceRecordingService, "start").mockResolvedValue();
    const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();

    voiceRecordingService.initialize();
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    await voiceRecordingService.toggleFocusedPanel();

    expect(toggleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ panelId: "panel-1", panelTitle: "Terminal" })
    );
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("keyup of the matched trigger key stops the PTT session", async () => {
    const electron = buildPttElectronStub();
    const { windowListeners } = setupGlobals(electron);

    const { keybindingService } = (await import("@/services/KeybindingService")) as unknown as {
      keybindingService: { matchesEvent: ReturnType<typeof vi.fn> };
    };
    keybindingService.matchesEvent.mockImplementation(
      (e: KeyboardEvent, combo: string) => combo === "Cmd+." && e.code === "Period"
    );

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();

    voiceRecordingService.initialize();
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    const keydownListeners = windowListeners["keydown"] ?? [];
    const keyupListeners = windowListeners["keyup"] ?? [];
    expect(keydownListeners.length).toBeGreaterThan(0);
    expect(keyupListeners.length).toBeGreaterThan(0);

    // Simulate the PTT keydown (Cmd+.).
    const downEvent = {
      code: "Period",
      key: ".",
      repeat: false,
      metaKey: true,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
    } as unknown as KeyboardEvent;
    for (const listener of keydownListeners) listener(downEvent);
    await startFromPress(voiceRecordingService);

    // Simulate the keyup of the same key.
    const upEvent = { code: "Period" } as unknown as KeyboardEvent;
    for (const listener of keyupListeners) listener(upEvent);

    expect(stopSpy).toHaveBeenCalledWith(
      "Dictation stopped.",
      expect.objectContaining({ preserveLiveText: true })
    );
  });

  it("a second override combo for the voice shortcut arms the release like the first", async () => {
    const electron = buildPttElectronStub();
    const { windowListeners } = setupGlobals(electron);

    const { keybindingService } = await import("@/services/KeybindingService");
    vi.mocked(keybindingService.getEffectiveCombos).mockImplementation((actionId: string) =>
      actionId === "voiceInput.toggle" ? ["Cmd+.", "Cmd+Shift+U"] : []
    );
    vi.mocked(keybindingService.matchesEvent).mockImplementation(
      (e: KeyboardEvent, combo: string) => combo === "Cmd+Shift+U" && e.code === "KeyU"
    );

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();

    voiceRecordingService.initialize();
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    const down = { code: "KeyU", key: "U", repeat: false, metaKey: true, shiftKey: true };
    for (const listener of windowListeners["keydown"] ?? []) listener(down);
    await startFromPress(voiceRecordingService);
    for (const listener of windowListeners["keyup"] ?? []) listener({ code: "KeyU" });

    expect(stopSpy).toHaveBeenCalledWith(
      "Dictation stopped.",
      expect.objectContaining({ preserveLiveText: true })
    );
  });

  it("MetaLeft keyup stops the session even when the trigger key release is swallowed (macOS)", async () => {
    const electron = buildPttElectronStub();
    const { windowListeners } = setupGlobals(electron);

    const { keybindingService } = (await import("@/services/KeybindingService")) as unknown as {
      keybindingService: { matchesEvent: ReturnType<typeof vi.fn> };
    };
    keybindingService.matchesEvent.mockImplementation(
      (e: KeyboardEvent, combo: string) => combo === "Cmd+." && e.code === "Period"
    );

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();

    voiceRecordingService.initialize();
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    const keydownListeners = windowListeners["keydown"] ?? [];
    const keyupListeners = windowListeners["keyup"] ?? [];

    const downEvent = {
      code: "Period",
      key: ".",
      repeat: false,
      metaKey: true,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
    } as unknown as KeyboardEvent;
    for (const listener of keydownListeners) listener(downEvent);
    await startFromPress(voiceRecordingService);

    // Period keyup never arrives (macOS swallows it); only MetaLeft keyup fires.
    const metaUpEvent = { code: "MetaLeft" } as unknown as KeyboardEvent;
    for (const listener of keyupListeners) listener(metaUpEvent);

    expect(stopSpy).toHaveBeenCalled();
  });

  it("ignores key-repeat keydown events (only the first physical press starts PTT)", async () => {
    const electron = buildPttElectronStub();
    const { windowListeners } = setupGlobals(electron);

    const { keybindingService } = (await import("@/services/KeybindingService")) as unknown as {
      keybindingService: { matchesEvent: ReturnType<typeof vi.fn> };
    };
    keybindingService.matchesEvent.mockImplementation(
      (e: KeyboardEvent, combo: string) => combo === "Cmd+." && e.code === "Period"
    );

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();

    voiceRecordingService.initialize();
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    const keydownListeners = windowListeners["keydown"] ?? [];
    const keyupListeners = windowListeners["keyup"] ?? [];

    // A real press starts and claims the session; the repeat must not replace it.
    for (const listener of keydownListeners)
      listener({ code: "Period", key: ".", repeat: false, metaKey: true });
    await startFromPress(voiceRecordingService);
    const repeatEvent = {
      code: "Period",
      key: ".",
      repeat: true,
      metaKey: true,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
    } as unknown as KeyboardEvent;
    for (const listener of keydownListeners) listener(repeatEvent);

    // The release still stops the claimed press, exactly once.
    const upEvent = { code: "Period" } as unknown as KeyboardEvent;
    for (const listener of keyupListeners) listener(upEvent);
    for (const listener of keyupListeners) listener(upEvent);

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("window blur stops the session when a PTT press is active", async () => {
    const electron = buildPttElectronStub();
    const { windowListeners } = setupGlobals(electron);

    const { keybindingService } = (await import("@/services/KeybindingService")) as unknown as {
      keybindingService: { matchesEvent: ReturnType<typeof vi.fn> };
    };
    keybindingService.matchesEvent.mockImplementation(
      (e: KeyboardEvent, combo: string) => combo === "Cmd+." && e.code === "Period"
    );

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();

    voiceRecordingService.initialize();
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    const keydownListeners = windowListeners["keydown"] ?? [];
    const blurListeners = windowListeners["blur"] ?? [];
    expect(blurListeners.length).toBeGreaterThan(0);

    const downEvent = {
      code: "Period",
      key: ".",
      repeat: false,
      metaKey: true,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
    } as unknown as KeyboardEvent;
    for (const listener of keydownListeners) listener(downEvent);
    await startFromPress(voiceRecordingService);

    for (const listener of blurListeners) listener(new Event("blur"));

    expect(stopSpy).toHaveBeenCalledWith(
      "Dictation stopped.",
      expect.objectContaining({ preserveLiveText: true })
    );
  });

  it("toggleAssistant calls start() in push-to-talk mode (not toggle)", async () => {
    const electron = buildPttElectronStub();
    setupGlobals(electron);

    const help = (await import("@/store/helpPanelStore")) as unknown as {
      __state: { isOpen: boolean; terminalId: string | null };
      __fns: { setOpen: ReturnType<typeof vi.fn>; requestFocus: ReturnType<typeof vi.fn> };
    };
    const panel = (await import("@/store/panelStore")) as unknown as {
      __state: { focusedId: string | null; panelsById: Record<string, unknown> };
    };
    help.__state.isOpen = true;
    help.__state.terminalId = "assistant-term-1";
    panel.__state.panelsById = {
      "assistant-term-1": { id: "assistant-term-1", location: "background" },
    };

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const startSpy = vi.spyOn(voiceRecordingService, "start").mockResolvedValue();
    const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();

    voiceRecordingService.initialize();
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    await voiceRecordingService.toggleAssistant();

    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        panelId: "assistant-term-1",
        panelTitle: "Daintree Assistant",
      })
    );
    expect(toggleSpy).not.toHaveBeenCalled();
  });

  it("ignores keyup of an unrelated key during an active PTT session", async () => {
    const electron = buildPttElectronStub();
    const { windowListeners } = setupGlobals(electron);

    const { keybindingService } = (await import("@/services/KeybindingService")) as unknown as {
      keybindingService: { matchesEvent: ReturnType<typeof vi.fn> };
    };
    keybindingService.matchesEvent.mockImplementation(
      (e: KeyboardEvent, combo: string) => combo === "Cmd+." && e.code === "Period"
    );

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();

    voiceRecordingService.initialize();
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    const keydownListeners = windowListeners["keydown"] ?? [];
    const keyupListeners = windowListeners["keyup"] ?? [];

    const downEvent = {
      code: "Period",
      key: ".",
      repeat: false,
      metaKey: true,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
    } as unknown as KeyboardEvent;
    for (const listener of keydownListeners) listener(downEvent);
    await startFromPress(voiceRecordingService);

    // KeyA release while V is still held — must not stop.
    for (const listener of keyupListeners) listener({ code: "KeyA" } as unknown as KeyboardEvent);
    expect(stopSpy).not.toHaveBeenCalled();

    // Period release does stop.
    for (const listener of keyupListeners) listener({ code: "Period" } as unknown as KeyboardEvent);
    expect(stopSpy).toHaveBeenCalled();
  });

  it("Shift release alone does NOT stop the PTT session (modifier release ignored)", async () => {
    const electron = buildPttElectronStub();
    const { windowListeners } = setupGlobals(electron);

    const { keybindingService } = (await import("@/services/KeybindingService")) as unknown as {
      keybindingService: { matchesEvent: ReturnType<typeof vi.fn> };
    };
    keybindingService.matchesEvent.mockImplementation(
      (e: KeyboardEvent, combo: string) => combo === "Cmd+." && e.code === "Period"
    );

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();

    voiceRecordingService.initialize();
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    const keydownListeners = windowListeners["keydown"] ?? [];
    const keyupListeners = windowListeners["keyup"] ?? [];

    const downEvent = {
      code: "Period",
      key: ".",
      repeat: false,
      metaKey: true,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
    } as unknown as KeyboardEvent;
    for (const listener of keydownListeners) listener(downEvent);

    await startFromPress(voiceRecordingService);

    // ShiftLeft release alone — should NOT stop.
    const shiftUpEvent = { code: "ShiftLeft" } as unknown as KeyboardEvent;
    for (const listener of keyupListeners) listener(shiftUpEvent);
    expect(stopSpy).not.toHaveBeenCalled();

    // The trigger release still does.
    for (const listener of keyupListeners) listener({ code: "Period" });
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});

describe("VoiceRecordingService — a session another view owns (#14601)", () => {
  beforeEach(() => {
    vi.resetModules();
    suspendCallbacks.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const elsewhere = {
    sessionId: "remote",
    hostId: "local",
    projectId: "project-a",
    projectName: "Alpha",
  };

  function hasMockState<T>(mod: object): mod is { __state: T } {
    return "__state" in mod;
  }

  function hasSwitchMock(mod: object): mod is { __switchProject: Mock<(id: string) => void> } {
    return "__switchProject" in mod;
  }

  type VoiceState = {
    status: string;
    activeTarget: { panelId: string } | null;
    lockedTarget: { panelId: string } | null;
    sessionElsewhere: unknown;
  };
  type PanelState = { focusedId: string | null; panelsById: Record<string, unknown> };

  async function arrange(options: {
    status?: string;
    sessionElsewhere?: typeof elsewhere | null;
    recordingMode?: "toggle" | "push-to-talk";
  }) {
    const electron = buildElectronStub();
    electron.voiceInput.getSettings.mockResolvedValue({
      enabled: true,
      openaiApiKey: "sk-key",
      correctionEnabled: false,
      recordingMode: options.recordingMode ?? "toggle",
    });
    const { windowListeners } = setupGlobals(electron);

    const panel = await import("@/store/panelStore");
    if (!hasMockState<PanelState>(panel)) throw new Error("panelStore mock lacks __state");
    panel.__state.focusedId = "panel-b";
    panel.__state.panelsById = {
      "panel-b": { id: "panel-b", title: "Focused", location: "grid", launchAgentId: "claude" },
      "panel-c": { id: "panel-c", title: "Later", location: "grid", launchAgentId: "claude" },
    };

    const voiceModule = await import("@/store/voiceRecordingStore");
    if (!hasMockState<VoiceState>(voiceModule)) {
      throw new Error("voiceRecordingStore mock lacks __state");
    }
    const voiceState = voiceModule.__state;
    voiceState.status = options.status ?? "idle";
    voiceState.activeTarget = voiceState.status === "idle" ? null : { panelId: "panel-a" };
    voiceState.lockedTarget = null;
    voiceState.sessionElsewhere =
      options.sessionElsewhere === undefined ? elsewhere : options.sessionElsewhere;
    const announce = vi.mocked(voiceModule.useVoiceRecordingStore.getState().announce);
    announce.mockClear();
    const applyLiveSessionUpdate = vi.mocked(
      voiceModule.useVoiceRecordingStore.getState().applyLiveSessionUpdate
    );
    applyLiveSessionUpdate.mockClear();

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    voiceRecordingService.initialize();
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();
    const startSpy = vi.spyOn(voiceRecordingService, "start").mockResolvedValue();
    const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();
    return {
      voiceRecordingService,
      voiceState,
      panelState: panel.__state,
      electron,
      windowListeners,
      announce,
      applyLiveSessionUpdate,
      stopSpy,
      startSpy,
      toggleSpy,
    };
  }

  it("applies main's reports of where the live session is, pulled and pushed", async () => {
    const { electron, applyLiveSessionUpdate } = await arrange({ sessionElsewhere: null });
    await vi.waitFor(() => {
      expect(applyLiveSessionUpdate).toHaveBeenCalledWith({ revision: 0, session: null });
    });

    const push = { revision: 4, session: elsewhere };
    const onLiveSession = electron.voiceInput.onLiveSession.mock.calls[0]![0];
    onLiveSession(push);

    expect(applyLiveSessionUpdate).toHaveBeenLastCalledWith(push);
  });

  it("stops the other view's session instead of starting one on the focused panel", async () => {
    const { voiceRecordingService, electron, announce, stopSpy, startSpy, toggleSpy } =
      await arrange({});

    await voiceRecordingService.toggleFocusedPanel();

    expect(electron.voiceInput.stopLive).toHaveBeenCalledWith("remote");
    expect(startSpy).not.toHaveBeenCalled();
    expect(toggleSpy).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith("Stopping dictation in Alpha.");
  });

  it("stops this view's own session first, leaving the other view alone", async () => {
    const { voiceRecordingService, electron, stopSpy } = await arrange({ status: "recording" });

    await voiceRecordingService.toggleFocusedPanel();

    expect(stopSpy).toHaveBeenCalledWith("Dictation stopped.", {
      preserveLiveText: true,
      reason: "user",
    });
    expect(electron.voiceInput.stopLive).not.toHaveBeenCalled();
  });

  it("starts on the panel focused at the press when nothing runs anywhere (#6959)", async () => {
    const { voiceRecordingService, electron, panelState, toggleSpy } = await arrange({
      sessionElsewhere: null,
    });

    const pressed = voiceRecordingService.toggleFocusedPanel();
    panelState.focusedId = "panel-c";
    await pressed;

    expect(electron.voiceInput.stopLive).not.toHaveBeenCalled();
    expect(toggleSpy).toHaveBeenCalledTimes(1);
    expect(toggleSpy).toHaveBeenCalledWith(expect.objectContaining({ panelId: "panel-b" }));
  });

  it("says nothing when the other session was already over", async () => {
    const { voiceRecordingService, electron, announce, toggleSpy } = await arrange({});
    electron.voiceInput.stopLive.mockResolvedValue(false);

    await voiceRecordingService.toggleFocusedPanel();

    expect(announce).not.toHaveBeenCalled();
    expect(toggleSpy).not.toHaveBeenCalled();
  });

  it("doesn't let the release of a push-to-talk press that stopped it stop anything here", async () => {
    const { voiceRecordingService, windowListeners, stopSpy } = await arrange({
      recordingMode: "push-to-talk",
    });
    const { keybindingService } = await import("@/services/KeybindingService");
    vi.mocked(keybindingService.matchesEvent).mockReturnValue(true);
    await vi.waitFor(() => {
      expect(voiceRecordingService["recordingMode"]).toBe("push-to-talk");
    });

    for (const listener of windowListeners["keydown"] ?? []) {
      listener({ code: "Period", repeat: false });
    }
    await voiceRecordingService.toggleFocusedPanel();
    for (const listener of windowListeners["keyup"] ?? []) listener({ code: "Period" });

    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("takes the person to the other view's session, and says when it couldn't", async () => {
    const { voiceRecordingService, electron } = await arrange({});

    await expect(voiceRecordingService.revealSessionElsewhere()).resolves.toBe(true);
    expect(electron.voiceInput.revealLive).toHaveBeenCalledWith("remote");

    electron.voiceInput.revealLive.mockResolvedValueOnce(false);
    await expect(voiceRecordingService.revealSessionElsewhere()).resolves.toBe(false);
    electron.voiceInput.revealLive.mockRejectedValueOnce(new Error("gone"));
    await expect(voiceRecordingService.revealSessionElsewhere()).resolves.toBe(false);
  });

  it("asks main for nothing to reveal when no session runs elsewhere", async () => {
    const { voiceRecordingService, electron } = await arrange({ sessionElsewhere: null });

    await expect(voiceRecordingService.revealSessionElsewhere()).resolves.toBe(false);
    expect(electron.voiceInput.revealLive).not.toHaveBeenCalled();
  });

  it("switches to the owner's workspace when on screen in the owner's window", async () => {
    const { electron } = await arrange({ sessionElsewhere: null });
    const projectStore = await import("@/store/projectStore");
    if (!hasSwitchMock(projectStore)) throw new Error("projectStore mock lacks __switchProject");
    const switchProject = projectStore.__switchProject;
    switchProject.mockClear();
    const { useScratchStore } = await import("@/store/scratchStore");
    const switchScratch = vi.fn().mockResolvedValue(undefined);
    useScratchStore.setState({ switchScratch });
    const revealRequested = electron.voiceInput.onRevealRequested.mock.calls[0]![0];

    const projectId = "a".repeat(64);
    revealRequested({ sessionId: "remote", hostId: "local", workspaceId: projectId });
    const scratchId = "3f2b8a1c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    revealRequested({ sessionId: "remote", hostId: "local", workspaceId: scratchId });

    await vi.waitFor(() => {
      expect(switchProject).toHaveBeenCalledWith(projectId);
      expect(switchScratch).toHaveBeenCalledWith(scratchId);
    });
    expect(switchProject).toHaveBeenCalledTimes(1);
    expect(switchToHost).not.toHaveBeenCalled();
  });

  describe("across hosts (#14773)", () => {
    beforeEach(() => {
      switchToHost.mockClear();
      viewLifecycle.cached = false;
      viewLifecycle.listeners.clear();
      revealDictationComposer.mockClear();
    });

    // The store mock's state outlives resetModules, and later suites press the key.
    afterEach(async () => {
      const voiceModule = await import("@/store/voiceRecordingStore");
      if (hasMockState<VoiceState>(voiceModule)) voiceModule.__state.sessionElsewhere = null;
    });

    const reveal = (
      electron: ReturnType<typeof buildElectronStub>,
      request: { sessionId: string; hostId: string; workspaceId: string | null }
    ) => electron.voiceInput.onRevealRequested.mock.calls[0]![0](request);

    async function projectSwitch() {
      const projectStore = await import("@/store/projectStore");
      if (!hasSwitchMock(projectStore)) throw new Error("projectStore mock lacks __switchProject");
      projectStore.__switchProject.mockClear();
      return projectStore.__switchProject;
    }

    it("takes this Mac's window to the host a session runs on", async () => {
      const { electron } = await arrange({ sessionElsewhere: null });
      const switchProject = await projectSwitch();

      reveal(electron, { sessionId: "remote", hostId: "studio-01", workspaceId: "proj-r" });

      await vi.waitFor(() => {
        expect(switchToHost).toHaveBeenCalledWith("studio-01", false, "proj-r");
      });
      expect(switchProject).not.toHaveBeenCalled();
    });

    it("brings a host's window back to this Mac for a session started here", async () => {
      const { electron } = await arrange({ sessionElsewhere: null });
      Reflect.set(window, "__DAINTREE_HOST_ID__", { id: "studio-01" });
      const switchProject = await projectSwitch();

      reveal(electron, { sessionId: "remote", hostId: "local", workspaceId: "project-a" });

      await vi.waitFor(() => {
        expect(switchToHost).toHaveBeenCalledWith("local", false, "project-a");
      });
      expect(switchProject).not.toHaveBeenCalled();
    });

    it("opens a project on this view's own host by the id that host knows it by", async () => {
      const { electron } = await arrange({ sessionElsewhere: null });
      Reflect.set(window, "__DAINTREE_HOST_ID__", { id: "studio-01" });
      const switchProject = await projectSwitch();

      reveal(electron, { sessionId: "remote", hostId: "studio-01", workspaceId: "proj-r" });

      await vi.waitFor(() => {
        expect(switchProject).toHaveBeenCalledWith("proj-r");
      });
      expect(switchToHost).not.toHaveBeenCalled();
    });

    it("goes to the other host's copy of a project that shares this host's id", async () => {
      const { electron } = await arrange({ sessionElsewhere: null });
      Reflect.set(window, "__DAINTREE_HOST_ID__", { id: "studio-02" });
      const switchProject = await projectSwitch();

      reveal(electron, { sessionId: "remote", hostId: "studio-01", workspaceId: "proj-r" });

      await vi.waitFor(() => {
        expect(switchToHost).toHaveBeenCalledWith("studio-01", false, "proj-r");
      });
      expect(switchProject).not.toHaveBeenCalled();
    });

    it("waits for the owner's cached view to come on screen before taking the keyboard there", async () => {
      const { electron, voiceRecordingService, voiceState } = await arrange({ status: "recording" });
      Reflect.set(voiceRecordingService, "sessionId", "own");
      const focusTarget = vi
        .spyOn(voiceRecordingService, "focusActiveTarget")
        .mockResolvedValue(true);
      viewLifecycle.cached = true;

      reveal(electron, { sessionId: "own", hostId: "local", workspaceId: "project-a" });
      for (const listener of viewLifecycle.listeners) listener("active");
      await Promise.resolve();
      expect(focusTarget).not.toHaveBeenCalled();

      for (const listener of [...viewLifecycle.listeners]) listener("revealed");

      await vi.waitFor(() => {
        expect(revealDictationComposer).toHaveBeenCalledWith(voiceState.activeTarget!.panelId);
      });
      expect(focusTarget).toHaveBeenCalledTimes(1);
      expect(viewLifecycle.listeners.size).toBe(0);
    });

    it("takes the keyboard to its pane at once when the owner is already on screen", async () => {
      const { electron, voiceRecordingService, voiceState } = await arrange({ status: "recording" });
      Reflect.set(voiceRecordingService, "sessionId", "own");
      vi.spyOn(voiceRecordingService, "focusActiveTarget").mockResolvedValue(true);

      reveal(electron, { sessionId: "own", hostId: "studio-01", workspaceId: "proj-r" });

      await vi.waitFor(() => {
        expect(revealDictationComposer).toHaveBeenCalledWith(voiceState.activeTarget!.panelId);
      });
      expect(switchToHost).not.toHaveBeenCalled();
    });

    it("gives up on a cached owner that never comes on screen, and on a newer reveal", async () => {
      const { electron, voiceRecordingService } = await arrange({ status: "recording" });
      Reflect.set(voiceRecordingService, "sessionId", "own");
      const focusTarget = vi
        .spyOn(voiceRecordingService, "focusActiveTarget")
        .mockResolvedValue(true);
      viewLifecycle.cached = true;
      vi.useFakeTimers();
      try {
        reveal(electron, { sessionId: "own", hostId: "local", workspaceId: "project-a" });
        reveal(electron, { sessionId: "own", hostId: "local", workspaceId: "project-a" });
        expect(viewLifecycle.listeners.size).toBe(1);

        vi.advanceTimersByTime(15_000);
        expect(viewLifecycle.listeners.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
      expect(focusTarget).not.toHaveBeenCalled();
    });

    it("names the host when stopping a session that runs on one", async () => {
      const { voiceRecordingService, announce } = await arrange({
        sessionElsewhere: { ...elsewhere, hostId: "studio-01", projectName: "Remote R" },
      });

      await voiceRecordingService.toggleFocusedPanel();

      expect(announce).toHaveBeenCalledWith("Stopping dictation in Remote R on studio-01.");
    });
  });
});

describe("VoiceRecordingService — tap-or-hold mode (#14626)", () => {
  beforeEach(() => {
    vi.resetModules();
    suspendCallbacks.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function setup(recordingMode = "tap-or-hold") {
    const electron = buildElectronStub();
    electron.voiceInput.getSettings.mockResolvedValue({
      enabled: true,
      openaiApiKey: "sk-key",
      correctionEnabled: false,
      recordingMode,
    });
    const { windowListeners } = setupGlobals(electron);

    const { keybindingService } = await import("@/services/KeybindingService");
    vi.mocked(keybindingService.getEffectiveCombos).mockImplementation((actionId: string) =>
      actionId === "voiceInput.toggle" ? ["Cmd+D"] : []
    );
    vi.mocked(keybindingService.matchesEvent).mockImplementation(
      (e: KeyboardEvent, combo: string) => combo === "Cmd+D" && e.code === "KeyD"
    );

    await focusTerminalPanel();
    // The store mock's state outlives resetModules.
    const voiceState: { status: string; activeTarget: { panelId: string } | null } = Reflect.get(
      await import("@/store/voiceRecordingStore"),
      "__state"
    );
    voiceState.status = "idle";
    voiceState.activeTarget = null;

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const startSpy = vi.spyOn(voiceRecordingService, "start").mockResolvedValue();
    const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();
    voiceRecordingService.initialize();
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const fire = (event: string, payload: unknown) => {
      for (const listener of windowListeners[event] ?? []) listener(payload);
    };
    const keydown = () =>
      fire("keydown", { code: "KeyD", key: "d", repeat: false, metaKey: true, timeStamp: now });
    return {
      service: voiceRecordingService,
      electron,
      voiceState,
      startSpy,
      stopSpy,
      advance: (ms: number) => {
        now += ms;
      },
      keydown,
      // The keydown reaching this listener, then the action it dispatches.
      press: async () => {
        keydown();
        await voiceRecordingService.toggleFocusedPanel();
      },
      // The app's order: the global keybinding listener is registered first and
      // runs the action synchronously, before this listener sees the keydown.
      pressDispatchingFirst: async () => {
        const started = voiceRecordingService.toggleFocusedPanel();
        keydown();
        await started;
      },
      release: (code = "KeyD") => fire("keyup", { code }),
    };
  }

  it("starts on the press, through toggle, without waiting for the release", async () => {
    const t = await setup();
    await t.press();
    expect(t.startSpy).toHaveBeenCalledWith(expect.objectContaining({ panelId: "panel-1" }));
  });

  it("keeps recording when a hold heard no speech, so a thumb lingering on Cmd is a tap", async () => {
    const t = await setup();
    await t.press();
    t.advance(2_000);
    t.release("MetaLeft");
    expect(t.stopSpy).not.toHaveBeenCalled();
  });

  it("stops on release when the action ran before this listener saw the keydown", async () => {
    const t = await setup("push-to-talk");
    await t.pressDispatchingFirst();
    t.release();
    expect(t.stopSpy).toHaveBeenCalledTimes(1);
  });

  it("hands the claim to the new press when an older press's keyup was swallowed", async () => {
    const t = await setup("push-to-talk");
    // Cmd+K Cmd+D with Cmd still held: the D keyup never arrives.
    t.keydown();
    t.advance(500);
    await t.pressDispatchingFirst();
    t.release("MetaLeft");
    expect(t.stopSpy).toHaveBeenCalledTimes(1);
  });

  it("never takes a claim made before the keydown happened", async () => {
    const t = await setup("push-to-talk");
    // A palette start claims with no key down; a later chord press must not inherit it.
    await t.service.toggleFocusedPanel();
    t.advance(5_000);
    t.keydown();
    t.release();
    expect(t.stopSpy).not.toHaveBeenCalled();
  });

  it.each(["push-to-talk", "tap-or-hold"])(
    "ignores the release of a %s hold whose session another view stopped (#14601)",
    async (mode) => {
      const t = await setup(mode);
      await t.press();
      expect(t.startSpy).toHaveBeenCalledTimes(1);
      t.voiceState.status = "recording";
      t.voiceState.activeTarget = { panelId: "panel-1" };
      t.service["sessionId"] = "live";
      // A hold that heard speech, so its release would stop it.
      const speech = { samples: 1_600, rms: 0.1, peak: 0.3, zeroFraction: 0 };
      t.service["noteHeldPressAudio"](speech);
      t.service["noteHeldPressAudio"](speech);
      t.advance(1_000);

      const stopRequested = t.electron.voiceInput.onStopRequested.mock.calls[0]![0];
      stopRequested({ sessionId: "live" });
      expect(t.stopSpy).toHaveBeenCalledTimes(1);

      t.release();
      t.release("MetaLeft");
      expect(t.stopSpy).toHaveBeenCalledTimes(1);
      expect(t.startSpy).toHaveBeenCalledTimes(1);
    }
  );

  it("never stops on the release of a press that started nothing, such as Cmd+K Cmd+D", async () => {
    const t = await setup("push-to-talk");
    // The keydown matches the voice combo, but the chord ran redraw instead.
    t.keydown();
    t.advance(1_000);
    t.release();
    expect(t.stopSpy).not.toHaveBeenCalled();
  });
});
