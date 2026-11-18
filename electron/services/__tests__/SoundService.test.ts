import path from "path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn<(p: string) => boolean>(() => true),
  readdirSync: vi.fn<(p: string) => string[]>(() => [
    "chime.wav",
    "chime.v1.wav",
    "chime.v2.wav",
    "chime.v3.wav",
    "complete.wav",
    "complete.v1.wav",
    "complete.v2.wav",
    "complete.v3.wav",
    "error.wav",
    "ping.wav",
    "ping.v1.wav",
    "ping.v2.wav",
    "ping.v3.wav",
    "waiting.wav",
    "waiting.v1.wav",
    "waiting.v2.wav",
    "waiting.v3.wav",
  ]),
}));

const mockCancel = vi.fn();
const mockPlaySound = vi.fn<(filePath: string, volume?: number) => { cancel: () => void }>(() => ({
  cancel: mockCancel,
}));

const appMock = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => "/repo"),
  },
}));

const mockBroadcastToRenderer = vi.hoisted(() => vi.fn());
const mockSendToOneVisibleRenderer = vi.hoisted(() => vi.fn());
const mockBroadcastToVisibleRenderers = vi.hoisted(() => vi.fn());
const mockGetAllWindows = vi.hoisted(() => vi.fn<() => unknown[]>(() => []));
const notificationSettings = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const customSoundsMock = vi.hoisted(() => ({
  isPlayableCustomSound: vi.fn<(id: string) => boolean>(() => false),
  resolveCustomSoundPath: vi.fn<(id: string) => string | null>(() => null),
}));

vi.mock("../../store.js", () => ({
  store: {
    get: (key: string) =>
      key === "notificationSettings" ? notificationSettings.current : undefined,
  },
}));

vi.mock("../customNotificationSounds.js", () => customSoundsMock);

vi.mock("fs", () => ({
  default: fsMock,
  ...fsMock,
}));

vi.mock("electron", () => ({
  ...appMock,
  BrowserWindow: { getAllWindows: mockGetAllWindows },
}));

vi.mock("../../utils/soundPlayer.js", () => ({
  playSound: mockPlaySound,
}));

vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: mockBroadcastToRenderer,
  broadcastToVisibleRenderers: mockBroadcastToVisibleRenderers,
  sendToOneVisibleRenderer: mockSendToOneVisibleRenderer,
}));

const originalResourcesPath = process.resourcesPath;

let soundService: Awaited<typeof import("../SoundService.js")>["soundService"];

