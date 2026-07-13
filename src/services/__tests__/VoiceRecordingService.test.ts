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
    lockedTarget: null as { panelId: string } | null,
    recentTargets: [] as Array<unknown>,
  };
  const fns = {
    setLastError: vi.fn(),
    announce: vi.fn(),
    setStatus: vi.fn(),
    setConfigured: vi.fn(),
    setCorrectionEnabled: vi.fn(),
    setLearnFromCorrections: vi.fn(),
    setSessionCorrectedText: vi.fn(),
    setArming: vi.fn(),
    beginSession: vi.fn(),
    finishSession: vi.fn(),
    setAudioLevel: vi.fn(),
    setElapsedSeconds: vi.fn(),
    appendDelta: vi.fn(),
    completeSegment: vi.fn(),
    setSessionDraftStart: vi.fn(),
    setDraftLengthAtSegmentStart: vi.fn(),
    setActiveParagraphStart: vi.fn(),
    clearPanelBuffer: vi.fn(),
    lockTarget: vi.fn(),
    unlockTarget: vi.fn(),
    clearLockedTarget: vi.fn(),
    recordRecentTarget: vi.fn(),
  };
  const getState = () => ({ ...state, ...fns });
  const subscribe = vi.fn(() => () => {});
  return {
    useVoiceRecordingStore: Object.assign(getState, { getState, subscribe }),
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

vi.mock("@/store/terminalInputStore", () => {
  const fns = {
    getDraftInput: vi.fn(() => ""),
    setDraftInput: vi.fn(),
    bumpExternalDraftRevision: vi.fn(),
  };
  const getState = () => fns;
  return { useTerminalInputStore: Object.assign(getState, { getState }) };
});

vi.mock("@/store/projectStore", () => {
  const state = { currentProject: null, isSwitching: false };
  const getState = () => ({ ...state, switchProject: vi.fn() });
  return { useProjectStore: Object.assign(getState, { getState }) };
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
  const fns = {
    setOpen: vi.fn((open: boolean) => {
      state.isOpen = open;
    }),
    requestFocus: vi.fn(),
  };
  const getState = () => ({ ...state, ...fns });
  return {
    useHelpPanelStore: Object.assign(getState, { getState }),
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
      if (actionId === "voiceInput.toggle") return "Cmd+Shift+V";
      if (actionId === "voiceInput.toggleAssistant") return "Cmd+Shift+Alt+V";
      return undefined;
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
      getSettings: vi.fn().mockResolvedValue({
        enabled: true,
        openaiApiKey: "sk-key",
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
    let storeCallback:
      | ((state: { panelsById: Record<string, unknown>; panelIds: string[] }) => void)
      | null = null;
    const { usePanelStore } = (await import("@/store/panelStore")) as unknown as {
      usePanelStore: { subscribe: ReturnType<typeof vi.fn> };
    };
    (usePanelStore.subscribe as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (state: { panelsById: Record<string, unknown>; panelIds: string[] }) => void) => {
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
    storeCallback!({ panelsById: {}, panelIds: [] });

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
    expect(isActiveVoiceSession("paused")).toBe(true);
    expect(isActiveVoiceSession("reconnecting")).toBe(true);
    expect(isActiveVoiceSession("finishing")).toBe(true);
  });

  it("returns false for terminal phases", () => {
    expect(isActiveVoiceSession("idle")).toBe(false);
    expect(isActiveVoiceSession("error")).toBe(false);
  });

  it("returns false for arming — it is pre-audio, not an active session", () => {
    // Arming must be excluded so the toggle guard treats a second hotkey
    // press during arming as continuing the start, not stopping a session
    // that hasn't begun.
    expect(isActiveVoiceSession("arming")).toBe(false);
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
    const { windowListeners } = setupGlobals();

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

    const escapeEvent = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const keydownListeners = windowListeners["keydown"] ?? [];
    for (const listener of keydownListeners) {
      listener(escapeEvent);
    }

    expect(finishSessionMock).toHaveBeenCalledWith({ nextStatus: "idle" });
    expect(stopSpy).not.toHaveBeenCalled();

    storeModule.__state.activeTarget = null;
    storeModule.__state.status = "idle";
  });
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
    getUserMediaMock.mockResolvedValue({
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
    } as unknown as MediaStream);

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

  it("routes Cmd+Shift+V to the assistant terminal when the assistant is focused", async () => {
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

  it("falls back to the focused grid panel when the assistant is not focused", async () => {
    setupGlobals();
    const { macro, panel } = await importMocks();
    macro.isAssistantFocused.mockReturnValue(false);
    panel.__state.focusedId = "grid-panel-9";
    panel.__state.panelsById = {
      "grid-panel-9": { id: "grid-panel-9", title: "Terminal", location: "grid" },
    };

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const toggleSpy = vi.spyOn(voiceRecordingService, "toggle").mockResolvedValue();

    await voiceRecordingService.toggleFocusedPanel();

    expect(toggleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ panelId: "grid-panel-9", panelTitle: "Terminal" })
    );
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
      "grid-panel-9": { id: "grid-panel-9", title: "Terminal", location: "grid" },
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
      __state: { activeTarget: { panelId: string } | null; status: string };
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
    let deltaCallback: ((delta: string) => void) | null = null;
    // Cast through unknown because the stub's vi.fn is initialised with a
    // zero-arg shape; the real handler takes a (delta:string)=>void.
    (
      electronStub.voiceInput.onTranscriptionDelta as unknown as {
        mockImplementation: (impl: (cb: (delta: string) => void) => () => void) => void;
      }
    ).mockImplementation((cb) => {
      deltaCallback = cb;
      return () => {};
    });

    const { __state } = (await import("@/store/voiceRecordingStore")) as unknown as {
      __state: { activeTarget: { panelId: string } | null };
    };
    __state.activeTarget = { panelId: "panel-1" };

    const { useTerminalInputStore } = await import("@/store/terminalInputStore");
    const inputStore = useTerminalInputStore.getState();

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    voiceRecordingService.initialize();

    expect(deltaCallback).not.toBeNull();
    deltaCallback!("hello");
    deltaCallback!(" world");
    deltaCallback!(" again");

    // The interim path must not mutate the draft store — that's the entire fix.
    expect(inputStore.setDraftInput).not.toHaveBeenCalled();
    expect(inputStore.bumpExternalDraftRevision).not.toHaveBeenCalled();

    __state.activeTarget = null;
  });

  it("commits exactly one draft write per onTranscriptionComplete (one undo step)", async () => {
    const { electronStub } = setupGlobals();
    let deltaCallback: ((delta: string) => void) | null = null;
    let completeCallback: ((payload: { text: string }) => void) | null = null;
    (
      electronStub.voiceInput.onTranscriptionDelta as unknown as {
        mockImplementation: (impl: (cb: (delta: string) => void) => () => void) => void;
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
    deltaCallback!("hel");
    deltaCallback!("lo");
    deltaCallback!(" wor");
    deltaCallback!("ld");
    deltaCallback!("!");

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

  it("toggleFocusedPanel calls start() in push-to-talk mode (not toggle)", async () => {
    const electron = buildPttElectronStub();
    setupGlobals(electron);

    const panel = (await import("@/store/panelStore")) as unknown as {
      __state: { focusedId: string | null; panelsById: Record<string, unknown> };
    };
    panel.__state.focusedId = "panel-1";
    panel.__state.panelsById = {
      "panel-1": { id: "panel-1", title: "Terminal", location: "grid" },
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
      "panel-1": { id: "panel-1", title: "Terminal", location: "grid" },
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
      (e: KeyboardEvent, combo: string) => combo === "Cmd+Shift+V" && e.code === "KeyV"
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

    // Simulate the PTT keydown (Cmd+Shift+V).
    const downEvent = {
      code: "KeyV",
      key: "V",
      repeat: false,
      metaKey: true,
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
    } as unknown as KeyboardEvent;
    for (const listener of keydownListeners) listener(downEvent);

    // Simulate the keyup of the same key.
    const upEvent = { code: "KeyV" } as unknown as KeyboardEvent;
    for (const listener of keyupListeners) listener(upEvent);

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
      (e: KeyboardEvent, combo: string) => combo === "Cmd+Shift+V" && e.code === "KeyV"
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
      code: "KeyV",
      key: "V",
      repeat: false,
      metaKey: true,
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
    } as unknown as KeyboardEvent;
    for (const listener of keydownListeners) listener(downEvent);

    // KeyV keyup never arrives (macOS swallows it); only MetaLeft keyup fires.
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
      (e: KeyboardEvent, combo: string) => combo === "Cmd+Shift+V" && e.code === "KeyV"
    );

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();

    voiceRecordingService.initialize();
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    const keydownListeners = windowListeners["keydown"] ?? [];
    const keyupListeners = windowListeners["keyup"] ?? [];

    // Only the repeating keydown fires — pttActiveKeyCode must not be set.
    const repeatEvent = {
      code: "KeyV",
      key: "V",
      repeat: true,
      metaKey: true,
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
    } as unknown as KeyboardEvent;
    for (const listener of keydownListeners) listener(repeatEvent);

    // Now release — keyup should NOT fire stop since no PTT session is tracked.
    const upEvent = { code: "KeyV" } as unknown as KeyboardEvent;
    for (const listener of keyupListeners) listener(upEvent);

    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("window blur stops the session when a PTT press is active", async () => {
    const electron = buildPttElectronStub();
    const { windowListeners } = setupGlobals(electron);

    const { keybindingService } = (await import("@/services/KeybindingService")) as unknown as {
      keybindingService: { matchesEvent: ReturnType<typeof vi.fn> };
    };
    keybindingService.matchesEvent.mockImplementation(
      (e: KeyboardEvent, combo: string) => combo === "Cmd+Shift+V" && e.code === "KeyV"
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
      code: "KeyV",
      key: "V",
      repeat: false,
      metaKey: true,
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
    } as unknown as KeyboardEvent;
    for (const listener of keydownListeners) listener(downEvent);

    for (const listener of blurListeners) listener(new Event("blur"));

    expect(stopSpy).toHaveBeenCalledWith(
      "Dictation stopped.",
      expect.objectContaining({ preserveLiveText: true })
    );
  });

  it("window blur does NOT call stop when no PTT press is active (toggle mode unaffected)", async () => {
    const electron = buildElectronStub();
    electron.voiceInput.getSettings.mockResolvedValue({
      enabled: true,
      openaiApiKey: "sk-key",
      correctionEnabled: false,
      recordingMode: "toggle",
    });
    const { windowListeners } = setupGlobals(electron);

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();

    voiceRecordingService.initialize();
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    const blurListeners = windowListeners["blur"] ?? [];
    for (const listener of blurListeners) listener(new Event("blur"));

    expect(stopSpy).not.toHaveBeenCalled();
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
      (e: KeyboardEvent, combo: string) => combo === "Cmd+Shift+V" && e.code === "KeyV"
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
      code: "KeyV",
      key: "V",
      repeat: false,
      metaKey: true,
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
    } as unknown as KeyboardEvent;
    for (const listener of keydownListeners) listener(downEvent);

    // KeyA release while V is still held — must not stop.
    for (const listener of keyupListeners) listener({ code: "KeyA" } as unknown as KeyboardEvent);
    expect(stopSpy).not.toHaveBeenCalled();

    // KeyV release does stop.
    for (const listener of keyupListeners) listener({ code: "KeyV" } as unknown as KeyboardEvent);
    expect(stopSpy).toHaveBeenCalled();
  });

  it("command-palette re-invocation in PTT mode stops the active session", async () => {
    const electron = buildPttElectronStub();
    setupGlobals(electron);

    const panel = (await import("@/store/panelStore")) as unknown as {
      __state: { focusedId: string | null; panelsById: Record<string, unknown> };
    };
    panel.__state.focusedId = "panel-1";
    panel.__state.panelsById = {
      "panel-1": { id: "panel-1", title: "Terminal", location: "grid" },
    };

    // Mark the session as already active for panel-1.
    const voice = (await import("@/store/voiceRecordingStore")) as unknown as {
      __state: { activeTarget: { panelId: string } | null; status: string };
    };
    voice.__state.activeTarget = { panelId: "panel-1" };
    voice.__state.status = "recording";

    const { voiceRecordingService } = await import("../VoiceRecordingService");
    const startSpy = vi.spyOn(voiceRecordingService, "start").mockResolvedValue();
    const stopSpy = vi.spyOn(voiceRecordingService, "stop").mockResolvedValue();

    voiceRecordingService.initialize();
    await vi.waitFor(() => {
      expect(electron.voiceInput.getSettings).toHaveBeenCalled();
    });

    await voiceRecordingService.toggleFocusedPanel();

    expect(stopSpy).toHaveBeenCalledWith(
      "Dictation stopped.",
      expect.objectContaining({ preserveLiveText: true })
    );
    expect(startSpy).not.toHaveBeenCalled();

    voice.__state.activeTarget = null;
    voice.__state.status = "idle";
  });

  it("Shift release alone does NOT stop the PTT session (modifier release ignored)", async () => {
    const electron = buildPttElectronStub();
    const { windowListeners } = setupGlobals(electron);

    const { keybindingService } = (await import("@/services/KeybindingService")) as unknown as {
      keybindingService: { matchesEvent: ReturnType<typeof vi.fn> };
    };
    keybindingService.matchesEvent.mockImplementation(
      (e: KeyboardEvent, combo: string) => combo === "Cmd+Shift+V" && e.code === "KeyV"
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
      code: "KeyV",
      key: "V",
      repeat: false,
      metaKey: true,
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
    } as unknown as KeyboardEvent;
    for (const listener of keydownListeners) listener(downEvent);

    // ShiftLeft release alone — should NOT stop.
    const shiftUpEvent = { code: "ShiftLeft" } as unknown as KeyboardEvent;
    for (const listener of keyupListeners) listener(shiftUpEvent);

    expect(stopSpy).not.toHaveBeenCalled();
  });
});
