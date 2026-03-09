import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isActiveVoiceSession } from "@shared/types";

// Capture suspend/wake callbacks registered by the service.
const suspendCallbacks = vi.hoisted(() => [] as Array<() => void>);

vi.mock("@/store/voiceRecordingStore", () => {
  const state = {
    activeTarget: null as { panelId: string } | null,
    status: "idle" as string,
    panelBuffers: {} as Record<string, unknown>,
    correctionEnabled: false,
    isConfigured: false,
  };
  const fns = {
    setError: vi.fn(),
    announce: vi.fn(),
    setStatus: vi.fn(),
    setConfigured: vi.fn(),
    setCorrectionEnabled: vi.fn(),
    beginSession: vi.fn(),
    finishSession: vi.fn(),
    setAudioLevel: vi.fn(),
    setElapsedSeconds: vi.fn(),
    appendDelta: vi.fn(),
    completeSegment: vi.fn(),
    resolvePendingCorrection: vi.fn(),
    addPendingCorrection: vi.fn(),
    setDraftLengthAtSegmentStart: vi.fn(),
  };
  const getState = () => ({ ...state, ...fns });
  const subscribe = vi.fn(() => () => {});
  return {
    useVoiceRecordingStore: Object.assign(getState, { getState, subscribe }),
    __state: state,
  };
});

vi.mock("@/store/terminalStore", () => {
  const state = { terminals: [] as unknown[], focusedId: null as string | null };
  const getState = () => state;
  const subscribe = vi.fn(() => () => {});
  return { useTerminalStore: Object.assign(getState, { getState, subscribe }), __state: state };
});

vi.mock("@/store/terminalInputStore", () => {
  const fns = {
    getDraftInput: vi.fn(() => ""),
    setDraftInput: vi.fn(),
    appendVoiceText: vi.fn(),
    bumpVoiceDraftRevision: vi.fn(),
  };
  const getState = () => fns;
  return { useTerminalInputStore: Object.assign(getState, { getState }) };
});

vi.mock("@/store/projectStore", () => {
  const state = { currentProject: null, isSwitching: false };
  const getState = () => ({ ...state, switchProject: vi.fn() });
  return { useProjectStore: Object.assign(getState, { getState }) };
});

vi.mock("@/store/worktreeDataStore", () => {
  const getState = () => ({ worktrees: new Map() });
  return { useWorktreeDataStore: Object.assign(getState, { getState }) };
});

vi.mock("@/store/worktreeStore", () => {
  const getState = () => ({ activeWorktreeId: null, selectWorktree: vi.fn() });
  return { useWorktreeSelectionStore: Object.assign(getState, { getState }) };
});

vi.mock("@/utils/logger", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/voiceInputSettingsEvents", () => ({
  VOICE_INPUT_SETTINGS_CHANGED_EVENT: "voice-input-settings-changed",
}));

function buildElectronStub() {
  return {
    voiceInput: {
      onTranscriptionDelta: vi.fn(() => () => {}),
      onTranscriptionComplete: vi.fn(() => () => {}),
      onCorrectionReplace: vi.fn(() => () => {}),
      onParagraphBoundary: vi.fn(() => () => {}),
      onError: vi.fn(() => () => {}),
      onStatus: vi.fn(() => () => {}),
      getSettings: vi.fn().mockResolvedValue({
        enabled: true,
        deepgramApiKey: "dg-key",
        correctionApiKey: "",
        correctionEnabled: false,
      }),
      checkMicPermission: vi.fn().mockResolvedValue("granted"),
      requestMicPermission: vi.fn().mockResolvedValue(true),
      openMicSettings: vi.fn(),
      sendAudioChunk: vi.fn(),
      start: vi.fn().mockResolvedValue({ ok: true }),
      stop: vi.fn().mockResolvedValue(undefined),
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
  const sourceMock = { connect: vi.fn() };
  const ctx = {
    state: "running",
    destination,
    sampleRate: 24000,
    resume: vi.fn().mockResolvedValue(undefined),
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
  vi.stubGlobal("AudioWorkletNode", function () {
    return { port: { onmessage: null }, connect: vi.fn(), disconnect: vi.fn() };
  });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [{ stop: vi.fn() }],
        getAudioTracks: () => [{}],
      }),
    },
  });

  return { windowListeners, documentListeners, electronStub, ctx, oscillatorMock, gainMock };
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

    // Fire every registered window "blur" listener — none should call stop().
    const blurListeners = windowListeners["blur"] ?? [];
    for (const listener of blurListeners) {
      await listener(new Event("blur"));
    }

    expect(stopSpy).not.toHaveBeenCalled();
    expect(blurListeners).toHaveLength(0);
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
    const { __state } = (await import("@/store/voiceRecordingStore")) as unknown as {
      __state: { activeTarget: { panelId: string } | null };
    };
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

  it("tears down the keep-alive oscillator and AudioContext when stop() is called", async () => {
    const { ctx, oscillatorMock, gainMock } = setupGlobals();

    const { __state } = (await import("@/store/voiceRecordingStore")) as unknown as {
      __state: { activeTarget: { panelId: string } | null };
    };
    __state.activeTarget = { panelId: "panel-1" };

    const { voiceRecordingService } = await import("../VoiceRecordingService");

    await voiceRecordingService.start({ panelId: "panel-1", panelTitle: "Terminal" });
    await voiceRecordingService.stop("Dictation stopped.", { skipRemoteStop: true });

    expect(oscillatorMock.stop).toHaveBeenCalled();
    expect(oscillatorMock.disconnect).toHaveBeenCalled();
    expect(gainMock.disconnect).toHaveBeenCalled();
    expect(ctx.close).toHaveBeenCalled();

    __state.activeTarget = null;
  });

  it("stops recording when the active panel is moved to trash (panel-close regression)", async () => {
    // Capture the terminalStore subscribe callback so we can trigger it.
    let storeCallback: ((state: { terminals: unknown[] }) => void) | null = null;
    const { useTerminalStore } = (await import("@/store/terminalStore")) as unknown as {
      useTerminalStore: { subscribe: ReturnType<typeof vi.fn> };
    };
    (useTerminalStore.subscribe as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (state: { terminals: unknown[] }) => void) => {
        storeCallback = cb;
        return () => {};
      }
    );

    const { __state: voiceState } = (await import("@/store/voiceRecordingStore")) as unknown as {
      __state: { activeTarget: { panelId: string } | null };
    };
    voiceState.activeTarget = { panelId: "panel-1" };

    setupGlobals();
    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi.spyOn(voiceRecordingService, "stop");

    voiceRecordingService.initialize();

    // Simulate the panel being removed from the terminal list.
    expect(storeCallback).not.toBeNull();
    storeCallback!({ terminals: [] });

    expect(stopSpy).toHaveBeenCalledWith(
      "Dictation stopped because its panel was closed.",
      expect.objectContaining({ preserveLiveText: true })
    );

    voiceState.activeTarget = null;
  });
});

describe("isActiveVoiceSession helper", () => {
  it("returns true for active phases", () => {
    expect(isActiveVoiceSession("connecting")).toBe(true);
    expect(isActiveVoiceSession("recording")).toBe(true);
    expect(isActiveVoiceSession("finishing")).toBe(true);
  });

  it("returns false for terminal phases", () => {
    expect(isActiveVoiceSession("idle")).toBe(false);
    expect(isActiveVoiceSession("error")).toBe(false);
  });
});