describe("SoundService", () => {
  afterAll(() => {
    Object.defineProperty(process, "resourcesPath", {
      value: originalResourcesPath,
      writable: true,
      configurable: true,
    });
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.resetAllMocks();
    fsMock.existsSync.mockImplementation(() => true);
    fsMock.readdirSync.mockImplementation(() => [
      "chime.wav",
      "chime.v1.wav",
      "chime.v2.wav",
      "chime.v3.wav",
      "complete.wav",
      "complete.v1.wav",
      "complete.v2.wav",
      "complete.v3.wav",
      "error.wav",
      "ping.wav",
      "ping.v1.wav",
      "ping.v2.wav",
      "ping.v3.wav",
      "waiting.wav",
      "waiting.v1.wav",
      "waiting.v2.wav",
      "waiting.v3.wav",
    ]);
    mockPlaySound.mockImplementation(() => ({ cancel: mockCancel }));
    appMock.app.isPackaged = false;
    appMock.app.getAppPath.mockReturnValue("/repo");
    mockGetAllWindows.mockReturnValue([]);
    mockSendToOneVisibleRenderer.mockReset();
    mockSendToOneVisibleRenderer.mockReturnValue(true);
    notificationSettings.current = {};
    customSoundsMock.isPlayableCustomSound.mockReturnValue(false);
    customSoundsMock.resolveCustomSoundPath.mockReturnValue(null);
    Object.defineProperty(process, "resourcesPath", {
      value: "/app/resources",
      writable: true,
      configurable: true,
    });
    const mod = await import("../SoundService.js");
    soundService = mod.soundService;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -- Web Audio IPC routing --

  it("routes sound:trigger to one renderer, never a broadcast", () => {
    mockGetAllWindows.mockReturnValue([{ id: 1 }, { id: 2 }]);

    soundService.preview("error");

    expect(mockSendToOneVisibleRenderer).toHaveBeenCalledTimes(1);
    expect(mockSendToOneVisibleRenderer).toHaveBeenCalledWith("sound:trigger", {
      soundFile: "error.wav",
      volume: 1,
    });
    // A visible-only broadcast still reaches every window's shown view (#15682).
    expect(mockBroadcastToVisibleRenderers).not.toHaveBeenCalled();
    expect(mockBroadcastToRenderer).not.toHaveBeenCalled();
    expect(mockPlaySound).not.toHaveBeenCalled();
  });

  it("falls back to native playback when a window has no eligible renderer", () => {
    mockGetAllWindows.mockReturnValue([{ id: 1 }]);
    mockSendToOneVisibleRenderer.mockReturnValue(false);

    soundService.play("error");

    expect(mockSendToOneVisibleRenderer).toHaveBeenCalledTimes(1);
    expect(mockPlaySound).toHaveBeenCalledTimes(1);
    expect(mockBroadcastToRenderer).not.toHaveBeenCalled();
    expect(mockBroadcastToVisibleRenderers).not.toHaveBeenCalled();
  });

  it("falls back to native playback for previews and pulses when delivery fails", () => {
    mockGetAllWindows.mockReturnValue([{ id: 1 }]);
    mockSendToOneVisibleRenderer.mockReturnValue(false);

    soundService.preview("error");
    soundService.playPulse("pulse.wav");

    expect(mockSendToOneVisibleRenderer).toHaveBeenCalledTimes(2);
    expect(mockPlaySound).toHaveBeenCalledTimes(2);
    expect(mockBroadcastToRenderer).not.toHaveBeenCalled();
    expect(mockBroadcastToVisibleRenderers).not.toHaveBeenCalled();
  });

  it("does not play natively when a renderer received the trigger", () => {
    mockGetAllWindows.mockReturnValue([{ id: 1 }]);
    mockSendToOneVisibleRenderer.mockReturnValue(true);

    soundService.play("error");
    soundService.preview("chime");

    expect(mockPlaySound).not.toHaveBeenCalled();
  });

  it("falls back to OS process when no windows are open", () => {
    mockGetAllWindows.mockReturnValue([]);

    soundService.play("error");

    expect(mockPlaySound).toHaveBeenCalled();
    expect(mockBroadcastToRenderer).not.toHaveBeenCalled();
    expect(mockSendToOneVisibleRenderer).not.toHaveBeenCalled();
  });

  it("cancel sends sound:cancel IPC via broadcast when renderer windows exist", () => {
    mockGetAllWindows.mockReturnValue([{ id: 1 }]);

    soundService.cancel();

    expect(mockBroadcastToRenderer).toHaveBeenCalledWith("events:push", {
      name: "sound:cancel",
      payload: undefined,
    });
    // Cancel must reach cached views and every window — see the WHY in SoundService.cancel().
    expect(mockSendToOneVisibleRenderer).not.toHaveBeenCalled();
    expect(mockBroadcastToVisibleRenderers).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it("cancel cancels OS-fallback voices only when no renderer is present", () => {
    mockGetAllWindows.mockReturnValue([]);
    soundService.play("error");
    vi.advanceTimersByTime(200);
    soundService.play("ping");

    expect(mockPlaySound).toHaveBeenCalledTimes(2);

    soundService.cancel();

    expect(mockCancel).toHaveBeenCalled();
    expect(mockBroadcastToRenderer).not.toHaveBeenCalledWith(
      "events:push",
      expect.objectContaining({ name: "sound:cancel" })
    );
  });

  it("cancel cancels OS-fallback voices even when a renderer window has since opened", () => {
    // Voices started while no window existed must be cleaned up regardless of
    // whether a window opens before cancel is called.
    mockGetAllWindows.mockReturnValue([]);
    soundService.play("error");
    vi.advanceTimersByTime(200);
    soundService.play("ping");
    expect(mockPlaySound).toHaveBeenCalledTimes(2);

    mockGetAllWindows.mockReturnValue([{ id: 1 }]);
    soundService.cancel();

    expect(mockCancel).toHaveBeenCalled();
    expect(mockBroadcastToRenderer).toHaveBeenCalledWith("events:push", {
      name: "sound:cancel",
      payload: undefined,
    });
  });

  it("preview sends the base file without variant selection via IPC", () => {
    mockGetAllWindows.mockReturnValue([{ id: 1 }]);

    soundService.preview("chime");

    expect(mockSendToOneVisibleRenderer).toHaveBeenCalledWith("sound:trigger", {
      soundFile: "chime.wav",
      volume: 1,
    });
  });

  it("routes dampened sound:trigger to one renderer, never a broadcast", () => {
    mockGetAllWindows.mockReturnValue([{ id: 1 }, { id: 2 }]);

    soundService.play("error");

    expect(mockSendToOneVisibleRenderer).toHaveBeenCalledTimes(1);
    expect(mockSendToOneVisibleRenderer).toHaveBeenCalledWith("sound:trigger", {
      soundFile: "error.wav",
      volume: 1,
    });
    // Catches an accidental dual-send, which the positive assertion alone would not.
    expect(mockBroadcastToVisibleRenderers).not.toHaveBeenCalled();
    expect(mockBroadcastToRenderer).not.toHaveBeenCalled();
    expect(mockPlaySound).not.toHaveBeenCalled();
  });

  it("does not stat the sound file when routing to the renderer", () => {
    mockGetAllWindows.mockReturnValue([{ id: 1 }]);
    fsMock.existsSync.mockClear();

    soundService.play("error");
    soundService.preview("chime");

    expect(fsMock.existsSync).not.toHaveBeenCalled();
  });

  // -- Pulse detune forwarding --

  it("playPulse forwards detune in the sound:trigger payload when renderer is available", () => {
    mockGetAllWindows.mockReturnValue([{ id: 1 }]);

    soundService.playPulse("pulse.wav", 12);

    expect(mockSendToOneVisibleRenderer).toHaveBeenCalledWith("sound:trigger", {
      soundFile: "pulse.wav",
      detune: 12,
      volume: 1,
    });
    expect(mockPlaySound).not.toHaveBeenCalled();
  });

  it("playPulse omits detune from the payload when not provided", () => {
    mockGetAllWindows.mockReturnValue([{ id: 1 }]);

    soundService.playPulse("pulse.wav");

    expect(mockSendToOneVisibleRenderer).toHaveBeenCalledWith("sound:trigger", {
      soundFile: "pulse.wav",
      volume: 1,
    });
  });

  it("playPulse preserves an explicit detune of 0 in the payload", () => {
    mockGetAllWindows.mockReturnValue([{ id: 1 }]);

    soundService.playPulse("pulse.wav", 0);

    expect(mockSendToOneVisibleRenderer).toHaveBeenCalledWith("sound:trigger", {
      soundFile: "pulse.wav",
      detune: 0,
      volume: 1,
    });
  });

  it("playPulse falls back to OS process without detune when no renderer", () => {
    mockGetAllWindows.mockReturnValue([]);
    notificationSettings.current = { soundVolume: 0.6 };

    soundService.playPulse("pulse.wav", 12);

    expect(mockBroadcastToRenderer).not.toHaveBeenCalled();
    expect(mockSendToOneVisibleRenderer).not.toHaveBeenCalled();
    // The OS player gets the volume setting, but no detune.
    expect(mockPlaySound).toHaveBeenCalledWith(expect.stringContaining("pulse.wav"), 0.6);
  });

  // -- Volume setting --

  it("scales the repeat decay by the volume setting", () => {
    notificationSettings.current = { soundVolume: 0.4 };
    mockGetAllWindows.mockReturnValue([{ id: 1 }]);

    soundService.play("error");
    vi.advanceTimersByTime(200);
    soundService.play("ping");

    expect(mockSendToOneVisibleRenderer.mock.calls[0][1]).toEqual({
      soundFile: "error.wav",
      volume: 0.4,
    });
    expect(mockSendToOneVisibleRenderer.mock.calls[1][1].volume).toBeCloseTo(0.28);
  });

  it("applies the decay floor before the setting, so a quiet setting goes below it", () => {
    notificationSettings.current = { soundVolume: 0.5 };
    for (let i = 0; i < 10; i++) {
      soundService.play("error");
      vi.advanceTimersByTime(200);
    }

    const lastCall = mockPlaySound.mock.calls[mockPlaySound.mock.calls.length - 1];
    expect(lastCall[1]).toBeCloseTo(0.05);
  });

  it("plays a completion chord at the setting's level", () => {
    notificationSettings.current = { soundVolume: 0.3 };
    soundService.play("complete");
    vi.advanceTimersByTime(500);
    soundService.play("complete");

    expect(mockPlaySound.mock.calls[1][1]).toBeCloseTo(0.3);
  });

  it("previews at the setting's level, so a preview sounds like the notification", () => {
    notificationSettings.current = { soundVolume: 0.25 };
    mockGetAllWindows.mockReturnValue([{ id: 1 }]);

    soundService.previewFile("waiting.wav");

    expect(mockSendToOneVisibleRenderer).toHaveBeenCalledWith("sound:trigger", {
      soundFile: "waiting.wav",
      volume: 0.25,
    });
  });

  it.each([
    ["dampened", () => soundService.play("error")],
    ["preview", () => soundService.previewFile("error.wav")],
    ["pulse", () => soundService.playPulse("pulse.wav", 5)],
  ])("plays nothing at zero volume (%s), even on players with no volume control", (_, play) => {
    notificationSettings.current = { soundVolume: 0 };
    mockGetAllWindows.mockReturnValue([{ id: 1 }]);
    play();
    mockGetAllWindows.mockReturnValue([]);
    vi.advanceTimersByTime(500);
    play();

    expect(mockSendToOneVisibleRenderer).not.toHaveBeenCalled();
    expect(mockPlaySound).not.toHaveBeenCalled();
  });

  it("reads the setting on every play, and muted plays leave no trace in throttle or decay", () => {
    mockGetAllWindows.mockReturnValue([{ id: 1 }]);
    notificationSettings.current = { soundVolume: 0 };
    soundService.playFile("waiting.wav");
    soundService.play("complete");

    vi.advanceTimersByTime(100);
    notificationSettings.current = { soundVolume: 0.6 };
    soundService.playFile("error.wav");
    vi.advanceTimersByTime(500);
    soundService.play("complete");

    expect(mockSendToOneVisibleRenderer).toHaveBeenCalledTimes(2);
    // Neither the throttle, the decay nor the chord counted the muted plays.
    expect(mockSendToOneVisibleRenderer.mock.calls[0][1]).toMatchObject({
      soundFile: "error.wav",
      volume: 0.6,
    });
    expect(mockSendToOneVisibleRenderer.mock.calls[1][1].volume).toBeCloseTo(0.42);
  });

  it.each([
    [undefined, 1],
    ["loud", 1],
    [Number.NaN, 1],
    [1.8, 1],
    [-1, 0],
  ])("reads a stored volume of %s as %s", (stored, expected) => {
    notificationSettings.current = { soundVolume: stored };
    mockGetAllWindows.mockReturnValue([{ id: 1 }]);

    soundService.previewFile("chime.wav");

    if (expected === 0) {
      expect(mockSendToOneVisibleRenderer).not.toHaveBeenCalled();
    } else {
      expect(mockSendToOneVisibleRenderer.mock.calls[0][1].volume).toBe(expected);
    }
  });

  // -- Imported sounds --

  const CUSTOM_ID = "custom:0b7c9a7e-4f1d-4c2a-9e3b-1a2b3c4d5e6f";
  const CUSTOM_PATH = "/user-data/sounds/custom/0b7c9a7e-4f1d-4c2a-9e3b-1a2b3c4d5e6f.wav";

  function registerImport(id = CUSTOM_ID, filePath = CUSTOM_PATH) {
    customSoundsMock.resolveCustomSoundPath.mockImplementation((v) => (v === id ? filePath : null));
    customSoundsMock.isPlayableCustomSound.mockImplementation((v) => v === id);
  }

  it("sends a registered import to the renderer by id, with no variant lookup", () => {
    registerImport();
    mockGetAllWindows.mockReturnValue([{ id: 1 }]);
    fsMock.readdirSync.mockClear();

    soundService.playFile(CUSTOM_ID);

    expect(mockSendToOneVisibleRenderer).toHaveBeenCalledWith("sound:trigger", {
      soundFile: CUSTOM_ID,
      volume: 1,
    });
    expect(fsMock.readdirSync).not.toHaveBeenCalled();
  });

  it("plays a registered import from its own path when no window is open", () => {
    registerImport();
    notificationSettings.current = { soundVolume: 0.5 };

    soundService.previewFile(CUSTOM_ID);
    vi.advanceTimersByTime(500);
    soundService.playFile(CUSTOM_ID);

    expect(mockPlaySound).toHaveBeenNthCalledWith(1, CUSTOM_PATH, 0.5);
    expect(mockPlaySound).toHaveBeenNthCalledWith(2, CUSTOM_PATH, 0.5);
  });

  it("plays nothing for an import that isn't registered or whose file is gone", () => {
    customSoundsMock.resolveCustomSoundPath.mockReturnValue(null);

    for (const windows of [[{ id: 1 }], []]) {
      mockGetAllWindows.mockReturnValue(windows);
      soundService.playFile(CUSTOM_ID);
      soundService.previewFile(CUSTOM_ID);
      soundService.playPulse(CUSTOM_ID);
      vi.advanceTimersByTime(500);
    }

    expect(mockSendToOneVisibleRenderer).not.toHaveBeenCalled();
    expect(mockPlaySound).not.toHaveBeenCalled();
  });

  it("pulses a registered import with its detune and the volume setting", () => {
    registerImport();
    notificationSettings.current = { soundVolume: 0.5 };
    mockGetAllWindows.mockReturnValue([{ id: 1 }]);

    soundService.playPulse(CUSTOM_ID, -7);

    expect(mockSendToOneVisibleRenderer).toHaveBeenCalledWith("sound:trigger", {
      soundFile: CUSTOM_ID,
      detune: -7,
      volume: 0.5,
    });
  });

  it("keeps an import's OS voice cancellable for its whole length, past the bundled 600 ms", () => {
    registerImport();
    const importCancel = vi.fn();
    mockPlaySound.mockImplementationOnce(() => ({ cancel: importCancel }));

    soundService.playFile(CUSTOM_ID);
    vi.advanceTimersByTime(700);
    soundService.play("error");
    soundService.cancel();

    expect(importCancel).toHaveBeenCalled();
  });

  it("allows bundled files and playable imports, checked live, and nothing else", async () => {
    const { PLAYABLE_SOUND_FILES } = await import("../SoundService.js");
    const unregistered = "custom:11111111-2222-4333-8444-555555555555";
    registerImport();

    expect(PLAYABLE_SOUND_FILES.has("waiting.wav")).toBe(true);
    expect(PLAYABLE_SOUND_FILES.has(CUSTOM_ID)).toBe(true);
    expect(PLAYABLE_SOUND_FILES.has(unregistered)).toBe(false);
    expect(PLAYABLE_SOUND_FILES.has("../waiting.wav")).toBe(false);

    registerImport(unregistered);
    expect(PLAYABLE_SOUND_FILES.has(unregistered)).toBe(true);
    expect(PLAYABLE_SOUND_FILES.has(CUSTOM_ID)).toBe(false);
  });

  it("drops a file Main doesn't know without taking the next file's turn", () => {
    mockGetAllWindows.mockReturnValue([{ id: 1 }]);

    soundService.playFile("../../etc/evil.wav");
    soundService.previewFile("../../etc/evil.wav");
    soundService.playPulse("../../etc/evil.wav");
    soundService.playFile("waiting.wav");

    expect(mockSendToOneVisibleRenderer).toHaveBeenCalledTimes(1);
    expect(mockSendToOneVisibleRenderer.mock.calls[0][1].soundFile).toMatch(/^waiting/);
  });

  // -- Path resolution --

  it("calls playSound with the correct path when file exists", () => {
    soundService.play("error");

    expect(mockPlaySound).toHaveBeenCalledWith(
      path.join("/repo", "electron", "resources", "sounds", "error.wav"),
      expect.any(Number)
    );
  });

  it("does not call playSound when file does not exist", () => {
    fsMock.existsSync.mockReturnValue(false);
    soundService.play("chime");

    expect(mockPlaySound).not.toHaveBeenCalled();
  });

  it("discovers and uses variants from the sounds directory", () => {
    const variants = soundService.getVariants("chime.wav");
    expect(variants).toEqual(["chime.v1.wav", "chime.v2.wav", "chime.v3.wav", "chime.wav"]);
  });

  it("scans the sounds directory exactly once at module load, not per sound", () => {
    // initVariantCache pre-populates every SOUND_FILES entry from a single
    // readdirSync, so getVariants for known sounds must not trigger additional scans.
    const callsAfterInit = fsMock.readdirSync.mock.calls.length;

    soundService.getVariants("chime.wav");
    soundService.getVariants("error.wav");
    soundService.getVariants("complete.wav");
    soundService.getVariants("ping.wav");
    soundService.getVariants("waiting.wav");

    expect(fsMock.readdirSync.mock.calls.length).toBe(callsAfterInit);
    expect(callsAfterInit).toBe(1);
  });

  it("reads variants from the correct directory in packaged mode", async () => {
    appMock.app.isPackaged = true;
    vi.resetModules();
    const mod = await import("../SoundService.js");
    mod.soundService.getVariants("chime.wav");

    expect(fsMock.readdirSync).toHaveBeenCalledWith(path.join("/app/resources", "sounds"));
  });

  it("preview plays the base file without variant selection and bypasses dampening", () => {
    soundService.play("error");
    vi.advanceTimersByTime(50);

    soundService.preview("error");

    expect(mockPlaySound).toHaveBeenCalledTimes(2);
    // No repeat decay: the second play is still at the setting's full level.
    expect(mockPlaySound.mock.calls[1][1]).toBe(1);
  });

  it("previewFile bypasses dampening", () => {
    soundService.play("error");
    vi.advanceTimersByTime(50);

    soundService.previewFile("error.wav");
    expect(mockPlaySound).toHaveBeenCalledTimes(2);
  });

  // -- Debounce --

  it("drops same sound within 150ms debounce window", () => {
    soundService.play("error");
    expect(mockPlaySound).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    soundService.play("error");
    expect(mockPlaySound).toHaveBeenCalledTimes(1);
  });

  it("plays same sound after debounce window expires", () => {
    soundService.play("error");
    expect(mockPlaySound).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(150);
    soundService.play("error");
    expect(mockPlaySound).toHaveBeenCalledTimes(2);
  });

  it("debounces same SoundId even when variant differs", () => {
    soundService.play("chime");
    expect(mockPlaySound).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(50);
    soundService.play("chime"); // different variant but same base — debounced
    expect(mockPlaySound).toHaveBeenCalledTimes(1);
  });

  it("allows different sounds within debounce window", () => {
    soundService.play("error");
    soundService.play("ping");
    expect(mockPlaySound).toHaveBeenCalledTimes(2);
  });

  // -- Exponential volume decay --

  it("applies exponential volume decay for consecutive sounds", () => {
    soundService.play("error");
    vi.advanceTimersByTime(200);
    soundService.play("ping");
    vi.advanceTimersByTime(200);
    soundService.play("waiting");

    expect(mockPlaySound).toHaveBeenCalledTimes(3);
    expect(mockPlaySound.mock.calls[0][1]).toBe(1);
    expect(mockPlaySound.mock.calls[1][1]).toBeCloseTo(0.7);
    expect(mockPlaySound.mock.calls[2][1]).toBeCloseTo(0.49);
  });

  it("clamps volume at floor of 0.1", () => {
    for (let i = 0; i < 10; i++) {
      soundService.play("error");
      vi.advanceTimersByTime(200);
    }

    const lastCall = mockPlaySound.mock.calls[mockPlaySound.mock.calls.length - 1];
    expect(lastCall[1]).toBeCloseTo(0.1);
  });

  it("resets volume after 2s silence", () => {
    soundService.play("error");
    vi.advanceTimersByTime(200);
    soundService.play("ping");

    expect(mockPlaySound.mock.calls[1][1]).toBeCloseTo(0.7);

    vi.advanceTimersByTime(2001);
    soundService.play("waiting");

    expect(mockPlaySound.mock.calls[2][1]).toBe(1);
  });

  // -- Concurrent voices --

  it("drops new sound when all 3 voice slots are taken by higher priority", () => {
    // Fill all 3 slots with high-priority sounds
    soundService.play("error"); // priority 1
    vi.advanceTimersByTime(200);
    soundService.play("error"); // priority 1 (debounce expired)
    vi.advanceTimersByTime(200);
    soundService.play("waiting"); // priority 2

    expect(mockPlaySound).toHaveBeenCalledTimes(3);

    // Pool full: [1, 1, 2]. Ping (priority 4) can't evict any — dropped
    vi.advanceTimersByTime(10);
    soundService.play("ping");
    expect(mockPlaySound).toHaveBeenCalledTimes(3);
  });

  it("evicts lowest-priority voice for higher-priority incoming sound", () => {
    soundService.play("ping"); // priority 4
    vi.advanceTimersByTime(10);
    soundService.play("waiting"); // priority 2
    vi.advanceTimersByTime(10);
    soundService.play("chime"); // priority 3
    vi.advanceTimersByTime(10);

    expect(mockPlaySound).toHaveBeenCalledTimes(3);

    // Pool full: [4, 2, 3]. Error (priority 1) should evict ping (priority 4)
    soundService.play("error");
    expect(mockPlaySound).toHaveBeenCalledTimes(4);
    expect(mockCancel).toHaveBeenCalled();
  });

  it("prunes stale voices after 600ms", () => {
    soundService.play("error"); // slot 1
    vi.advanceTimersByTime(200);
    soundService.play("waiting"); // slot 2
    vi.advanceTimersByTime(200);
    soundService.play("ping"); // slot 3

    expect(mockPlaySound).toHaveBeenCalledTimes(3);

    // Advance past MAX_SOUND_DURATION_MS (600ms) from first sound
    vi.advanceTimersByTime(250);
    soundService.play("chime"); // should succeed after pruning
    expect(mockPlaySound).toHaveBeenCalledTimes(4);
  });

  // -- Cancel --

  it("cancels all active voices", () => {
    const cancels: Array<MockInstance> = [];
    mockPlaySound.mockImplementation(() => {
      const c = vi.fn();
      cancels.push(c);
      return { cancel: c };
    });

    soundService.play("error");
    vi.advanceTimersByTime(200);
    soundService.play("ping");

    soundService.cancel();

    for (const c of cancels) {
      expect(c).toHaveBeenCalled();
    }
  });

  // -- Completion chording --

  it("plays chord (full volume) when 2+ completions fire within 2s", () => {
    soundService.play("complete");
    vi.advanceTimersByTime(500);
    soundService.play("complete");

    expect(mockPlaySound).toHaveBeenCalledTimes(2);
    expect(mockPlaySound.mock.calls[1][1]).toBe(1);
  });

  it("does not chord when completions are >2s apart", () => {
    soundService.play("complete");
    vi.advanceTimersByTime(2100);
    soundService.play("complete");

    expect(mockPlaySound).toHaveBeenCalledTimes(2);
    expect(mockPlaySound.mock.calls[0][1]).toBe(1);
    expect(mockPlaySound.mock.calls[1][1]).toBe(1);
  });

  it("resets chord burst after triggering", () => {
    soundService.play("complete");
    vi.advanceTimersByTime(500);
    soundService.play("complete"); // triggers chord
    vi.advanceTimersByTime(500);
    soundService.play("complete"); // first of new burst, not a chord

    expect(mockPlaySound).toHaveBeenCalledTimes(3);
    // Third call: consecutive count is 1 (chord bypassed computeVolume), so decay = 0.7^1 = 0.7
    expect(mockPlaySound.mock.calls[2][1]).toBeCloseTo(0.7);
  });

  // -- playFile dampening --

  it("applies dampening to playFile calls", () => {
    soundService.playFile("complete.wav");
    vi.advanceTimersByTime(300);
    soundService.playFile("complete.wav");

    expect(mockPlaySound).toHaveBeenCalledTimes(2);
    expect(mockPlaySound.mock.calls[1][1]).toBeCloseTo(0.7);
  });

  it("debounces playFile for same resolved file", () => {
    soundService.playFile("error.wav");
    vi.advanceTimersByTime(50);
    soundService.playFile("error.wav");
    expect(mockPlaySound).toHaveBeenCalledTimes(1);
  });
});
