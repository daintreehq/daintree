import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

const systemPreferencesMock = vi.hoisted(() => ({
  getMediaAccessStatus: vi.fn(() => "not-determined"),
  askForMediaAccess: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  systemPreferences: systemPreferencesMock,
  shell: { openExternal: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
}));

const linuxSoundSettingsMock = vi.hoisted(() => ({
  openLinuxSoundSettings: vi.fn<
    (
      desktop: string | undefined,
      onFailure?: (launcher: { command: string }, error: unknown) => void
    ) => Promise<boolean>
  >(async () => true),
}));
vi.mock("../../../services/voice/linuxSoundSettings.js", () => linuxSoundSettingsMock);

const openExternalUrlMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../../../utils/openExternal.js", () => ({ openExternalUrl: openExternalUrlMock }));

const logDebugMock = vi.hoisted(() => vi.fn());
const logWarnMock = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/logger.js", () => ({
  logDebug: logDebugMock,
  logInfo: vi.fn(),
  logWarn: logWarnMock,
  logError: vi.fn(),
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { getCurrentProject: vi.fn(() => null), getCurrentProjectId: vi.fn(() => null) },
}));

vi.mock("../../../store.js", () => ({
  store: { get: vi.fn(() => undefined), set: vi.fn() },
}));

vi.mock("../../channels.js", () => ({
  CHANNELS: {
    VOICE_INPUT_GET_SETTINGS: "voice-input:get-settings",
    VOICE_INPUT_SET_SETTINGS: "voice-input:set-settings",
    VOICE_INPUT_START: "voice-input:start",
    VOICE_INPUT_STOP: "voice-input:stop",
    VOICE_INPUT_AUDIO_CHUNK: "voice-input:audio-chunk",
    VOICE_INPUT_TRANSCRIPTION_DELTA: "voice-input:transcription-delta",
    VOICE_INPUT_TRANSCRIPTION_COMPLETE: "voice-input:transcription-complete",
    VOICE_INPUT_ERROR: "voice-input:error",
    VOICE_INPUT_STATUS: "voice-input:status",
    VOICE_INPUT_CHECK_MIC_PERMISSION: "voice-input:check-mic-permission",
    VOICE_INPUT_REQUEST_MIC_PERMISSION: "voice-input:request-mic-permission",
    VOICE_INPUT_OPEN_MIC_SETTINGS: "voice-input:open-mic-settings",
    VOICE_INPUT_VALIDATE_API_KEY: "voice-input:validate-api-key",
    VOICE_INPUT_CORRECT: "voice-input:correct",
    VOICE_INPUT_FLUSH_PARAGRAPH: "voice-input:flush-paragraph",
    VOICE_INPUT_PARAGRAPH_BOUNDARY: "voice-input:paragraph-boundary",
    VOICE_INPUT_FILE_TOKEN_RESOLVED: "voice-input:file-token-resolved",
  },
}));

import { registerVoiceInputHandlers } from "../voiceInput.js";

const fakeEvent = {
  sender: { once: vi.fn(), removeListener: vi.fn(), isDestroyed: () => false },
} as unknown as Electron.IpcMainInvokeEvent;

function getHandler(channel: string) {
  const call = ipcMainMock.handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`No handler registered for channel: ${channel}`);
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

const requestMicPermission = () =>
  getHandler("voice-input:request-mic-permission")(fakeEvent) as Promise<boolean>;
const openMicSettings = () =>
  getHandler("voice-input:open-mic-settings")(fakeEvent) as Promise<boolean>;
// Synchronous — it resolves through IPC, not a promise.
const checkMicPermission = () => getHandler("voice-input:check-mic-permission")(fakeEvent);

