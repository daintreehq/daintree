import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drives the real voice store through device loss, a chosen mic that's gone,
// and a silent Bluetooth mic (#14606).

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
  return { useTerminalInputStore: Object.assign(getState, { getState }) };
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

type Listener = () => void;

interface FakeTrack {
  label: string;
  readyState: string;
  muted: boolean;
  enabled: boolean;
  stop: ReturnType<typeof vi.fn>;
  getSettings: () => { deviceId: string };
  addEventListener: (type: string, cb: Listener) => void;
  removeEventListener: (type: string, cb: Listener) => void;
  /** Simulates the device or OS pulling the track. */
  end: () => void;
}

function createTrack(label: string, deviceId: string): FakeTrack {
  const listeners = new Map<string, Set<Listener>>();
  const track: FakeTrack = {
    label,
    readyState: "live",
    muted: false,
    enabled: true,
    // A local stop() fires no "ended" in Chromium.
    stop: vi.fn(() => {
      track.readyState = "ended";
    }),
    getSettings: () => ({ deviceId }),
    addEventListener: (type, cb) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    removeEventListener: (type, cb) => {
      listeners.get(type)?.delete(cb);
    },
    end: () => {
      track.readyState = "ended";
      for (const cb of [...(listeners.get("ended") ?? [])]) cb();
    },
  };
  return track;
}

function createStream(track: FakeTrack) {
  return { getTracks: () => [track], getAudioTracks: () => [track] };
}

interface WorkletNode {
  port: { onmessage: ((event: { data: ArrayBuffer }) => void) | null; postMessage: Listener };
  connect: Listener;
  disconnect: Listener;
}

const PANEL_ID = "panel-1";
const TARGET = { panelId: PANEL_ID, panelTitle: "Claude" };

interface Harness {
  tracks: FakeTrack[];
  workletNodes: WorkletNode[];
  getUserMedia: ReturnType<typeof vi.fn>;
  enumerateDevices: ReturnType<typeof vi.fn>;
  deviceChangeListeners: Set<Listener>;
  voiceInput: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    setSettings: ReturnType<typeof vi.fn>;
    getSettings: ReturnType<typeof vi.fn>;
    sendAudioChunk: ReturnType<typeof vi.fn>;
  };
  status: { emit: (status: string) => void };
  delta: { emit: (text: string) => void };
  settings: { deviceId: string };
}

function setupGlobals(options: {
  deviceId?: string;
  tracks: Array<{ label: string; deviceId: string }>;
  devices?: Array<{ deviceId: string; label: string }>;
}): Harness {
  const tracks: FakeTrack[] = [];
  const workletNodes: WorkletNode[] = [];
  const deviceChangeListeners = new Set<Listener>();
  const pendingTracks = [...options.tracks];
  let statusCallback: ((status: string) => void) | null = null;
  let deltaCallback: ((payload: { text: string }) => void) | null = null;
  const settings = {
    enabled: true,
    openaiApiKey: "sk-key",
    correctionEnabled: false,
    deviceId: options.deviceId ?? "",
  };

  const voiceInput = {
    onTranscriptionDelta: vi.fn((cb: (payload: { text: string }) => void) => {
      deltaCallback = cb;
      return () => {};
    }),
    onTranscriptionComplete: vi.fn(() => () => {}),
    onParagraphBoundary: vi.fn(() => () => {}),
    onFileTokenResolved: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {}),
    onStatus: vi.fn((cb: (status: string) => void) => {
      statusCallback = cb;
      return () => {};
    }),
    getSettings: vi.fn(async () => ({ ...settings })),
    setSettings: vi.fn(async (patch: { deviceId?: string }) => {
      Object.assign(settings, patch);
    }),
    checkMicPermission: vi.fn().mockResolvedValue("granted"),
    requestMicPermission: vi.fn().mockResolvedValue(true),
    openMicSettings: vi.fn().mockResolvedValue(undefined),
    sendAudioChunk: vi.fn(),
    start: vi.fn().mockResolvedValue({ ok: true }),
    stop: vi.fn().mockResolvedValue(undefined),
  };

  vi.stubGlobal("window", {
    electron: {
      voiceInput,
      systemSleep: { onSuspend: vi.fn(() => () => {}), onWake: vi.fn(() => () => {}) },
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    requestAnimationFrame: vi.fn(),
    cancelAnimationFrame: vi.fn(),
  });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1)
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
      port: { onmessage: null, postMessage: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    workletNodes.push(node);
    return node;
  });

  const getUserMedia = vi.fn(async () => {
    const next = pendingTracks.shift() ?? options.tracks[options.tracks.length - 1]!;
    const track = createTrack(next.label, next.deviceId);
    tracks.push(track);
    return createStream(track);
  });
  const enumerateDevices = vi.fn(async () =>
    (options.devices ?? []).map((device) => ({ ...device, kind: "audioinput", groupId: "" }))
  );
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia,
      enumerateDevices,
      addEventListener: vi.fn((type: string, cb: Listener) => {
        if (type === "devicechange") deviceChangeListeners.add(cb);
      }),
      removeEventListener: vi.fn((type: string, cb: Listener) => {
        if (type === "devicechange") deviceChangeListeners.delete(cb);
      }),
    },
  });

  return {
    tracks,
    workletNodes,
    getUserMedia,
    enumerateDevices,
    deviceChangeListeners,
    voiceInput,
    status: { emit: (status) => statusCallback?.(status) },
    delta: { emit: (text) => deltaCallback?.({ text }) },
    settings,
  };
}

