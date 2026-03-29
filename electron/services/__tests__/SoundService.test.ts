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

vi.mock("fs", () => ({
  default: fsMock,
  ...fsMock,
}));

vi.mock("electron", () => ({
  ...appMock,
}));

vi.mock("../../utils/soundPlayer.js", () => ({
  playSound: mockPlaySound,
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

  it("resolves sounds directory from app path in dev mode", () => {
    soundService.play("chime");

    expect(fsMock.existsSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join("electron", "resources", "sounds"))
    );
  });

  it("resolves sounds directory from resourcesPath in packaged mode", async () => {
    appMock.app.isPackaged = true;
    vi.resetModules();
    const mod = await import("../SoundService.js");
    mod.soundService.play("chime");

    expect(fsMock.existsSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join("resources", "sounds"))
    );
  });

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

  it("reads variants from the correct directory in packaged mode", async () => {
    appMock.app.isPackaged = true;
    vi.resetModules();
    const mod = await import("../SoundService.js");
    mod.soundService.getVariants("chime.wav");

    expect(fsMock.readdirSync).toHaveBeenCalledWith(path.join("/app/resources", "sounds"));
  });

  it("cancel is a no-op when no sound is playing", () => {
    expect(() => soundService.cancel()).not.toThrow();
  });

  it("preview plays the base file without variant selection and bypasses dampening", () => {
    soundService.play("error");
    vi.advanceTimersByTime(50);

    soundService.preview("error");

    expect(mockPlaySound).toHaveBeenCalledTimes(2);
    expect(mockPlaySound.mock.calls[1][1]).toBeUndefined();
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

  it("allows up to 3 concurrent voices", () => {
    soundService.play("error");
    soundService.play("waiting");
    soundService.play("ping");
    expect(mockPlaySound).toHaveBeenCalledTimes(3);
  });

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
    vi.advanceTimersByTime(200);
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
