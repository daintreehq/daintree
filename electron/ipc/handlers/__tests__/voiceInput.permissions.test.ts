import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

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

/** A stand-in ChildProcess whose "error" event we can fire on demand. */
class FakeChild extends EventEmitter {
  unref = vi.fn();
}

const childProcessMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("child_process", () => childProcessMock);

const openExternalUrlMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../../../utils/openExternal.js", () => ({ openExternalUrl: openExternalUrlMock }));

const logDebugMock = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/logger.js", () => ({
  logDebug: logDebugMock,
  logInfo: vi.fn(),
  logWarn: vi.fn(),
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
// These two handlers are synchronous — they resolve through IPC, not a promise.
const checkMicPermission = () => getHandler("voice-input:check-mic-permission")(fakeEvent);
const openMicSettings = () => getHandler("voice-input:open-mic-settings")(fakeEvent);

describe("voiceInput — microphone permission handlers", () => {
  const originalPlatform = process.platform;
  let cleanup: () => void;

  const setPlatform = (value: NodeJS.Platform) => {
    Object.defineProperty(process, "platform", { value, configurable: true });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    childProcessMock.spawn.mockImplementation(() => new FakeChild());
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
    it("contains a missing Linux settings binary instead of crashing the app", () => {
      // A missing binary arrives as an async "error" event, never a throw. With no
      // listener attached it becomes an uncaughtException and takes the app into
      // fatal recovery — so the listener must be on the child before we return.
      setPlatform("linux");
      const child = new FakeChild();
      childProcessMock.spawn.mockReturnValueOnce(child);

      openMicSettings();

      expect(child.listenerCount("error")).toBeGreaterThan(0);

      const enoent = Object.assign(new Error("spawn gnome-control-center ENOENT"), {
        code: "ENOENT",
      });
      expect(() => child.emit("error", enoent)).not.toThrow();
      expect(logDebugMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ error: enoent.message })
      );
    });

    it("survives a synchronous spawn failure on Linux", () => {
      setPlatform("linux");
      childProcessMock.spawn.mockImplementationOnce(() => {
        throw new Error("EACCES");
      });

      expect(() => openMicSettings()).not.toThrow();
      expect(logDebugMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ error: "EACCES" })
      );
    });

    it("uses a settings URL rather than a spawned binary on macOS and Windows", () => {
      setPlatform("darwin");
      openMicSettings();
      setPlatform("win32");
      openMicSettings();

      expect(childProcessMock.spawn).not.toHaveBeenCalled();
      expect(openExternalUrlMock).toHaveBeenCalledTimes(2);
    });

    it("contains a rejected settings-URL open", async () => {
      setPlatform("win32");
      openExternalUrlMock.mockRejectedValueOnce(new Error("no handler registered"));

      expect(() => openMicSettings()).not.toThrow();
      await vi.waitFor(() =>
        expect(logDebugMock).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ error: "no handler registered" })
        )
      );
    });
  });
});