function sendChunk(node: WorkletNode, amplitude: number): void {
  node.port.onmessage?.({ data: new Int16Array(2400).fill(amplitude).buffer });
}

let loadedService: { destroy: () => void } | null = null;

async function load() {
  const { useVoiceRecordingStore } = await import("@/store/voiceRecordingStore");
  const { voiceRecordingService } = await import("../VoiceRecordingService");
  loadedService = voiceRecordingService;
  return { store: useVoiceRecordingStore, service: voiceRecordingService };
}

const BUILT_IN = { deviceId: "builtin", label: "MacBook Pro Microphone" };
const AIRPODS = { deviceId: "airpods", label: "Greg's AirPods Pro" };

describe("VoiceRecordingService — microphone devices (#14606)", () => {
  beforeEach(() => {
    vi.resetModules();
    draftState.draft = "";
  });

  afterEach(async () => {
    loadedService?.destroy();
    loadedService = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("ends the session when the microphone is lost mid-dictation, keeping what was transcribed", async () => {
    const harness = setupGlobals({ tracks: [{ label: "AirPods Pro", deviceId: "airpods" }] });
    const { store, service } = await load();

    await service.start(TARGET);
    harness.status.emit("recording");
    sendChunk(harness.workletNodes[0]!, 3000);
    expect(store.getState().micSignal).toBe("live");
    harness.delta.emit("hello world");

    harness.tracks[0]!.end();

    await vi.waitFor(() => expect(store.getState().status).toBe("idle"));
    // A graceful drain, so audio already sent still comes back as text.
    expect(harness.voiceInput.stop).toHaveBeenCalledTimes(1);
    expect(draftState.draft).toBe("hello world");
    expect(store.getState().activeTarget).toBeNull();
    expect(store.getState().elapsedSeconds).toBe(0);
    expect(store.getState().micNotice).toEqual({
      kind: "lost",
      target: expect.objectContaining({ panelId: PANEL_ID }),
      deviceLabel: "AirPods Pro",
    });
    expect(store.getState().announcement?.text).toBe(
      "Dictation stopped because the microphone was lost."
    );
  });

  it("ends a paused session too, and only once however often the track reports it", async () => {
    const harness = setupGlobals({ tracks: [{ label: "USB Mic", deviceId: "usb" }] });
    const { store, service } = await load();

    await service.start(TARGET);
    harness.status.emit("recording");
    sendChunk(harness.workletNodes[0]!, 3000);
    service.pause();
    expect(store.getState().status).toBe("paused");

    harness.tracks[0]!.end();
    harness.tracks[0]!.end();

    await vi.waitFor(() => expect(store.getState().status).toBe("idle"));
    expect(harness.voiceInput.stop).toHaveBeenCalledTimes(1);
    expect(store.getState().micNotice?.kind).toBe("lost");
  });

  it("says nothing about a lost mic when the user stopped dictation", async () => {
    const harness = setupGlobals({ tracks: [{ label: "USB Mic", deviceId: "usb" }] });
    const { store, service } = await load();

    await service.start(TARGET);
    sendChunk(harness.workletNodes[0]!, 3000);
    await service.stop();
    // The track listeners went with the session.
    harness.tracks[0]!.end();

    expect(harness.voiceInput.stop).toHaveBeenCalledTimes(1);
    expect(store.getState().micNotice).toBeNull();
  });

  it("leaves a stop already in flight to finish the session", async () => {
    const harness = setupGlobals({ tracks: [{ label: "USB Mic", deviceId: "usb" }] });
    let releaseDrain: () => void = () => {};
    harness.voiceInput.stop.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseDrain = resolve;
      })
    );
    const { store, service } = await load();

    await service.start(TARGET);
    const stopping = service.stop();
    harness.tracks[0]!.end();
    releaseDrain();
    await stopping;

    expect(harness.voiceInput.stop).toHaveBeenCalledTimes(1);
    expect(store.getState().micNotice).toBeNull();
  });

  it("never begins a session on a mic that was lost while it opened", async () => {
    const harness = setupGlobals({ tracks: [{ label: "AirPods Pro", deviceId: "airpods" }] });
    harness.getUserMedia.mockImplementationOnce(async () => {
      const track = createTrack("AirPods Pro", "airpods");
      track.readyState = "ended";
      harness.tracks.push(track);
      return createStream(track);
    });
    const { store, service } = await load();

    await service.start(TARGET);

    expect(harness.voiceInput.start).not.toHaveBeenCalled();
    expect(harness.tracks[0]!.stop).toHaveBeenCalled();
    expect(store.getState().status).toBe("error");
    expect(store.getState().lastError?.code).toBe("mic_lost");
    expect(store.getState().micNotice).toMatchObject({ kind: "lost", deviceLabel: "AirPods Pro" });
  });
});