describe("voiceInput — microphone permission handlers", () => {
  const originalPlatform = process.platform;
  let cleanup: () => void;

  const setPlatform = (value: NodeJS.Platform) => {
    Object.defineProperty(process, "platform", { value, configurable: true });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup = registerVoiceInputHandlers({
      mainWindow: {
        webContents: { send: vi.fn() },
        isDestroyed: () => false,
      } as unknown as Electron.BrowserWindow,
    } as Parameters<typeof registerVoiceInputHandlers>[0]);
  });

  afterEach(() => {
    cleanup?.();
    setPlatform(originalPlatform);
  });

  describe("requestMicPermission", () => {
    it("lets Windows through to getUserMedia instead of reporting a denial", async () => {
      // The Windows dead-end: this used to resolve false, which the renderer read
      // as a hard denial and bailed on before ever reaching getUserMedia.
      setPlatform("win32");

      await expect(requestMicPermission()).resolves.toBe(true);
      expect(systemPreferencesMock.askForMediaAccess).not.toHaveBeenCalled();
    });

    it("lets Linux through to getUserMedia without a native request", async () => {
      setPlatform("linux");

      await expect(requestMicPermission()).resolves.toBe(true);
      expect(systemPreferencesMock.askForMediaAccess).not.toHaveBeenCalled();
    });

    it("relays the native macOS verdict in both directions", async () => {
      // macOS is the only platform that can answer authoritatively, so its
      // `false` must survive as a real denial rather than being normalized away.
      setPlatform("darwin");

      systemPreferencesMock.askForMediaAccess.mockResolvedValueOnce(true);
      await expect(requestMicPermission()).resolves.toBe(true);

      systemPreferencesMock.askForMediaAccess.mockResolvedValueOnce(false);
      await expect(requestMicPermission()).resolves.toBe(false);

      expect(systemPreferencesMock.askForMediaAccess).toHaveBeenCalledTimes(2);
    });
  });

  describe("checkMicPermission", () => {
    it("forwards the OS-reported status on Windows", () => {
      setPlatform("win32");
      systemPreferencesMock.getMediaAccessStatus.mockReturnValueOnce("denied");

      expect(checkMicPermission()).toBe("denied");
    });

    it("reports unknown on Linux, which has no status API", () => {
      setPlatform("linux");

      expect(checkMicPermission()).toBe("unknown");
      expect(systemPreferencesMock.getMediaAccessStatus).not.toHaveBeenCalled();
    });
  });

  describe("openMicSettings", () => {
    const originalDesktop = process.env.XDG_CURRENT_DESKTOP;

    afterEach(() => {
      if (originalDesktop === undefined) delete process.env.XDG_CURRENT_DESKTOP;
      else process.env.XDG_CURRENT_DESKTOP = originalDesktop;
    });

    it("on Linux opens the session desktop's sound settings and reports whether one opened", async () => {
      setPlatform("linux");
      process.env.XDG_CURRENT_DESKTOP = "XFCE";

      await expect(openMicSettings()).resolves.toBe(true);
      expect(linuxSoundSettingsMock.openLinuxSoundSettings).toHaveBeenCalledWith(
        "XFCE",
        expect.any(Function)
      );
      expect(logWarnMock).not.toHaveBeenCalled();
    });

    it("on Linux says so when no settings app could be started", async () => {
      setPlatform("linux");
      linuxSoundSettingsMock.openLinuxSoundSettings.mockImplementationOnce(
        async (_desktop, onFailure) => {
          onFailure?.({ command: "pavucontrol" }, new Error("spawn pavucontrol ENOENT"));
          return false;
        }
      );

      await expect(openMicSettings()).resolves.toBe(false);
      expect(logDebugMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ error: "spawn pavucontrol ENOENT", command: "pavucontrol" })
      );
      expect(logWarnMock).toHaveBeenCalledTimes(1);
    });

    it("uses a settings URL rather than a spawned app on macOS and Windows", async () => {
      setPlatform("darwin");
      await expect(openMicSettings()).resolves.toBe(true);
      setPlatform("win32");
      await expect(openMicSettings()).resolves.toBe(true);

      expect(linuxSoundSettingsMock.openLinuxSoundSettings).not.toHaveBeenCalled();
      expect(openExternalUrlMock).toHaveBeenCalledTimes(2);
    });

    it("reports a rejected settings-URL open instead of throwing", async () => {
      setPlatform("win32");
      openExternalUrlMock.mockRejectedValueOnce(new Error("no handler registered"));

      await expect(openMicSettings()).resolves.toBe(false);
      expect(logDebugMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ error: "no handler registered" })
      );
    });
  });
});