describe("VoiceRecordingService — chosen mic not available (#14606)", () => {
  beforeEach(() => {
    vi.resetModules();
    draftState.draft = "";
  });

  afterEach(() => {
    loadedService?.destroy();
    loadedService = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("says which mic is in use when the chosen one isn't there", async () => {
    const harness = setupGlobals({
      deviceId: "usb-mic",
      tracks: [{ label: "Default - MacBook Pro Microphone", deviceId: "builtin" }],
    });
    const { store, service } = await load();

    await service.start(TARGET);

    // Still asked for as a preference, never forced.
    expect(harness.getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { ideal: "usb-mic" } },
      video: false,
    });
    expect(store.getState().micNotice).toEqual({
      kind: "fallback",
      target: expect.objectContaining({ panelId: PANEL_ID }),
      deviceLabel: "MacBook Pro Microphone",
    });
    expect(store.getState().micDeviceLabel).toBe("MacBook Pro Microphone");

    sendChunk(harness.workletNodes[0]!, 3000);
    expect(store.getState().announcement?.text).toBe(
      "Dictation started in Claude, using MacBook Pro Microphone."
    );
  });

  it.each([
    ["the chosen mic opens", "usb-mic", "usb-mic"],
    ["no mic is chosen", "", "builtin"],
    ["the system default is chosen", "default", "builtin"],
  ])("raises no notice when %s", async (_case, chosen, actual) => {
    setupGlobals({ deviceId: chosen, tracks: [{ label: "Some Mic", deviceId: actual }] });
    const { store, service } = await load();

    await service.start(TARGET);

    expect(store.getState().micNotice).toBeNull();
    expect(store.getState().micDeviceLabel).toBe("Some Mic");
  });
});

describe("VoiceRecordingService — silent mic (#14606)", () => {
  beforeEach(() => {
    vi.resetModules();
    draftState.draft = "";
    vi.useFakeTimers();
  });

  afterEach(() => {
    loadedService?.destroy();
    loadedService = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function startSilent(
    track: { label: string; deviceId: string },
    devices: Array<{ deviceId: string; label: string }> = []
  ) {
    const harness = setupGlobals({ tracks: [track, BUILT_IN], devices });
    const loaded = await load();
    await loaded.service.start(TARGET);
    harness.status.emit("recording");
    sendChunk(harness.workletNodes[0]!, 0);
    await vi.advanceTimersByTimeAsync(3_000);
    return { harness, ...loaded };
  }

  it("names a silent Bluetooth mic and offers the built-in one", async () => {
    const { store } = await startSilent(AIRPODS, [
      { deviceId: "default", label: "Default - Greg's AirPods Pro" },
      AIRPODS,
      BUILT_IN,
    ]);

    expect(store.getState().micSignal).toBe("silent");
    expect(store.getState().announcement?.text).toBe("No audio from Greg's AirPods Pro yet.");
    expect(store.getState().micNotice).toEqual({
      kind: "silent",
      target: expect.objectContaining({ panelId: PANEL_ID }),
      deviceLabel: "Greg's AirPods Pro",
      bluetooth: true,
      builtIn: BUILT_IN,
    });
  });

  it("names a silent wired mic without listing devices", async () => {
    const { store, harness } = await startSilent({ label: "Blue Yeti", deviceId: "yeti" });

    expect(harness.enumerateDevices).not.toHaveBeenCalled();
    expect(store.getState().micNotice).toMatchObject({
      kind: "silent",
      deviceLabel: "Blue Yeti",
      bluetooth: false,
      builtIn: null,
    });
  });

  it("clears the warning once real audio arrives", async () => {
    const { store, harness } = await startSilent(AIRPODS, [AIRPODS, BUILT_IN]);
    expect(store.getState().micNotice?.kind).toBe("silent");

    sendChunk(harness.workletNodes[0]!, 3000);

    expect(store.getState().micSignal).toBe("live");
    expect(store.getState().micNotice).toBeNull();
  });

  it("drops a device list that comes back after the session ended", async () => {
    const harness = setupGlobals({ tracks: [AIRPODS], devices: [AIRPODS, BUILT_IN] });
    let releaseDevices: () => void = () => {};
    harness.enumerateDevices.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDevices = () => resolve([{ ...BUILT_IN, kind: "audioinput", groupId: "" }]);
        })
    );
    const { store, service } = await load();
    await service.start(TARGET);
    harness.status.emit("recording");
    await vi.advanceTimersByTimeAsync(3_000);

    await service.stop();
    releaseDevices();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getState().micNotice).toBeNull();
  });

  it("switches to the built-in mic: saves it and restarts the session on it", async () => {
    const { store, service, harness } = await startSilent(AIRPODS, [AIRPODS, BUILT_IN]);
    const notice = store.getState().micNotice!;

    await service.switchToMicFromNotice(notice);

    expect(harness.voiceInput.setSettings).toHaveBeenCalledWith({ deviceId: "builtin" });
    expect(harness.getUserMedia).toHaveBeenLastCalledWith({
      audio: { deviceId: { ideal: "builtin" } },
      video: false,
    });
    // The silent session drained; the new one runs on the same pane.
    expect(harness.voiceInput.stop).toHaveBeenCalledTimes(1);
    expect(harness.voiceInput.start).toHaveBeenCalledTimes(2);
    expect(store.getState().activeTarget?.panelId).toBe(PANEL_ID);
    expect(store.getState().micDeviceLabel).toBe("MacBook Pro Microphone");
    expect(store.getState().micNotice).toBeNull();
  });

  it("saves the choice but restarts nothing once the session has ended", async () => {
    const { store, service, harness } = await startSilent(AIRPODS, [AIRPODS, BUILT_IN]);
    const notice = store.getState().micNotice!;
    let releaseSave: () => void = () => {};
    harness.voiceInput.setSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve;
        })
    );

    const switching = service.switchToMicFromNotice(notice);
    await service.stop();
    releaseSave();
    await switching;

    expect(harness.voiceInput.setSettings).toHaveBeenCalledWith({ deviceId: "builtin" });
    expect(harness.getUserMedia).toHaveBeenCalledTimes(1);
    expect(store.getState().activeTarget).toBeNull();
  });

  it("ignores a notice that is no longer showing", async () => {
    const { store, service, harness } = await startSilent(AIRPODS, [AIRPODS, BUILT_IN]);
    const notice = store.getState().micNotice!;
    store.getState().dismissMicNotice(notice);

    await service.switchToMicFromNotice(notice);

    expect(harness.voiceInput.setSettings).not.toHaveBeenCalled();
  });
});
